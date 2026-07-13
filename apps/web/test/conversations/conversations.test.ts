import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeDb, db, insights } from "@azen/db";
import {
  cleanupOrg,
  createClient,
  createOrg,
  createProject,
  insertEvent,
  noonOnDaysAgo,
} from "../metrics-api/helpers";

/**
 * GET /api/projects/[projectId]/conversations tests (docs/phase5/CONTRACTS.md
 * §P5-CONVO). Hand-built llm.conversation events + faq_cluster insights on a
 * throwaway org; every expected number is computed in comments. requireOrgId is
 * mocked to the throwaway org. NO LLM — this route is pure read SQL.
 *
 * Window (default) = the last 30 London days. Conversations are placed at noon
 * UTC of a London date so the day bucket is unambiguous in GMT and BST.
 */

const TEST_ORG_ID = vi.hoisted(() => crypto.randomUUID());

vi.mock("../../lib/server/org", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../lib/server/org")>();
  return { ...mod, requireOrgId: async () => TEST_ORG_ID };
});

import { GET } from "../../app/api/projects/[projectId]/conversations/route";

let projId: string;
let otherProjId: string;
// captured event ids for wiring faq_cluster examples
let resolvedBookingId = "";
let escalatedPricingId = "";

interface ConvSpec {
  resolution: "resolved" | "escalated" | "abandoned";
  sentiment: "positive" | "neutral" | "negative";
  intent: string;
  topics: string[];
  daysAgo: number;
}

// 10 in-window conversations across TWO London days (day 3 = 4 convs, day 2 = 6).
//   resolved  = 6, escalated = 3, abandoned = 1  → resRate 0.6, escRate 0.3
//   sentiment = 5 positive, 3 neutral, 2 negative
const IN_WINDOW: ConvSpec[] = [
  { resolution: "resolved", sentiment: "positive", intent: "book_appointment", topics: ["booking"], daysAgo: 3 },
  { resolution: "resolved", sentiment: "positive", intent: "book_appointment", topics: ["booking"], daysAgo: 3 },
  { resolution: "resolved", sentiment: "positive", intent: "book_appointment", topics: ["booking"], daysAgo: 3 },
  { resolution: "escalated", sentiment: "neutral", intent: "pricing", topics: ["pricing"], daysAgo: 3 },
  { resolution: "resolved", sentiment: "positive", intent: "book_appointment", topics: ["booking"], daysAgo: 2 },
  { resolution: "resolved", sentiment: "positive", intent: "book_appointment", topics: ["booking"], daysAgo: 2 },
  { resolution: "resolved", sentiment: "neutral", intent: "book_appointment", topics: ["booking"], daysAgo: 2 },
  { resolution: "escalated", sentiment: "neutral", intent: "pricing", topics: ["pricing"], daysAgo: 2 },
  { resolution: "escalated", sentiment: "negative", intent: "pricing", topics: ["pricing"], daysAgo: 2 },
  { resolution: "abandoned", sentiment: "negative", intent: "pricing", topics: ["pricing"], daysAgo: 2 },
];

async function callRoute(projectId: string, qs = ""): Promise<Response> {
  const url = `http://test/api/projects/${projectId}/conversations${qs}`;
  return GET(new Request(url), {
    params: Promise.resolve({ projectId }),
  });
}

beforeAll(async () => {
  await createOrg(TEST_ORG_ID);
  const clientId = await createClient(TEST_ORG_ID, { name: "Convo Co" });
  projId = await createProject(TEST_ORG_ID, clientId, { name: "Convo Project" });
  otherProjId = await createProject(TEST_ORG_ID, clientId, { name: "Other Project" });

  for (const s of IN_WINDOW) {
    const id = await insertEvent(TEST_ORG_ID, projId, {
      type: "llm.conversation",
      occurredAt: noonOnDaysAgo(s.daysAgo),
      data: {
        channel: "webchat",
        intent: s.intent,
        topics: s.topics,
        resolution: s.resolution,
        sentiment: s.sentiment,
        summary: `Caller asked about ${s.intent}`,
      },
    });
    if (s.intent === "book_appointment" && s.resolution === "resolved" && !resolvedBookingId) {
      resolvedBookingId = id;
    }
    if (s.intent === "pricing" && s.resolution === "escalated" && !escalatedPricingId) {
      escalatedPricingId = id;
    }
  }

  // One conversation OUTSIDE the default 30-day window (must be excluded).
  await insertEvent(TEST_ORG_ID, projId, {
    type: "llm.conversation",
    occurredAt: noonOnDaysAgo(40),
    data: { resolution: "resolved", sentiment: "positive", topics: ["booking"] },
  });

  // Two visible faq_cluster insights (Booking 60%, Pricing 40%) + one dismissed
  // (must be excluded). Booking cites a real resolved-booking example event.
  await db.insert(insights).values({
    orgId: TEST_ORG_ID,
    projectId: projId,
    kind: "faq_cluster",
    title: "Booking",
    bodyMd: "Most common ask.",
    evidence: {
      event_ids: [resolvedBookingId],
      count: 6,
      share_pct: 60,
      trend: "up",
    },
    fingerprint: `faq:${projId}:booking`,
    confidence: "high",
    status: "new",
    createdBy: "agent",
  });
  await db.insert(insights).values({
    orgId: TEST_ORG_ID,
    projectId: projId,
    kind: "faq_cluster",
    title: "Pricing",
    bodyMd: "Frequently escalated.",
    evidence: {
      event_ids: [escalatedPricingId],
      count: 4,
      share_pct: 40,
      trend: "new",
      scout_candidate: true,
    },
    fingerprint: `faq:${projId}:pricing`,
    confidence: "med",
    status: "new",
    createdBy: "agent",
  });
  await db.insert(insights).values({
    orgId: TEST_ORG_ID,
    projectId: projId,
    kind: "faq_cluster",
    title: "Dismissed topic",
    bodyMd: "Should not appear.",
    evidence: { event_ids: [], count: 99, share_pct: 99, trend: "flat" },
    fingerprint: `faq:${projId}:dismissed`,
    confidence: "low",
    status: "dismissed",
    createdBy: "agent",
  });
});

afterAll(async () => {
  await cleanupOrg(TEST_ORG_ID);
  await closeDb();
});

interface Body {
  from: string;
  to: string;
  totalConversations: number;
  resolution: { resolved: number; escalated: number; abandoned: number; total: number };
  resolutionRate: number | null;
  escalationRate: number | null;
  volumeSeries: { periodStart: string; value: number }[];
  sentimentMix: { positive: number; neutral: number; negative: number };
  topics: {
    id: string;
    title: string;
    count: number;
    sharePct: number;
    trend: string;
    scoutCandidate: boolean;
    status: string;
    examples: { eventId: string; resolution: string | null; summary: string | null }[];
  }[];
}

describe("GET /api/projects/[projectId]/conversations", () => {
  it("computes resolution/escalation/sentiment/volume over the window", async () => {
    const res = await callRoute(projId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Body;

    // 10 in-window (the 40-days-ago conversation is excluded)
    expect(body.totalConversations).toBe(10);
    expect(body.resolution).toEqual({ resolved: 6, escalated: 3, abandoned: 1, total: 10 });
    // 6/10 and 3/10
    expect(body.resolutionRate).toBe(0.6);
    expect(body.escalationRate).toBe(0.3);
    // 5 positive, 3 neutral, 2 negative
    expect(body.sentimentMix).toEqual({ positive: 5, neutral: 3, negative: 2 });

    // two London days present, ascending → day3 (4 convs) then day2 (6 convs)
    expect(body.volumeSeries.length).toBe(2);
    expect(body.volumeSeries.map((v) => v.value)).toEqual([4, 6]);
    expect(body.volumeSeries[0]!.periodStart < body.volumeSeries[1]!.periodStart).toBe(true);
  });

  it("returns non-dismissed faq_cluster topics, share-sorted, with example drill-down", async () => {
    const res = await callRoute(projId);
    const body = (await res.json()) as Body;

    // dismissed one excluded → 2 topics; sorted by share desc (Booking 60 first)
    expect(body.topics.length).toBe(2);
    expect(body.topics.map((t) => t.title)).toEqual(["Booking", "Pricing"]);

    const booking = body.topics[0]!;
    expect(booking.count).toBe(6);
    expect(booking.sharePct).toBe(60);
    expect(booking.trend).toBe("up");
    expect(booking.scoutCandidate).toBe(false);
    // example event resolved from the cited id
    expect(booking.examples.length).toBe(1);
    expect(booking.examples[0]!.eventId).toBe(resolvedBookingId);
    expect(booking.examples[0]!.resolution).toBe("resolved");

    const pricing = body.topics[1]!;
    expect(pricing.scoutCandidate).toBe(true);
    expect(pricing.examples[0]!.eventId).toBe(escalatedPricingId);
  });

  it("empty project → zero rates (null) and no topics, still 200", async () => {
    const res = await callRoute(otherProjId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Body;
    expect(body.totalConversations).toBe(0);
    expect(body.resolutionRate).toBeNull();
    expect(body.escalationRate).toBeNull();
    expect(body.topics.length).toBe(0);
    expect(body.volumeSeries.length).toBe(0);
  });

  it("404s an unknown project id", async () => {
    const res = await callRoute(crypto.randomUUID());
    expect(res.status).toBe(404);
  });
});
