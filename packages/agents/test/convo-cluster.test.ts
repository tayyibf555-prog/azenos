import { randomUUID } from "node:crypto";
import { db } from "@azen/db";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ConvoClusterOutput } from "../src/agents/convo-cluster";
import {
  type AgentsHarness,
  cleanupHarness,
  createHarness,
} from "./helpers";

/**
 * runConvoClustering tests (docs/phase5/CONTRACTS.md §P5-CONVO). getAnthropic is
 * MOCKED — no live API calls; a real throwaway-org DB backs the insights +
 * agent_runs assertions. We hand-build llm.conversation events at a known London
 * day and assert: faq_cluster insights are written with the right evidence
 * (event_ids, count, share_pct, trend, scout_candidate), the fingerprint dedups
 * a re-run in place (no duplicate rows), and a missing API key writes nothing.
 */

const hoisted = vi.hoisted(() => ({ parseMock: vi.fn() }));

vi.mock("../src/anthropic", () => ({
  getAnthropic: () => ({ messages: { parse: hoisted.parseMock } }),
}));

import { runConvoClustering } from "../src/agents/convo-cluster";

function parseResult(
  parsed: unknown,
  inTok = 4000,
  outTok = 800,
): { parsed_output: unknown; usage: { input_tokens: number; output_tokens: number } } {
  return { parsed_output: parsed, usage: { input_tokens: inTok, output_tokens: outTok } };
}

interface ConvSeed {
  intent: string;
  topics: string[];
  resolution: "resolved" | "escalated" | "abandoned";
  sentiment: "positive" | "neutral" | "negative";
  daysAgo: number; // London days before today (1 = yesterday)
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
  // noon UTC of that London day (bucket-safe in both GMT and BST)
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

interface FaqRow {
  id: string;
  title: string;
  body_md: string;
  evidence: Record<string, unknown>;
  fingerprint: string | null;
  confidence: string;
  status: string;
  kind: string;
}

async function loadFaqClusters(orgId: string): Promise<FaqRow[]> {
  return (await db.$client`
    select id::text as id, title, body_md, evidence, fingerprint, confidence::text as confidence,
      status::text as status, kind::text as kind
    from insights
    where org_id = ${orgId}::uuid and kind = 'faq_cluster'
    order by title
  `) as unknown as FaqRow[];
}

let harness: AgentsHarness;
// eventIds captured for citing as examples
let bookingIds: string[] = [];
let pricingIds: string[] = [];

beforeAll(async () => {
  harness = await createHarness("Convo Cluster Test");

  // THIS week (days 1-3 ago): 5 booking, 3 pricing conversations.
  for (let i = 0; i < 5; i++) {
    bookingIds.push(
      await insertConversation(harness.orgId, harness.projectId, {
        intent: "book_appointment",
        topics: ["booking"],
        resolution: i < 4 ? "resolved" : "escalated",
        sentiment: "positive",
        daysAgo: 1 + (i % 3),
      }),
    );
  }
  for (let i = 0; i < 3; i++) {
    pricingIds.push(
      await insertConversation(harness.orgId, harness.projectId, {
        intent: "pricing",
        topics: ["pricing"],
        resolution: "escalated",
        sentiment: "neutral",
        daysAgo: 1 + (i % 3),
      }),
    );
  }
  // LAST week (days 9-11 ago): 1 booking, so 'booking' trends up / is present.
  await insertConversation(harness.orgId, harness.projectId, {
    intent: "book_appointment",
    topics: ["booking"],
    resolution: "resolved",
    sentiment: "positive",
    daysAgo: 9,
  });
});

afterEach(async () => {
  hoisted.parseMock.mockReset();
  await db.$client`delete from insights where org_id = ${harness.orgId}::uuid`;
  await db.$client`delete from agent_runs where org_id = ${harness.orgId}::uuid`;
});

afterAll(async () => {
  await cleanupHarness(harness);
});

function sampleOutput(): ConvoClusterOutput {
  return {
    clusters: [
      {
        topic: "Booking",
        count: 5,
        share_pct: 62.5,
        example_event_ids: bookingIds.slice(0, 3),
        trend_vs_last_week: "up",
        is_unautomated_repetition: false,
        note: "5 booking conversations, 62.5% of the week — handled cleanly.",
      },
      {
        topic: "Pricing",
        count: 3,
        share_pct: 37.5,
        example_event_ids: pricingIds.slice(0, 2),
        trend_vs_last_week: "new",
        is_unautomated_repetition: true,
        note: "3 pricing conversations, all escalated — automate quotes.",
      },
    ],
  };
}

describe("runConvoClustering — clustering + insight writes", () => {
  it("writes one faq_cluster insight per cluster with correct evidence + scout flag", async () => {
    hoisted.parseMock.mockResolvedValueOnce(parseResult(sampleOutput()));

    const res = await runConvoClustering(db, {
      orgId: harness.orgId,
      projectId: harness.projectId,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error);
    expect(hoisted.parseMock).toHaveBeenCalledTimes(1);
    expect(res.clustersWritten).toBe(2);
    expect(res.scoutCandidates).toBe(1);
    expect(res.tokensIn).toBe(4000);
    expect(res.tokensOut).toBe(800);

    const rows = await loadFaqClusters(harness.orgId);
    expect(rows.length).toBe(2);

    const booking = rows.find((r) => r.title === "Booking")!;
    expect(booking.kind).toBe("faq_cluster");
    expect(booking.status).toBe("new");
    // share 62.5 → high confidence (≥35)
    expect(booking.confidence).toBe("high");
    expect(booking.evidence["count"]).toBe(5);
    expect(booking.evidence["share_pct"]).toBe(62.5);
    expect(booking.evidence["trend"]).toBe("up");
    expect(Array.isArray(booking.evidence["event_ids"])).toBe(true);
    expect((booking.evidence["event_ids"] as string[]).length).toBe(3);
    // not flagged → no scout_candidate key
    expect(booking.evidence["scout_candidate"]).toBeUndefined();
    // fingerprint = faq:<projectId>:<slug>
    expect(booking.fingerprint).toBe(`faq:${harness.projectId}:booking`);

    const pricing = rows.find((r) => r.title === "Pricing")!;
    expect(pricing.evidence["scout_candidate"]).toBe(true);
    expect(pricing.evidence["trend"]).toBe("new");
  });

  it("is idempotent: a re-run updates the same fingerprinted rows, no duplicates", async () => {
    hoisted.parseMock.mockResolvedValueOnce(parseResult(sampleOutput()));
    await runConvoClustering(db, { orgId: harness.orgId, projectId: harness.projectId });

    const first = await loadFaqClusters(harness.orgId);
    expect(first.length).toBe(2);
    const bookingIdBefore = first.find((r) => r.title === "Booking")!.id;

    // Second run with a changed note/count for the same topics.
    const updated = sampleOutput();
    updated.clusters[0]!.note = "Updated: 5 booking conversations this week.";
    updated.clusters[0]!.count = 5;
    hoisted.parseMock.mockResolvedValueOnce(parseResult(updated));
    const res2 = await runConvoClustering(db, {
      orgId: harness.orgId,
      projectId: harness.projectId,
    });
    expect(res2.ok).toBe(true);

    const second = await loadFaqClusters(harness.orgId);
    // Still exactly 2 rows — updated in place, not duplicated.
    expect(second.length).toBe(2);
    const bookingAfter = second.find((r) => r.title === "Booking")!;
    expect(bookingAfter.id).toBe(bookingIdBefore); // same row
    expect(bookingAfter.body_md).toContain("Updated:");
  });

  it("retires an orphaned 'new' cluster when the model's label drifts across runs", async () => {
    // Week 1: model emits "Booking".
    hoisted.parseMock.mockResolvedValueOnce(parseResult(sampleOutput()));
    await runConvoClustering(db, { orgId: harness.orgId, projectId: harness.projectId });

    const first = await loadFaqClusters(harness.orgId);
    expect(first.map((r) => r.title).sort()).toEqual(["Booking", "Pricing"]);

    // Week 2: label drifts "Booking" → "Bookings" (a different fingerprint).
    const drifted = sampleOutput();
    drifted.clusters[0]!.topic = "Bookings";
    hoisted.parseMock.mockResolvedValueOnce(parseResult(drifted));
    await runConvoClustering(db, { orgId: harness.orgId, projectId: harness.projectId });

    // The orphaned week-1 "Booking" row is retired — no stale accumulation.
    const second = await loadFaqClusters(harness.orgId);
    expect(second.map((r) => r.title).sort()).toEqual(["Bookings", "Pricing"]);
    expect(second.some((r) => r.title === "Booking")).toBe(false);
  });

  it("preserves an owner-engaged (non-new) cluster even when its label drifts away", async () => {
    hoisted.parseMock.mockResolvedValueOnce(parseResult(sampleOutput()));
    await runConvoClustering(db, { orgId: harness.orgId, projectId: harness.projectId });

    // Owner reviews the "Booking" cluster — it should never be silently retired.
    await db.$client`
      update insights set status = 'reviewed'
      where org_id = ${harness.orgId}::uuid and kind = 'faq_cluster' and title = 'Booking'
    `;

    const drifted = sampleOutput();
    drifted.clusters[0]!.topic = "Bookings";
    hoisted.parseMock.mockResolvedValueOnce(parseResult(drifted));
    await runConvoClustering(db, { orgId: harness.orgId, projectId: harness.projectId });

    const rows = await loadFaqClusters(harness.orgId);
    // Reviewed "Booking" kept; drifted "Bookings" added; "Pricing" updated.
    expect(rows.map((r) => r.title).sort()).toEqual(["Booking", "Bookings", "Pricing"]);
  });

  it("drops hallucinated example ids not present in the pack", async () => {
    const out = sampleOutput();
    out.clusters[0]!.example_event_ids = [randomUUID(), bookingIds[0]!];
    hoisted.parseMock.mockResolvedValueOnce(parseResult(out));

    await runConvoClustering(db, { orgId: harness.orgId, projectId: harness.projectId });
    const rows = await loadFaqClusters(harness.orgId);
    const booking = rows.find((r) => r.title === "Booking")!;
    // only the real id survived
    expect(booking.evidence["event_ids"]).toEqual([bookingIds[0]]);
  });

  it("writes nothing and returns a typed error when the model call fails", async () => {
    hoisted.parseMock.mockRejectedValueOnce(new Error("ANTHROPIC_API_KEY missing"));

    const res = await runConvoClustering(db, {
      orgId: harness.orgId,
      projectId: harness.projectId,
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected failure");
    expect(res.error).toBe("anthropic_auth");

    const rows = await loadFaqClusters(harness.orgId);
    expect(rows.length).toBe(0);
  });

  it("short-circuits (no model call) when the window has no conversations", async () => {
    const empty = await createHarness("Convo Empty Test");
    try {
      const res = await runConvoClustering(db, {
        orgId: empty.orgId,
        projectId: empty.projectId,
      });
      expect(res.ok).toBe(true);
      if (!res.ok) throw new Error(res.error);
      expect(res.runId).toBeNull();
      expect(res.clustersWritten).toBe(0);
      expect(hoisted.parseMock).not.toHaveBeenCalled();
    } finally {
      await db.$client`delete from insights where org_id = ${empty.orgId}::uuid`;
      await cleanupHarness(empty);
    }
  });
});
