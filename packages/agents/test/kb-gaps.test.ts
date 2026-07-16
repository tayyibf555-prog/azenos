import { randomUUID } from "node:crypto";
import { db } from "@azen/db";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { KbGapOutput } from "../src/agents/kb-gaps";
import { type AgentsHarness, cleanupHarness, createHarness } from "./helpers";

/**
 * runKbGapMiner tests (docs/phase9/CONTRACTS.md §P9-KB). getAnthropic is MOCKED —
 * no live API calls; a real throwaway-org DB backs the insights + agent_runs
 * assertions. We hand-build llm.conversation events at known London days and
 * assert: the deterministic pack surfaces only FREQUENT + MISHANDLED intents as
 * gaps; automation_opportunity insights are written with evidence.content_gap=true
 * and the model's draft; the fingerprint dedups a re-run in place; label drift
 * retires the orphan; and a missing API key writes nothing.
 */

const hoisted = vi.hoisted(() => ({ parseMock: vi.fn() }));

vi.mock("../src/anthropic", () => ({
  getAnthropic: () => ({ messages: { parse: hoisted.parseMock } }),
}));

import { buildKbGapPack, runKbGapMiner } from "../src/agents/kb-gaps";

function parseResult(
  parsed: unknown,
  inTok = 5000,
  outTok = 1200,
): { parsed_output: unknown; usage: { input_tokens: number; output_tokens: number } } {
  return { parsed_output: parsed, usage: { input_tokens: inTok, output_tokens: outTok } };
}

interface ConvSeed {
  intent: string;
  topics: string[];
  resolution: "resolved" | "escalated" | "abandoned";
  sentiment: "positive" | "neutral" | "negative";
  daysAgo: number;
}

/** Insert an llm.conversation event at NOON UTC of a London day, return its id. */
async function insertConversation(
  orgId: string,
  projectId: string,
  s: ConvSeed,
): Promise<string> {
  const id = randomUUID();
  const rows = (await db.$client`
    select to_char(
      ((date_trunc('day', now() at time zone 'Europe/London') - make_interval(days => ${s.daysAgo}))
        at time zone 'Europe/London') at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS"Z"'
    ) as iso
  `) as unknown as { iso: string }[];
  const at = new Date(new Date(rows[0]!.iso).getTime() + 12 * 3600 * 1000);
  await db.$client`
    insert into events (id, org_id, project_id, type, source, idempotency_key, occurred_at, received_at, data, currency, raw)
    values (
      ${id}::uuid, ${orgId}::uuid, ${projectId}::uuid, 'llm.conversation', 'sdk',
      ${`test:${id}`}, ${at.toISOString()}::timestamptz, ${at.toISOString()}::timestamptz,
      ${JSON.stringify({
        channel: "webchat",
        intent: s.intent,
        topics: s.topics,
        resolution: s.resolution,
        sentiment: s.sentiment,
        summary: `Caller asked about ${s.intent}`,
      })}::jsonb,
      'gbp', '{}'::jsonb
    )
  `;
  return id;
}

interface OppRow {
  id: string;
  title: string;
  body_md: string;
  evidence: Record<string, unknown>;
  fingerprint: string | null;
  confidence: string;
  status: string;
  estimated_value_pence: string | number | null;
  estimated_hours_saved_monthly: number | null;
}

async function loadOpportunities(orgId: string): Promise<OppRow[]> {
  return (await db.$client`
    select id::text as id, title, body_md, evidence, fingerprint,
      confidence::text as confidence, status::text as status,
      estimated_value_pence, estimated_hours_saved_monthly
    from insights
    where org_id = ${orgId}::uuid and kind = 'automation_opportunity'
    order by title
  `) as unknown as OppRow[];
}

let harness: AgentsHarness;
const refundIds: string[] = [];
const complaintIds: string[] = [];

beforeAll(async () => {
  harness = await createHarness("KB Gap Test");

  // GAP 1 — "refund_status": 5 conversations, ALL escalated/abandoned → a clear
  // content gap (5 gap signals >= 3).
  for (let i = 0; i < 5; i++) {
    refundIds.push(
      await insertConversation(harness.orgId, harness.projectId, {
        intent: "refund_status",
        topics: ["refunds", "orders"],
        resolution: i < 3 ? "escalated" : "abandoned",
        sentiment: "neutral",
        daysAgo: 2 + (i % 5),
      }),
    );
  }

  // GAP 2 — "complaint": 4 conversations, all negative sentiment → 4 gap signals.
  for (let i = 0; i < 4; i++) {
    complaintIds.push(
      await insertConversation(harness.orgId, harness.projectId, {
        intent: "complaint",
        topics: ["service"],
        resolution: "resolved",
        sentiment: "negative",
        daysAgo: 3 + (i % 4),
      }),
    );
  }

  // NON-GAP — "opening_hours": 6 conversations, all resolved + positive → below
  // the MIN_GAP_SIGNALS floor (0 mishandled), must NOT appear as a gap.
  for (let i = 0; i < 6; i++) {
    await insertConversation(harness.orgId, harness.projectId, {
      intent: "opening_hours",
      topics: ["hours"],
      resolution: "resolved",
      sentiment: "positive",
      daysAgo: 1 + (i % 5),
    });
  }
});

afterEach(async () => {
  hoisted.parseMock.mockReset();
  await db.$client`delete from insights where org_id = ${harness.orgId}::uuid`;
  await db.$client`delete from agent_runs where org_id = ${harness.orgId}::uuid`;
});

afterAll(async () => {
  await cleanupHarness(harness);
});

function sampleOutput(): KbGapOutput {
  return {
    gaps: [
      {
        intent: "refund_status",
        question: "How do I check the status of my refund?",
        article_title: "Checking Your Refund Status",
        article_md: "Refunds are processed within 5 working days. You can check status by…",
        bot_improvement: "Add a refund-status intent that looks up the order and returns an ETA.",
        example_event_ids: refundIds.slice(0, 3),
        estimated_hours_saved_monthly: 6,
        estimated_value_pence: 40000,
        confidence: "high",
        fingerprint: "refund-status",
      },
      {
        intent: "complaint",
        question: "How do I raise a complaint?",
        article_title: "Raising a Complaint",
        article_md: "We're sorry to hear that. To raise a complaint…",
        bot_improvement: "Add an empathetic complaint flow that captures details and escalates cleanly.",
        example_event_ids: complaintIds.slice(0, 2),
        estimated_hours_saved_monthly: 3,
        estimated_value_pence: 20000,
        confidence: "med",
        fingerprint: "complaint",
      },
    ],
  };
}

describe("buildKbGapPack — deterministic content-gap detection", () => {
  it("surfaces only frequent + mishandled intents, ranked by gap signals", async () => {
    const { pack, projectFound } = await buildKbGapPack(
      db,
      harness.orgId,
      harness.projectId,
    );
    expect(projectFound).toBe(true);
    // opening_hours (resolved/positive) is excluded; refund + complaint remain.
    expect(pack.gaps.map((g) => g.intent)).toEqual(["refund_status", "complaint"]);

    const refund = pack.gaps.find((g) => g.intent === "refund_status")!;
    expect(refund.total).toBe(5);
    expect(refund.gapSignals).toBe(5); // all escalated/abandoned
    expect(refund.escalated).toBe(3);
    expect(refund.abandoned).toBe(2);
    expect(refund.exampleEventIds.length).toBe(5);
    expect(refund.topics.sort()).toEqual(["orders", "refunds"]);

    const complaint = pack.gaps.find((g) => g.intent === "complaint")!;
    expect(complaint.negative).toBe(4);
    expect(complaint.gapSignals).toBe(4);

    expect(pack.totals.conversations).toBe(15);
  });
});

describe("runKbGapMiner — writes content-gap opportunities", () => {
  it("writes one automation_opportunity per gap with content_gap + draft evidence", async () => {
    hoisted.parseMock.mockResolvedValueOnce(parseResult(sampleOutput()));

    const res = await runKbGapMiner(db, {
      orgId: harness.orgId,
      projectId: harness.projectId,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error);
    expect(hoisted.parseMock).toHaveBeenCalledTimes(1);
    expect(res.gapsWritten).toBe(2);
    expect(res.tokensIn).toBe(5000);
    expect(res.tokensOut).toBe(1200);

    const rows = await loadOpportunities(harness.orgId);
    expect(rows.length).toBe(2);

    const refund = rows.find((r) => r.title === "Checking Your Refund Status")!;
    expect(refund.status).toBe("new");
    expect(refund.confidence).toBe("high");
    expect(refund.evidence["content_gap"]).toBe(true);
    expect(refund.evidence["intent"]).toBe("refund_status");
    const draft = refund.evidence["draft"] as Record<string, unknown>;
    expect(draft["bot_improvement"]).toContain("refund-status");
    expect(Number(refund.estimated_value_pence)).toBe(40000);
    expect(refund.estimated_hours_saved_monthly).toBe(6);
    // only the real ids the pack gave survive
    expect((refund.evidence["event_ids"] as string[]).length).toBe(3);
    expect(refund.fingerprint).toBe(`kbgap:${harness.projectId}:refund-status`);
    // aggregates grounded from the pack gap
    const agg = refund.evidence["aggregates"] as Record<string, unknown>;
    expect(agg["gap_signals"]).toBe(5);
  });

  it("drops hallucinated example ids not present in the gap", async () => {
    const out = sampleOutput();
    out.gaps[0]!.example_event_ids = [randomUUID(), refundIds[0]!];
    hoisted.parseMock.mockResolvedValueOnce(parseResult(out));

    await runKbGapMiner(db, { orgId: harness.orgId, projectId: harness.projectId });
    const rows = await loadOpportunities(harness.orgId);
    const refund = rows.find((r) => r.title === "Checking Your Refund Status")!;
    expect(refund.evidence["event_ids"]).toEqual([refundIds[0]]);
  });

  it("is idempotent: a re-run updates the same fingerprinted rows, no duplicates", async () => {
    hoisted.parseMock.mockResolvedValueOnce(parseResult(sampleOutput()));
    const firstRun = await runKbGapMiner(db, {
      orgId: harness.orgId,
      projectId: harness.projectId,
    });
    if (!firstRun.ok) throw new Error(firstRun.error);
    // Fresh run: both gaps are new inserts, nothing refreshed.
    expect(firstRun.gapsWritten).toBe(2);
    expect(firstRun.gapsUpdated).toBe(0);

    const first = await loadOpportunities(harness.orgId);
    expect(first.length).toBe(2);
    const refundIdBefore = first.find((r) => r.title === "Checking Your Refund Status")!.id;

    const updated = sampleOutput();
    updated.gaps[0]!.article_md = "Updated: refunds now take 3 working days.";
    hoisted.parseMock.mockResolvedValueOnce(parseResult(updated));
    const secondRun = await runKbGapMiner(db, {
      orgId: harness.orgId,
      projectId: harness.projectId,
    });
    if (!secondRun.ok) throw new Error(secondRun.error);
    // Re-run writes nothing NEW; both existing live rows are merely refreshed.
    expect(secondRun.gapsWritten).toBe(0);
    expect(secondRun.gapsUpdated).toBe(2);

    const second = await loadOpportunities(harness.orgId);
    expect(second.length).toBe(2);
    const refundAfter = second.find((r) => r.title === "Checking Your Refund Status")!;
    expect(refundAfter.id).toBe(refundIdBefore);
    expect(refundAfter.body_md).toContain("Updated:");
  });

  it("leaves a dismissed row untouched and uncounted on a re-run", async () => {
    hoisted.parseMock.mockResolvedValueOnce(parseResult(sampleOutput()));
    await runKbGapMiner(db, { orgId: harness.orgId, projectId: harness.projectId });

    // Owner dismisses the refund gap.
    const refundFp = `kbgap:${harness.projectId}:refund-status`;
    await db.$client`
      update insights set status = 'dismissed', body_md = 'DISMISSED BODY'
      where org_id = ${harness.orgId}::uuid and fingerprint = ${refundFp}
    `;

    // The exact same gaps reappear next run.
    hoisted.parseMock.mockResolvedValueOnce(parseResult(sampleOutput()));
    const rerun = await runKbGapMiner(db, {
      orgId: harness.orgId,
      projectId: harness.projectId,
    });
    if (!rerun.ok) throw new Error(rerun.error);
    // Only the live complaint row is refreshed; the dismissed refund is neither
    // rewritten nor counted as new/actionable output.
    expect(rerun.gapsWritten).toBe(0);
    expect(rerun.gapsUpdated).toBe(1);

    const rows = await loadOpportunities(harness.orgId);
    expect(rows.length).toBe(2); // no duplicate, no resurrection
    const refund = rows.find((r) => r.fingerprint === refundFp)!;
    expect(refund.status).toBe("dismissed"); // stays hidden from Growth
    expect(refund.body_md).toBe("DISMISSED BODY"); // untouched, not rewritten
  });

  it("retires an orphaned 'new' content-gap when the fingerprint drifts across runs", async () => {
    hoisted.parseMock.mockResolvedValueOnce(parseResult(sampleOutput()));
    await runKbGapMiner(db, { orgId: harness.orgId, projectId: harness.projectId });

    const drifted = sampleOutput();
    drifted.gaps[0]!.fingerprint = "refund-tracking"; // different slug
    drifted.gaps[0]!.article_title = "Tracking Your Refund";
    hoisted.parseMock.mockResolvedValueOnce(parseResult(drifted));
    await runKbGapMiner(db, { orgId: harness.orgId, projectId: harness.projectId });

    const rows = await loadOpportunities(harness.orgId);
    expect(rows.map((r) => r.title).sort()).toEqual([
      "Raising a Complaint",
      "Tracking Your Refund",
    ]);
  });

  it("writes nothing and returns a typed error when the model call fails", async () => {
    hoisted.parseMock.mockRejectedValueOnce(new Error("ANTHROPIC_API_KEY missing"));

    const res = await runKbGapMiner(db, {
      orgId: harness.orgId,
      projectId: harness.projectId,
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected failure");
    expect(res.error).toBe("anthropic_auth");
    expect((await loadOpportunities(harness.orgId)).length).toBe(0);
  });

  it("short-circuits (no model call) when there are no content gaps", async () => {
    const clean = await createHarness("KB Gap Clean");
    try {
      // Only well-handled conversations → no gaps.
      for (let i = 0; i < 4; i++) {
        await insertConversation(clean.orgId, clean.projectId, {
          intent: "opening_hours",
          topics: ["hours"],
          resolution: "resolved",
          sentiment: "positive",
          daysAgo: 1 + i,
        });
      }
      const res = await runKbGapMiner(db, {
        orgId: clean.orgId,
        projectId: clean.projectId,
      });
      expect(res.ok).toBe(true);
      if (!res.ok) throw new Error(res.error);
      expect(res.runId).toBeNull();
      expect(res.gapsWritten).toBe(0);
      expect(hoisted.parseMock).not.toHaveBeenCalled();
    } finally {
      await db.$client`delete from insights where org_id = ${clean.orgId}::uuid`;
      await cleanupHarness(clean);
    }
  });
});
