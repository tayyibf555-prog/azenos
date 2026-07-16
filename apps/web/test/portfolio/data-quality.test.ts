import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  computeCoveragePct,
  computeDeliveryRates,
  computeUnknownTypeShare,
  getDataQualitySummary,
  isDataQualityClean,
} from "../../lib/server/analytics/data-quality";
import {
  cleanupPortfolioHarness,
  createPortfolioHarness,
  insertClient,
  insertDelivery,
  insertEvent,
  insertProject,
  insertProjectKey,
  type PortfolioHarness,
} from "./helpers";

describe("computeDeliveryRates (pure)", () => {
  it("rates are counts ÷ total across all four statuses", () => {
    const r = computeDeliveryRates({ accepted: 90, duplicate: 5, rejected: 3, failed: 2 });
    expect(r.total).toBe(100);
    expect(r.rejectedRate).toBeCloseTo(0.03);
    expect(r.failedRate).toBeCloseTo(0.02);
    expect(r.duplicateRate).toBeCloseTo(0.05);
  });

  it("zero deliveries → all rates 0, never NaN", () => {
    const r = computeDeliveryRates({ accepted: 0, duplicate: 0, rejected: 0, failed: 0 });
    expect(r).toEqual({ total: 0, rejectedRate: 0, failedRate: 0, duplicateRate: 0 });
  });
});

describe("computeUnknownTypeShare (pure)", () => {
  it("unknown ÷ total", () => {
    expect(computeUnknownTypeShare(50, 5)).toBeCloseTo(0.1);
  });
  it("no events → 0", () => {
    expect(computeUnknownTypeShare(0, 0)).toBe(0);
  });
});

describe("computeCoveragePct (pure)", () => {
  it("present ÷ required as a percentage", () => {
    expect(computeCoveragePct(3, 4)).toBe(75);
  });
  it("nothing required → 100% (nothing missing)", () => {
    expect(computeCoveragePct(0, 0)).toBe(100);
  });
});

describe("isDataQualityClean (pure)", () => {
  it("clean when every rate is 0 and coverage is full", () => {
    expect(
      isDataQualityClean({
        deliveries: { total: 10, rejectedRate: 0, failedRate: 0, duplicateRate: 0 },
        unknownTypeShare: 0,
        coveragePct: 100,
      }),
    ).toBe(true);
  });
  it("dirty when any single rate is non-zero", () => {
    expect(
      isDataQualityClean({
        deliveries: { total: 10, rejectedRate: 0.1, failedRate: 0, duplicateRate: 0 },
        unknownTypeShare: 0,
        coveragePct: 100,
      }),
    ).toBe(false);
    expect(
      isDataQualityClean({
        deliveries: { total: 10, rejectedRate: 0, failedRate: 0, duplicateRate: 0 },
        unknownTypeShare: 0,
        coveragePct: 80,
      }),
    ).toBe(false);
  });
});

describe("getDataQualitySummary (SQL, hand-built webhook_deliveries)", () => {
  let h: PortfolioHarness;
  let projectId: string;

  beforeAll(async () => {
    h = await createPortfolioHarness();
    const clientId = await insertClient(h.orgId, "Data Quality Client");
    // chatbot preset requires: llm.conversation, message.received, message.sent,
    // lead.created, agent.escalated_to_human (5 required types).
    projectId = await insertProject({ orgId: h.orgId, clientId, type: "chatbot" });
    const keyId = await insertProjectKey(h.orgId, projectId);

    const now = new Date();
    const within7d = (hoursAgo: number) => new Date(now.getTime() - hoursAgo * 3_600_000);

    // 10 deliveries in the last 7 days: 7 accepted, 1 duplicate, 1 rejected, 1 failed.
    for (let i = 0; i < 7; i++) {
      await insertDelivery({ orgId: h.orgId, projectKeyId: keyId, status: "accepted", receivedAt: within7d(i) });
    }
    await insertDelivery({ orgId: h.orgId, projectKeyId: keyId, status: "duplicate", receivedAt: within7d(1) });
    await insertDelivery({ orgId: h.orgId, projectKeyId: keyId, status: "rejected", receivedAt: within7d(1) });
    await insertDelivery({ orgId: h.orgId, projectKeyId: keyId, status: "failed", receivedAt: within7d(1) });
    // Outside the 7d window — must not count.
    await insertDelivery({ orgId: h.orgId, projectKeyId: keyId, status: "rejected", receivedAt: within7d(24 * 30) });

    // Events in the last 7 days: 4 known types, 1 unknown type ("weird.custom.thing").
    await insertEvent({ orgId: h.orgId, projectId, type: "llm.conversation", occurredAt: within7d(1) });
    await insertEvent({ orgId: h.orgId, projectId, type: "message.received", occurredAt: within7d(1) });
    await insertEvent({ orgId: h.orgId, projectId, type: "message.sent", occurredAt: within7d(1) });
    await insertEvent({ orgId: h.orgId, projectId, type: "lead.created", occurredAt: within7d(1) });
    await insertEvent({ orgId: h.orgId, projectId, type: "weird.custom.thing", occurredAt: within7d(1) });
    // Outside the window — must not count toward the 7d unknown share.
    await insertEvent({ orgId: h.orgId, projectId, type: "another.unknown.type", occurredAt: within7d(24 * 30) });

    // All-time coverage: only 4 of 5 required chatbot types seen (never sent
    // agent.escalated_to_human) — the 30-day-old event above also counts for coverage.
  });

  afterAll(async () => {
    await cleanupPortfolioHarness(h);
  });

  it("computes delivery rates, unknown-type share and coverage exactly", async () => {
    const dq = await getDataQualitySummary(h.orgId, projectId, "chatbot");

    expect(dq.deliveries.total).toBe(10);
    expect(dq.deliveries.rejectedRate).toBeCloseTo(0.1);
    expect(dq.deliveries.failedRate).toBeCloseTo(0.1);
    expect(dq.deliveries.duplicateRate).toBeCloseTo(0.1);

    expect(dq.totalEvents).toBe(5);
    expect(dq.unknownTypeCount).toBe(1);
    expect(dq.unknownTypeShare).toBeCloseTo(0.2);

    expect(dq.requiredTotal).toBe(5);
    expect(dq.requiredPresent).toBe(4);
    expect(dq.coveragePct).toBe(80);

    expect(dq.isClean).toBe(false);
  });

  it("all-clean project: no deliveries, no events, nothing required", async () => {
    const clientId = await insertClient(h.orgId, "Clean Client");
    const cleanProjectId = await insertProject({ orgId: h.orgId, clientId, type: "custom" });
    // "custom" preset has zero required types → coverage is 100% with nothing sent.
    const dq = await getDataQualitySummary(h.orgId, cleanProjectId, "custom");

    expect(dq.deliveries.total).toBe(0);
    expect(dq.deliveries.rejectedRate).toBe(0);
    expect(dq.deliveries.failedRate).toBe(0);
    expect(dq.deliveries.duplicateRate).toBe(0);
    expect(dq.unknownTypeShare).toBe(0);
    expect(dq.requiredTotal).toBe(0);
    expect(dq.coveragePct).toBe(100);
    expect(dq.isClean).toBe(true);
  });
});
