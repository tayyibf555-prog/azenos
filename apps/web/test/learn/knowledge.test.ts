import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeDb, db } from "@azen/db";

/**
 * P6-LEARN retrieval tests. embedOne (@azen/agents Voyage helper) is MOCKED so
 * the tests are deterministic and never hit Voyage; a real throwaway-org DB backs
 * the knowledge_articles rows. We assert: searchKnowledge degrades to [] when the
 * query can't be embedded (no VOYAGE_API_KEY → embedOne null), returns the closest
 * article by pgvector cosine when it can, and the swapped Ask Azen search_knowledge
 * tool returns real results when articles exist (and the "no entries yet" note when
 * retrieval yields nothing).
 */

const DIM = 1024;
const hoisted = vi.hoisted(() => ({ embedMock: vi.fn() }));

vi.mock("@azen/agents", () => ({
  embedOne: hoisted.embedMock,
}));

import { searchKnowledge } from "../../lib/server/knowledge";
import { searchKnowledge as searchKnowledgeTool } from "../../lib/server/ask/tools/knowledge";

const orgId = randomUUID();
const otherOrgId = randomUUID();
const industryId = randomUUID();
const otherIndustryId = randomUUID();

function vec(fill: number): number[] {
  return Array.from({ length: DIM }, () => fill);
}
function vecLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}

async function insertOrg(id: string, name: string): Promise<void> {
  await db.$client`insert into organizations (id, name) values (${id}::uuid, ${name})`;
}
async function insertIndustry(
  id: string,
  org: string,
  slug: string,
  name: string,
): Promise<void> {
  await db.$client`
    insert into industries (id, org_id, slug, name)
    values (${id}::uuid, ${org}::uuid, ${slug}, ${name})
  `;
}
async function insertArticle(
  org: string,
  industry: string,
  title: string,
  embedding: number[] | null,
): Promise<void> {
  if (embedding) {
    await db.$client`
      insert into knowledge_articles (org_id, industry_id, title, body_md, sources, kind, embedding)
      values (${org}::uuid, ${industry}::uuid, ${title}, ${`${title} body.`}, '{}'::jsonb, 'industry_primer', ${vecLiteral(embedding)}::vector)
    `;
  } else {
    await db.$client`
      insert into knowledge_articles (org_id, industry_id, title, body_md, sources, kind, embedding)
      values (${org}::uuid, ${industry}::uuid, ${title}, ${`${title} body.`}, '{}'::jsonb, 'industry_primer', null)
    `;
  }
}

beforeAll(async () => {
  await insertOrg(orgId, "Learn KB Test A");
  await insertOrg(otherOrgId, "Learn KB Test B");
  await insertIndustry(industryId, orgId, `kb-a-${industryId.slice(0, 8)}`, "Dental");
  await insertIndustry(
    otherIndustryId,
    otherOrgId,
    `kb-b-${otherIndustryId.slice(0, 8)}`,
    "Trades",
  );
  // Two embedded articles in org A (one closer to the query than the other) and
  // one UN-embedded article (must be excluded from vector search).
  await insertArticle(orgId, industryId, "When Bookings Peak", vec(0.1));
  await insertArticle(orgId, industryId, "Distant Topic", vec(0.9));
  await insertArticle(orgId, industryId, "No Embedding Yet", null);
  // An article in the OTHER org — isolation check (must never surface for orgId).
  await insertArticle(otherOrgId, otherIndustryId, "Other Org Article", vec(0.1));
});

afterAll(async () => {
  await db.$client`delete from knowledge_articles where org_id in (${orgId}::uuid, ${otherOrgId}::uuid)`;
  await db.$client`delete from industries where org_id in (${orgId}::uuid, ${otherOrgId}::uuid)`;
  await db.$client`delete from organizations where id in (${orgId}::uuid, ${otherOrgId}::uuid)`;
  await closeDb();
});

describe("searchKnowledge — graceful pgvector retrieval", () => {
  it("returns [] when the query cannot be embedded (no VOYAGE_API_KEY)", async () => {
    hoisted.embedMock.mockReset();
    hoisted.embedMock.mockResolvedValueOnce(null);
    const hits = await searchKnowledge(orgId, "when do bookings peak?", 5);
    expect(hits).toEqual([]);
  });

  it("returns [] for an empty query without embedding", async () => {
    hoisted.embedMock.mockReset();
    const hits = await searchKnowledge(orgId, "   ", 5);
    expect(hits).toEqual([]);
    expect(hoisted.embedMock).not.toHaveBeenCalled();
  });

  it("returns the closest embedded article, org-scoped, excluding unembedded rows", async () => {
    hoisted.embedMock.mockReset();
    hoisted.embedMock.mockResolvedValueOnce(vec(0.1)); // identical to "When Bookings Peak"
    const hits = await searchKnowledge(orgId, "booking peak times", 5);

    expect(hits.length).toBe(2); // the two embedded articles; the null one excluded
    expect(hits[0]!.title).toBe("When Bookings Peak"); // closest first
    expect(hits.map((h) => h.title)).not.toContain("No Embedding Yet");
    expect(hits.map((h) => h.title)).not.toContain("Other Org Article"); // isolation
    expect(hits[0]!.industryName).toBe("Dental");
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
  });
});

describe("search_knowledge Ask tool — real retrieval swap", () => {
  it("returns real results when embedded articles exist", async () => {
    hoisted.embedMock.mockReset();
    hoisted.embedMock.mockResolvedValueOnce(vec(0.1));
    const out = await searchKnowledgeTool.run(orgId, { text: "booking peak times" });
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error(out.error);
    const data = out.data as { results: unknown[]; count?: number };
    expect(data.results.length).toBe(2);
    expect((data.results[0] as { title: string }).title).toBe("When Bookings Peak");
  });

  it("returns the 'no entries yet' note when retrieval yields nothing", async () => {
    hoisted.embedMock.mockReset();
    hoisted.embedMock.mockResolvedValueOnce(null); // no key → no retrieval
    const out = await searchKnowledgeTool.run(orgId, { text: "anything" });
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error(out.error);
    const data = out.data as { results: unknown[]; note?: string };
    expect(data.results).toEqual([]);
    expect(data.note).toBe("no knowledge base entries yet");
  });
});
