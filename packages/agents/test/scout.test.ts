import { randomUUID } from "node:crypto";
import { db, insights } from "@azen/db";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ScoutOutput } from "../src/agents/scout";
import { type AgentsHarness, cleanupHarness, createHarness } from "./helpers";

/**
 * Opportunity Scout tests (docs/phase6/CONTRACTS.md §P6-SCOUT). getAnthropic is
 * MOCKED — no live API calls; a real throwaway-org DB backs the insights +
 * agent_runs assertions and the pure-SQL unused-taxonomy detector. We hand-build
 * events + a scout_candidate FAQ cluster, then assert: automation_opportunity
 * insights are written with the right evidence (event_ids filtered to the pack,
 * estimated value/hours, same_day_ping on high confidence), the fingerprint
 * dedups a re-run in place, a missing API key writes nothing, and the unused-area
 * detector fires when a project has bookings but no payments.
 */

const hoisted = vi.hoisted(() => ({ parseMock: vi.fn() }));

vi.mock("../src/anthropic", () => ({
  getAnthropic: () => ({ messages: { parse: hoisted.parseMock } }),
}));

import {
  detectUnusedTaxonomyAreas,
  runOpportunityScout,
} from "../src/agents/scout";

function parseResult(
  parsed: unknown,
  inTok = 5000,
  outTok = 900,
): { parsed_output: unknown; usage: { input_tokens: number; output_tokens: number } } {
  return { parsed_output: parsed, usage: { input_tokens: inTok, output_tokens: outTok } };
}

/** Insert an event at NOON UTC of a London day, return its id. */
async function insertEvent(
  orgId: string,
  projectId: string,
  type: string,
  data: Record<string, unknown>,
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

/** Seed a faq_cluster insight already flagged scout_candidate (a Scout lead). */
async function insertScoutCandidate(
  orgId: string,
  projectId: string,
  exampleIds: string[],
): Promise<void> {
  await db.insert(insights).values({
    orgId,
    projectId,
    kind: "faq_cluster",
    title: "Pricing",
    bodyMd: "Repeated pricing questions the bot escalates.",
    evidence: {
      event_ids: exampleIds,
      count: 6,
      share_pct: 40,
      scout_candidate: true,
    },
    confidence: "high",
    status: "new",
    createdBy: "agent",
  });
}

interface OppRow {
  id: string;
  title: string;
  body_md: string;
  evidence: Record<string, unknown>;
  fingerprint: string | null;
  confidence: string;
  status: string;
  kind: string;
  estimated_value_pence: number | null;
  estimated_hours_saved_monthly: number | null;
}

async function loadOpportunities(orgId: string): Promise<OppRow[]> {
  return (await db.$client`
    select id::text as id, title, body_md, evidence, fingerprint,
      confidence::text as confidence, status::text as status, kind::text as kind,
      estimated_value_pence, estimated_hours_saved_monthly
    from insights
    where org_id = ${orgId}::uuid and kind = 'automation_opportunity'
    order by title
  `) as unknown as OppRow[];
}

let harness: AgentsHarness;
let escalationIds: string[] = [];

beforeAll(async () => {
  harness = await createHarness("Scout Test");
  // Bookings (no payments) → the unused-taxonomy detector should flag payments.
  for (let i = 0; i < 4; i++) {
    await insertEvent(harness.orgId, harness.projectId, "booking.created", {
      service: "Checkup",
      starts_at: new Date().toISOString(),
    });
  }
  // A couple of pricing escalations the model can cite.
  for (let i = 0; i < 3; i++) {
    escalationIds.push(
      await insertEvent(harness.orgId, harness.projectId, "agent.escalated_to_human", {
        reason: "pricing question",
      }),
    );
  }
  await insertScoutCandidate(harness.orgId, harness.projectId, escalationIds);
});

afterEach(async () => {
  hoisted.parseMock.mockReset();
  await db.$client`delete from insights where org_id = ${harness.orgId}::uuid and kind = 'automation_opportunity'`;
  await db.$client`delete from agent_runs where org_id = ${harness.orgId}::uuid`;
});

afterAll(async () => {
  await cleanupHarness(harness);
});

function sampleOutput(): ScoutOutput {
  return {
    opportunities: [
      {
        title: "Automate deposit collection at booking",
        detected_md:
          "4 bookings this month but no payment events — deposits are collected by hand. Ship an automated deposit request at booking.",
        evidence_event_ids: [], // taxonomy absence → no ids
        estimated_hours_saved_monthly: 6,
        estimated_value_pence: 120_000,
        confidence: "high",
        suggested_price_band_pence: [50_000, 150_000],
        fingerprint: "deposit-collection",
      },
      {
        title: "Deflect pricing questions",
        detected_md:
          "3 pricing escalations plus a pricing FAQ cluster — automate quotes to deflect the repeat handoff.",
        evidence_event_ids: [escalationIds[0]!, escalationIds[1]!],
        estimated_hours_saved_monthly: 3,
        estimated_value_pence: 40_000,
        confidence: "med",
        suggested_price_band_pence: [20_000, 60_000],
        fingerprint: "pricing-deflection",
      },
    ],
  };
}

describe("runOpportunityScout — opportunity insight writes", () => {
  it("writes one automation_opportunity per opportunity with correct evidence + ping flag", async () => {
    hoisted.parseMock.mockResolvedValueOnce(parseResult(sampleOutput()));

    const res = await runOpportunityScout(db, {
      orgId: harness.orgId,
      projectId: harness.projectId,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error);
    expect(hoisted.parseMock).toHaveBeenCalledTimes(1);
    expect(res.opportunitiesWritten).toBe(2);
    expect(res.sameDayPings).toBe(1);
    expect(res.tokensIn).toBe(5000);
    expect(res.tokensOut).toBe(900);

    const rows = await loadOpportunities(harness.orgId);
    expect(rows.length).toBe(2);

    const deposit = rows.find((r) => r.title.startsWith("Automate deposit"))!;
    expect(deposit.kind).toBe("automation_opportunity");
    expect(deposit.status).toBe("new");
    expect(deposit.confidence).toBe("high");
    expect(Number(deposit.estimated_value_pence)).toBe(120_000);
    expect(Number(deposit.estimated_hours_saved_monthly)).toBe(6);
    // high confidence → same_day_ping flag
    expect(deposit.evidence["same_day_ping"]).toBe(true);
    expect(deposit.evidence["event_ids"]).toEqual([]);
    expect(deposit.fingerprint).toBe(`scout:${harness.projectId}:deposit-collection`);

    const pricing = rows.find((r) => r.title === "Deflect pricing questions")!;
    // med confidence → no ping
    expect(pricing.evidence["same_day_ping"]).toBeUndefined();
    expect((pricing.evidence["event_ids"] as string[]).length).toBe(2);
    const agg = pricing.evidence["aggregates"] as Record<string, unknown>;
    expect(agg["suggested_price_band_pence"]).toEqual([20_000, 60_000]);
  });

  it("filters hallucinated evidence ids not present in the pack", async () => {
    const out = sampleOutput();
    out.opportunities[1]!.evidence_event_ids = [randomUUID(), escalationIds[0]!];
    hoisted.parseMock.mockResolvedValueOnce(parseResult(out));

    await runOpportunityScout(db, { orgId: harness.orgId, projectId: harness.projectId });
    const rows = await loadOpportunities(harness.orgId);
    const pricing = rows.find((r) => r.title === "Deflect pricing questions")!;
    expect(pricing.evidence["event_ids"]).toEqual([escalationIds[0]]);
  });

  it("is idempotent: a re-run updates the same fingerprinted rows, no duplicates", async () => {
    hoisted.parseMock.mockResolvedValueOnce(parseResult(sampleOutput()));
    await runOpportunityScout(db, { orgId: harness.orgId, projectId: harness.projectId });

    const first = await loadOpportunities(harness.orgId);
    expect(first.length).toBe(2);
    const depositIdBefore = first.find((r) => r.title.startsWith("Automate deposit"))!.id;

    const updated = sampleOutput();
    updated.opportunities[0]!.detected_md = "Updated: deposit collection is still manual.";
    hoisted.parseMock.mockResolvedValueOnce(parseResult(updated));
    const res2 = await runOpportunityScout(db, {
      orgId: harness.orgId,
      projectId: harness.projectId,
    });
    expect(res2.ok).toBe(true);

    const second = await loadOpportunities(harness.orgId);
    expect(second.length).toBe(2);
    const depositAfter = second.find((r) => r.title.startsWith("Automate deposit"))!;
    expect(depositAfter.id).toBe(depositIdBefore); // same row
    expect(depositAfter.body_md).toContain("Updated:");
  });

  it("retires an orphaned 'new' opportunity when a fingerprint leaves the run", async () => {
    hoisted.parseMock.mockResolvedValueOnce(parseResult(sampleOutput()));
    await runOpportunityScout(db, { orgId: harness.orgId, projectId: harness.projectId });
    expect((await loadOpportunities(harness.orgId)).length).toBe(2);

    // Second run drops the pricing opportunity entirely.
    const dropped = sampleOutput();
    dropped.opportunities = [dropped.opportunities[0]!];
    hoisted.parseMock.mockResolvedValueOnce(parseResult(dropped));
    await runOpportunityScout(db, { orgId: harness.orgId, projectId: harness.projectId });

    const rows = await loadOpportunities(harness.orgId);
    expect(rows.map((r) => r.title)).toEqual(["Automate deposit collection at booking"]);
  });

  it("writes nothing and returns a typed error when the model call fails", async () => {
    hoisted.parseMock.mockRejectedValueOnce(new Error("ANTHROPIC_API_KEY missing"));

    const res = await runOpportunityScout(db, {
      orgId: harness.orgId,
      projectId: harness.projectId,
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected failure");
    expect(res.error).toBe("anthropic_auth");
    expect((await loadOpportunities(harness.orgId)).length).toBe(0);
  });

  it("short-circuits (no model call) for a project with no signals", async () => {
    const empty = await createHarness("Scout Empty Test");
    try {
      const res = await runOpportunityScout(db, {
        orgId: empty.orgId,
        projectId: empty.projectId,
      });
      expect(res.ok).toBe(true);
      if (!res.ok) throw new Error(res.error);
      expect(res.runId).toBeNull();
      expect(res.opportunitiesWritten).toBe(0);
      expect(hoisted.parseMock).not.toHaveBeenCalled();
    } finally {
      await db.$client`delete from insights where org_id = ${empty.orgId}::uuid`;
      await cleanupHarness(empty);
    }
  });
});

describe("detectUnusedTaxonomyAreas — pure-SQL absence detector", () => {
  const from = new Date(Date.now() - 40 * 86400_000).toISOString();
  const to = new Date(Date.now() + 86400_000).toISOString();

  it("flags payment collection when a project has bookings but no payments", async () => {
    const areas = await detectUnusedTaxonomyAreas(
      db,
      harness.orgId,
      harness.projectId,
      from,
      to,
    );
    const titles = areas.map((a) => a.title);
    expect(titles).toContain("Payment collection not automated");
    const payment = areas.find((a) => a.title === "Payment collection not automated")!;
    expect(payment.present).toContain("booking.*");
    expect(payment.missing).toContain("payment.*");
  });

  it("does NOT flag payment collection once a payment event exists", async () => {
    const paid = await createHarness("Scout Paid Test");
    try {
      await insertEvent(paid.orgId, paid.projectId, "booking.created", {
        starts_at: new Date().toISOString(),
      });
      await insertEvent(paid.orgId, paid.projectId, "payment.captured", {
        amount_pence: 5000,
      });
      const areas = await detectUnusedTaxonomyAreas(
        db,
        paid.orgId,
        paid.projectId,
        from,
        to,
      );
      expect(areas.map((a) => a.title)).not.toContain("Payment collection not automated");
    } finally {
      await cleanupHarness(paid);
    }
  });

  it("returns no areas for a project with no events at all", async () => {
    const empty = await createHarness("Scout NoEvents Test");
    try {
      const areas = await detectUnusedTaxonomyAreas(
        db,
        empty.orgId,
        empty.projectId,
        from,
        to,
      );
      expect(areas).toEqual([]);
    } finally {
      await cleanupHarness(empty);
    }
  });
});
