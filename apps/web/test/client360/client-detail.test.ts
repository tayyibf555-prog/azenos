import { randomUUID } from "node:crypto";
import { closeDb } from "@azen/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getClientDetail } from "../../lib/server/bookings";
import {
  cleanup,
  createClientRow,
  createOrg,
  createProjectRow,
  createSubscription,
  daysAgo,
  insertBrief,
  insertEvent,
  insertFeedbackItem,
} from "./helpers";

/**
 * P8-C360 aggregation tests (docs/phase8/CONTRACTS.md). Hand-built rows on a
 * throwaway org — every expected number is computed in the comments below.
 * Covers: MRR share, per-project events-30d + margin, the cross-project
 * conversations digest, the open-feedback rollup, and recent project-scoped
 * briefs. The demo org is never touched.
 */

const ORG = randomUUID();
let CLIENT_A = ""; // the multi-project client under test
let CLIENT_B = ""; // a second client in the same org, to make MRR share < 100%
let P1 = "";
let P2 = "";
let P3 = ""; // ClientB's project — must never leak into ClientA's aggregates

beforeAll(async () => {
  await createOrg(ORG);
  CLIENT_A = await createClientRow(ORG, { name: "Multi-Project Client" });
  CLIENT_B = await createClientRow(ORG, { name: "Other Client" });
  P1 = await createProjectRow(ORG, CLIENT_A, { name: "P1", retainerPenceMonthly: 40_000 });
  P2 = await createProjectRow(ORG, CLIENT_A, { name: "P2" });
  P3 = await createProjectRow(ORG, CLIENT_B, { name: "P3" });

  // ── MRR: ClientA 30,000 + ClientB 70,000 = org MRR 100,000 → share 30%.
  await createSubscription(ORG, CLIENT_A, { amountPenceMonthly: 30_000 });
  await createSubscription(ORG, CLIENT_B, { amountPenceMonthly: 70_000 });

  // ── P1 events-30d = 3 (1 generic + 2 conversations), + 2 OLD events (>30d,
  //    excluded). P2 events-30d = 1 (1 conversation).
  await insertEvent(ORG, P1, { type: "agent.run.completed", occurredAt: daysAgo(2) });
  await insertEvent(ORG, P1, {
    type: "llm.conversation",
    occurredAt: daysAgo(3),
    data: { resolution: "resolved", sentiment: "positive" },
  });
  await insertEvent(ORG, P1, {
    type: "llm.conversation",
    occurredAt: daysAgo(4),
    data: { resolution: "escalated", sentiment: "neutral" },
  });
  await insertEvent(ORG, P1, { type: "agent.run.completed", occurredAt: daysAgo(40) });
  await insertEvent(ORG, P1, { type: "agent.run.completed", occurredAt: daysAgo(45) });

  await insertEvent(ORG, P2, {
    type: "llm.conversation",
    occurredAt: daysAgo(1),
    data: { resolution: "resolved", sentiment: "negative" },
  });

  // ── Feedback: bug open ×2 (P1 + P2), feature open ×1 (P1), question open ×1
  //    (P2), bug DONE ×1 on P1 (excluded from the rollup).
  await insertFeedbackItem(ORG, P1, { kind: "bug", status: "new" });
  await insertFeedbackItem(ORG, P1, { kind: "bug", status: "done" });
  await insertFeedbackItem(ORG, P1, { kind: "feature", status: "seen" });
  await insertFeedbackItem(ORG, P2, { kind: "bug", status: "new" });
  await insertFeedbackItem(ORG, P2, { kind: "question", status: "planned" });

  // ── Briefs: two project-scoped briefs on ClientA's projects (desc by
  //    periodStart → P2's should come first), one on ClientB's P3 that must
  //    never appear in ClientA's detail.
  await insertBrief(ORG, { projectId: P1, periodStart: new Date("2026-01-05T00:00:00Z"), headline: "P1 weekly" });
  await insertBrief(ORG, { projectId: P2, periodStart: new Date("2026-01-10T00:00:00Z"), headline: "P2 weekly" });
  await insertBrief(ORG, { projectId: P3, periodStart: new Date("2026-01-12T00:00:00Z"), headline: "P3 weekly" });
}, 30_000);

afterAll(async () => {
  await cleanup(ORG);
  await closeDb();
});

describe("getClientDetail — P8-C360 aggregation", () => {
  it("computes MRR share against org-wide active MRR", async () => {
    const d = await getClientDetail(ORG, CLIENT_A);
    expect(d).not.toBeNull();
    expect(d!.mrr.clientPence).toBe(30_000);
    expect(d!.mrr.orgPence).toBe(100_000);
    expect(d!.mrr.sharePct).toBeCloseTo(0.3, 5);
  });

  it("counts trailing-30d events per project, excluding older rows", async () => {
    // eventsLast30d counts ALL event types, so the feedback.submitted mirror
    // events created below add to these totals: P1 = 1 agent + 2 conversation
    // + 2 excluded (>30d) + 3 feedback.submitted = 6; P2 = 1 conversation + 2
    // feedback.submitted = 3.
    const d = await getClientDetail(ORG, CLIENT_A);
    const p1 = d!.projects.find((p) => p.id === P1)!;
    const p2 = d!.projects.find((p) => p.id === P2)!;
    expect(p1.eventsLast30d).toBe(6);
    expect(p2.eventsLast30d).toBe(3);
  });

  it("aggregates the 30d conversations digest across both projects", async () => {
    const d = await getClientDetail(ORG, CLIENT_A);
    const c = d!.conversations;
    // total = 2 (P1) + 1 (P2) = 3; resolved = 2 (P1 resolved + P2 resolved);
    // escalated = 1 (P1 escalated).
    expect(c.total).toBe(3);
    expect(c.resolutionRate).toBeCloseTo(2 / 3, 5);
    expect(c.escalationRate).toBeCloseTo(1 / 3, 5);
    expect(c.sentimentMix).toEqual({ positive: 1, neutral: 1, negative: 1 });
  });

  it("rolls up open (not-done) feedback by kind across both projects", async () => {
    const d = await getClientDetail(ORG, CLIENT_A);
    const byKind = Object.fromEntries(d!.feedbackOpen.map((f) => [f.kind, f.count]));
    expect(byKind["bug"]).toBe(2); // 1 on each project; the done one excluded
    expect(byKind["feature"]).toBe(1);
    expect(byKind["question"]).toBe(1);
    expect(byKind["praise"]).toBeUndefined();
  });

  it("lists recent project-scoped briefs, newest first, never leaking another client's", async () => {
    const d = await getClientDetail(ORG, CLIENT_A);
    const headlines = d!.recentBriefs.map((b) => b.headline);
    expect(headlines).toEqual(["P2 weekly", "P1 weekly"]);
    expect(headlines).not.toContain("P3 weekly");
  });

  it("returns null for a client id not in this org (cross-org 404)", async () => {
    const d = await getClientDetail(ORG, randomUUID());
    expect(d).toBeNull();
  });

  it("never leaks another client's project data into this client's detail", async () => {
    const d = await getClientDetail(ORG, CLIENT_A);
    expect(d!.projects.some((p) => p.id === P3)).toBe(false);
  });
});
