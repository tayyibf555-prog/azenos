import { randomUUID } from "node:crypto";
import { db, insights } from "@azen/db";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { LearnOutput } from "../src/agents/learn";
import { type AgentsHarness, cleanupHarness, createHarness } from "./helpers";

/**
 * Industry Learning tests (docs/phase6/CONTRACTS.md §P6-LEARN). getAnthropic is
 * MOCKED (no live model call) and global fetch (Voyage) is stubbed — a real
 * throwaway-org DB backs the knowledge_articles + agent_runs assertions. We build
 * an industry, link the harness client to it, and seed booking events + a
 * faq_cluster insight so the pack has signal, then assert: articles are written
 * with an embedding when VOYAGE_API_KEY is present and a NULL embedding when it is
 * absent, a re-run dedups onto the same row, a missing ANTHROPIC_API_KEY writes
 * nothing, and a signal-free industry short-circuits with no model call.
 */

const hoisted = vi.hoisted(() => ({ parseMock: vi.fn() }));

vi.mock("../src/anthropic", () => ({
  getAnthropic: () => ({ messages: { parse: hoisted.parseMock } }),
}));

import { runIndustryLearning } from "../src/agents/learn";

function parseResult(
  parsed: unknown,
  inTok = 5200,
  outTok = 900,
): { parsed_output: unknown; usage: { input_tokens: number; output_tokens: number } } {
  return { parsed_output: parsed, usage: { input_tokens: inTok, output_tokens: outTok } };
}

/** A Voyage embeddings response for `n` inputs, each a valid 1024-dim vector. */
function voyageResponse(n: number): Response {
  const dim = 1024;
  const data = Array.from({ length: n }, (_v, index) => ({
    embedding: Array.from({ length: dim }, () => 0.01),
    index,
  }));
  return {
    ok: true,
    status: 200,
    json: async () => ({ data }),
  } as unknown as Response;
}

/** Insert an event at NOON UTC of a recent London day. */
async function insertEvent(
  orgId: string,
  projectId: string,
  type: string,
  daysAgo = 3,
): Promise<void> {
  const id = randomUUID();
  const rows = (await db.$client`
    select to_char(
      ((date_trunc('day', now() at time zone 'Europe/London') - make_interval(days => ${daysAgo}))
        at time zone 'Europe/London') at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS"Z"'
    ) as iso
  `) as unknown as { iso: string }[];
  const at = new Date(new Date(rows[0]!.iso).getTime() + 12 * 3600 * 1000);
  await db.$client`
    insert into events (id, org_id, project_id, type, source, idempotency_key, occurred_at, received_at, data, currency, raw)
    values (
      ${id}::uuid, ${orgId}::uuid, ${projectId}::uuid, ${type}, 'sdk',
      ${`test:${id}`}, ${at.toISOString()}::timestamptz, ${at.toISOString()}::timestamptz,
      '{}'::jsonb, 'gbp', '{}'::jsonb
    )
  `;
}

async function insertFaqCluster(
  orgId: string,
  projectId: string,
  title: string,
): Promise<void> {
  await db.insert(insights).values({
    orgId,
    projectId,
    kind: "faq_cluster",
    title,
    bodyMd: `${title} — recurring question.`,
    evidence: {},
    confidence: "med",
    status: "new",
    createdBy: "agent",
  });
}

interface ArticleRow {
  id: string;
  kind: string;
  title: string;
  body_md: string;
  has_embedding: boolean;
  sources: Record<string, unknown>;
}

async function loadArticles(orgId: string): Promise<ArticleRow[]> {
  return (await db.$client`
    select id::text as id, kind::text as kind, title, body_md,
      (embedding is not null) as has_embedding, sources
    from knowledge_articles
    where org_id = ${orgId}::uuid
    order by created_at, title
  `) as unknown as ArticleRow[];
}

let harness: AgentsHarness;
let industryId: string;

beforeAll(async () => {
  harness = await createHarness("Learn Test");
  industryId = randomUUID();
  await db.$client`
    insert into industries (id, org_id, slug, name)
    values (${industryId}::uuid, ${harness.orgId}::uuid, ${`learn-test-${industryId.slice(0, 8)}`}, 'Test Industry')
  `;
  await db.$client`
    update clients set industry_id = ${industryId}::uuid where id = ${harness.clientId}::uuid
  `;
  // Signal: booking events (curve + funnel) + a faq_cluster (topic).
  await insertEvent(harness.orgId, harness.projectId, "booking.created", 3);
  await insertEvent(harness.orgId, harness.projectId, "booking.created", 4);
  await insertFaqCluster(harness.orgId, harness.projectId, "How much are veneers?");
});

afterEach(async () => {
  hoisted.parseMock.mockReset();
  vi.unstubAllGlobals();
  delete process.env.VOYAGE_API_KEY;
  await db.$client`delete from knowledge_articles where org_id = ${harness.orgId}::uuid`;
  await db.$client`delete from agent_runs where org_id = ${harness.orgId}::uuid`;
});

afterAll(async () => {
  await db.$client`delete from knowledge_articles where org_id = ${harness.orgId}::uuid`;
  await db.$client`update clients set industry_id = null where org_id = ${harness.orgId}::uuid`;
  await db.$client`delete from industries where org_id = ${harness.orgId}::uuid`;
  await cleanupHarness(harness);
});

function sampleOutput(): LearnOutput {
  return {
    articles: [
      {
        kind: "industry_primer",
        title: "How This Industry Books",
        body_md:
          "Bookings cluster mid-week. Customers ask about pricing before booking.\n\n- Peak: Tue/Wed\n- Top FAQ: veneers pricing",
        sources: ["booking curve peaks mid-week", "veneers pricing recurs"],
      },
      {
        kind: "playbook",
        title: "Deflect Pricing Questions Early",
        body_md: "Answer pricing up front to lift the booking rate.",
        sources: ["pricing FAQ across clients"],
      },
    ],
  };
}

describe("runIndustryLearning — writes embedded knowledge articles", () => {
  it("writes articles WITH embeddings when VOYAGE_API_KEY is present", async () => {
    process.env.VOYAGE_API_KEY = "test-voyage-key";
    const fetchMock = vi.fn(async () => voyageResponse(2));
    vi.stubGlobal("fetch", fetchMock);
    hoisted.parseMock.mockResolvedValueOnce(parseResult(sampleOutput()));

    const res = await runIndustryLearning(db, {
      orgId: harness.orgId,
      industryId,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error);
    expect(hoisted.parseMock).toHaveBeenCalledTimes(1);
    expect(res.articlesWritten).toBe(2);
    expect(res.articlesEmbedded).toBe(2);
    expect(res.tokensIn).toBe(5200);
    expect(res.tokensOut).toBe(900);
    // Voyage was called once (batched) with the document input type.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const rows = await loadArticles(harness.orgId);
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.has_embedding)).toBe(true);
    const kinds = rows.map((r) => r.kind).sort();
    expect(kinds).toEqual(["industry_primer", "playbook"]);
    // fingerprint stored for dedup
    expect(rows[0]!.sources["fingerprint"]).toContain("learn:");
  });

  it("writes articles with NULL embedding when VOYAGE_API_KEY is absent", async () => {
    // no VOYAGE_API_KEY set → embedTexts returns null, no fetch
    const fetchMock = vi.fn(async () => voyageResponse(2));
    vi.stubGlobal("fetch", fetchMock);
    hoisted.parseMock.mockResolvedValueOnce(parseResult(sampleOutput()));

    const res = await runIndustryLearning(db, {
      orgId: harness.orgId,
      industryId,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error);
    expect(res.articlesWritten).toBe(2);
    expect(res.articlesEmbedded).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();

    const rows = await loadArticles(harness.orgId);
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.has_embedding)).toBe(false);
  });

  it("dedups on a re-run — the same fingerprint updates in place", async () => {
    hoisted.parseMock.mockResolvedValue(parseResult(sampleOutput()));

    await runIndustryLearning(db, { orgId: harness.orgId, industryId });
    await runIndustryLearning(db, { orgId: harness.orgId, industryId });

    const rows = await loadArticles(harness.orgId);
    // two runs, same two fingerprints → still exactly two rows
    expect(rows.length).toBe(2);
  });

  it("writes nothing and returns a typed error when the model call fails", async () => {
    hoisted.parseMock.mockRejectedValueOnce(new Error("ANTHROPIC_API_KEY missing"));

    const res = await runIndustryLearning(db, {
      orgId: harness.orgId,
      industryId,
    });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected failure");
    expect(res.error).toBe("anthropic_auth");
    expect((await loadArticles(harness.orgId)).length).toBe(0);
  });

  it("short-circuits (no model call) for an industry with no signal", async () => {
    const emptyIndustry = randomUUID();
    await db.$client`
      insert into industries (id, org_id, slug, name)
      values (${emptyIndustry}::uuid, ${harness.orgId}::uuid, ${`empty-${emptyIndustry.slice(0, 8)}`}, 'Empty Industry')
    `;

    const res = await runIndustryLearning(db, {
      orgId: harness.orgId,
      industryId: emptyIndustry,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error);
    expect(res.runId).toBeNull();
    expect(res.articlesWritten).toBe(0);
    expect(hoisted.parseMock).not.toHaveBeenCalled();

    await db.$client`delete from industries where id = ${emptyIndustry}::uuid`;
  });
});
