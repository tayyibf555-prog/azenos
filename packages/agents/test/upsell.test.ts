import { randomUUID } from "node:crypto";
import { db, insights } from "@azen/db";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { UpsellOutput } from "../src/agents/upsell";
import { type AgentsHarness, cleanupHarness, createHarness } from "./helpers";

/**
 * Upsell Engine tests (docs/phase6/CONTRACTS.md §P6-GROWTH). getAnthropic is
 * MOCKED — no live API calls; a real throwaway-org DB backs the upsell_proposals
 * + agent_runs assertions. We hand-build events + reviewed/high-confidence
 * automation_opportunity insights, then assert: a single client-ready proposal
 * row is written tracing to the source insights' evidence (event ids filtered to
 * the pack, source insight_ids recorded, price clamped), the source insights are
 * marked converted_to_upsell, a missing API key writes nothing, and an ineligible
 * client (no reviewed/high-confidence opportunities) short-circuits with no call.
 */

const hoisted = vi.hoisted(() => ({ parseMock: vi.fn() }));

vi.mock("../src/anthropic", () => ({
  getAnthropic: () => ({ messages: { parse: hoisted.parseMock } }),
}));

import { runUpsellEngine } from "../src/agents/upsell";

function parseResult(
  parsed: unknown,
  inTok = 4200,
  outTok = 800,
): { parsed_output: unknown; usage: { input_tokens: number; output_tokens: number } } {
  return { parsed_output: parsed, usage: { input_tokens: inTok, output_tokens: outTok } };
}

/** Insert an event at NOON UTC of a recent London day, return its id. */
async function insertEvent(
  orgId: string,
  projectId: string,
  type: string,
  data: Record<string, unknown> = {},
  daysAgo = 2,
): Promise<string> {
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
      ${JSON.stringify(data)}::jsonb, 'gbp', '{}'::jsonb
    )
  `;
  return id;
}

/** Seed an automation_opportunity insight the Upsell Engine can convert. */
async function insertOpportunity(
  orgId: string,
  projectId: string,
  opts: {
    title: string;
    eventIds: string[];
    confidence?: "low" | "med" | "high";
    status?: "new" | "reviewed";
    valuePence?: number;
    hours?: number;
    band?: [number, number];
  },
): Promise<string> {
  const id = randomUUID();
  await db.insert(insights).values({
    id,
    orgId,
    projectId,
    kind: "automation_opportunity",
    title: opts.title,
    bodyMd: `${opts.title} — detected in the client's data.`,
    evidence: {
      event_ids: opts.eventIds,
      aggregates: {
        estimated_hours_saved_monthly: opts.hours ?? 6,
        estimated_value_pence: opts.valuePence ?? 120_000,
        suggested_price_band_pence: opts.band ?? [50_000, 150_000],
      },
    },
    fingerprint: `scout:${projectId}:${id.slice(0, 8)}`,
    estimatedValuePence: opts.valuePence ?? 120_000,
    estimatedHoursSavedMonthly: opts.hours ?? 6,
    confidence: opts.confidence ?? "high",
    status: opts.status ?? "reviewed",
    createdBy: "agent",
  });
  return id;
}

interface ProposalRow {
  id: string;
  client_id: string;
  project_id: string | null;
  title: string;
  problem_md: string;
  proposal_md: string;
  evidence: Record<string, unknown>;
  suggested_price_pence: number | null;
  status: string;
  insight_ids: string[];
}

async function loadProposals(orgId: string): Promise<ProposalRow[]> {
  return (await db.$client`
    select id::text as id, client_id::text as client_id, project_id::text as project_id,
      title, problem_md, proposal_md, evidence, suggested_price_pence,
      status::text as status, insight_ids::text[] as insight_ids
    from upsell_proposals
    where org_id = ${orgId}::uuid
    order by created_at
  `) as unknown as ProposalRow[];
}

async function loadInsightStatus(id: string): Promise<string> {
  const rows = (await db.$client`
    select status::text as status from insights where id = ${id}::uuid
  `) as unknown as { status: string }[];
  return rows[0]!.status;
}

let harness: AgentsHarness;
let evidenceIds: string[] = [];

beforeAll(async () => {
  harness = await createHarness("Upsell Test");
  evidenceIds = [
    await insertEvent(harness.orgId, harness.projectId, "agent.escalated_to_human", {
      reason: "pricing question",
    }),
    await insertEvent(harness.orgId, harness.projectId, "agent.escalated_to_human", {
      reason: "pricing question",
    }),
  ];
});

afterEach(async () => {
  hoisted.parseMock.mockReset();
  await db.$client`delete from upsell_proposals where org_id = ${harness.orgId}::uuid`;
  await db.$client`delete from insights where org_id = ${harness.orgId}::uuid`;
  await db.$client`delete from agent_runs where org_id = ${harness.orgId}::uuid`;
});

afterAll(async () => {
  // proposals reference clients — clear them before the harness teardown.
  await db.$client`delete from upsell_proposals where org_id = ${harness.orgId}::uuid`;
  await cleanupHarness(harness);
});

function sampleOutput(): UpsellOutput {
  return {
    title: "Automate Pricing Answers & Deposit Collection",
    problem_md:
      "Your bot escalated 2 pricing questions to a human in the last month and deposits are still taken by hand.",
    proposal_md:
      "We'll ship an automated pricing responder plus a deposit request at booking. Expected to save ~6 hours a month and capture deposits automatically.",
    evidence_event_ids: [evidenceIds[0]!, evidenceIds[1]!],
    suggested_price_pence: 90_000,
    expected_roi_note: "Saves ~6 hours a month and captures deposits — pays back in week one.",
  };
}

describe("runUpsellEngine — proposal writes tracing to evidence", () => {
  it("writes one client-ready draft proposal from a single insight, tracing to evidence", async () => {
    const insightId = await insertOpportunity(harness.orgId, harness.projectId, {
      title: "Deflect pricing questions",
      eventIds: evidenceIds,
      confidence: "high",
      status: "reviewed",
    });
    hoisted.parseMock.mockResolvedValueOnce(parseResult(sampleOutput()));

    const res = await runUpsellEngine(db, {
      orgId: harness.orgId,
      insightId,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error);
    expect(hoisted.parseMock).toHaveBeenCalledTimes(1);
    expect(res.proposalId).not.toBeNull();
    expect(res.insightIds).toEqual([insightId]);
    expect(res.clientId).toBe(harness.clientId);
    expect(res.tokensIn).toBe(4200);
    expect(res.tokensOut).toBe(800);

    const rows = await loadProposals(harness.orgId);
    expect(rows.length).toBe(1);
    const p = rows[0]!;
    expect(p.status).toBe("draft");
    expect(p.client_id).toBe(harness.clientId);
    expect(p.project_id).toBe(harness.projectId);
    expect(p.title).toBe("Automate Pricing Answers & Deposit Collection");
    expect(Number(p.suggested_price_pence)).toBe(90_000);
    // insight_ids column records the source insight
    expect(p.insight_ids).toEqual([insightId]);
    // evidence traces to the cited events + the source insight + roi note
    expect(p.evidence["event_ids"]).toEqual(evidenceIds);
    expect(p.evidence["insight_ids"]).toEqual([insightId]);
    expect(p.evidence["expected_roi_note"]).toContain("week one");

    // the source insight is retired from the pipeline
    expect(await loadInsightStatus(insightId)).toBe("converted_to_upsell");
  });

  it("filters hallucinated evidence ids not present in the source insights", async () => {
    const insightId = await insertOpportunity(harness.orgId, harness.projectId, {
      title: "Deflect pricing questions",
      eventIds: [evidenceIds[0]!],
      confidence: "high",
    });
    const out = sampleOutput();
    out.evidence_event_ids = [randomUUID(), evidenceIds[0]!]; // one fabricated id
    hoisted.parseMock.mockResolvedValueOnce(parseResult(out));

    await runUpsellEngine(db, { orgId: harness.orgId, insightId });
    const p = (await loadProposals(harness.orgId))[0]!;
    expect(p.evidence["event_ids"]).toEqual([evidenceIds[0]]);
  });

  it("folds every eligible opportunity across a client into one proposal", async () => {
    const a = await insertOpportunity(harness.orgId, harness.projectId, {
      title: "Deflect pricing questions",
      eventIds: [evidenceIds[0]!],
      confidence: "high",
      status: "reviewed",
      valuePence: 120_000,
    });
    // eligible via high confidence even though still 'new'
    const b = await insertOpportunity(harness.orgId, harness.projectId, {
      title: "Automate deposit collection",
      eventIds: [],
      confidence: "high",
      status: "new",
      valuePence: 80_000,
    });
    // NOT eligible: low confidence + still 'new'
    await insertOpportunity(harness.orgId, harness.projectId, {
      title: "Thin idea",
      eventIds: [],
      confidence: "low",
      status: "new",
    });

    hoisted.parseMock.mockResolvedValueOnce(parseResult(sampleOutput()));
    const res = await runUpsellEngine(db, {
      orgId: harness.orgId,
      clientId: harness.clientId,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error);
    // both eligible insights folded in; the thin/low one excluded
    expect(res.insightIds.sort()).toEqual([a, b].sort());

    const p = (await loadProposals(harness.orgId))[0]!;
    expect((p.insight_ids as string[]).sort()).toEqual([a, b].sort());
    // aggregate value = sum of the two folded opportunities
    const agg = p.evidence["aggregates"] as Record<string, unknown>;
    expect(Number(agg["estimated_value_pence"])).toBe(200_000);
  });

  it("writes nothing and returns a typed error when the model call fails", async () => {
    const insightId = await insertOpportunity(harness.orgId, harness.projectId, {
      title: "Deflect pricing questions",
      eventIds: evidenceIds,
      confidence: "high",
    });
    hoisted.parseMock.mockRejectedValueOnce(new Error("ANTHROPIC_API_KEY missing"));

    const res = await runUpsellEngine(db, { orgId: harness.orgId, insightId });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected failure");
    expect(res.error).toBe("anthropic_auth");
    expect((await loadProposals(harness.orgId)).length).toBe(0);
    // the insight stays in the pipeline (not converted) when nothing was written
    expect(await loadInsightStatus(insightId)).toBe("reviewed");
  });

  it("short-circuits (no model call) for a client with no eligible opportunities", async () => {
    // only a 'new' low-confidence opportunity exists → not eligible
    await insertOpportunity(harness.orgId, harness.projectId, {
      title: "Thin idea",
      eventIds: [],
      confidence: "low",
      status: "new",
    });
    const res = await runUpsellEngine(db, {
      orgId: harness.orgId,
      clientId: harness.clientId,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error);
    expect(res.proposalId).toBeNull();
    expect(res.insightIds).toEqual([]);
    expect(hoisted.parseMock).not.toHaveBeenCalled();
  });
});
