import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentRuns, db, expenses, subscriptions } from "@azen/db";
import { getOsRoi, getProjectMargins } from "../../lib/server/money";
import {
  cleanupMoneyHarness,
  createMoneyHarness,
  dayInMonth,
  monthLabel,
  monthStartIso,
  type MoneyHarness,
} from "./helpers";

/**
 * Runtime coverage for per-project margin + OS-ROI (SQL that the other tests
 * don't touch). Project retainer £1,000; attributed AI cost £10; project
 * hosting £15 → margin £975. OS AI spend this month = £10; retainers under
 * management = £1,000 (one active sub).
 */
describe("getProjectMargins + getOsRoi", () => {
  let h: MoneyHarness;

  beforeAll(async () => {
    h = await createMoneyHarness();
    await db.insert(subscriptions).values({
      orgId: h.orgId,
      clientId: h.clientId,
      projectId: h.projectId,
      amountPenceMonthly: 100_000,
      status: "active",
      startedAt: monthStartIso(2),
    });
    await db.insert(agentRuns).values({
      orgId: h.orgId,
      agent: "daily_brief",
      projectId: h.projectId,
      clientId: h.clientId,
      startedAt: dayInMonth(0),
      status: "succeeded",
      costEstimatePence: 1_000,
    });
    await db.insert(expenses).values({
      orgId: h.orgId,
      projectId: h.projectId,
      category: "hosting",
      vendor: "Supabase",
      amountPence: 1_500,
      recurring: true,
      period: monthLabel(0),
      incurredAt: monthStartIso(0),
    });
  });

  afterAll(async () => {
    await cleanupMoneyHarness(h);
  });

  it("computes per-project margin = retainer − (AI + hosting)", async () => {
    const { rows } = await getProjectMargins(h.orgId);
    const m = rows.find((r) => r.projectId === h.projectId)!;
    expect(m.retainerPence).toBe(100_000);
    expect(m.aiCostPence).toBe(1_000);
    expect(m.hostingCostPence).toBe(1_500);
    expect(m.totalCostPence).toBe(2_500);
    expect(m.marginPence).toBe(97_500);
  });

  it("reports OS AI spend and retainers under management", async () => {
    const roi = await getOsRoi(h.orgId);
    expect(roi.aiSpendPence).toBe(1_000);
    expect(roi.runCount).toBe(1);
    expect(roi.retainersUnderManagementPence).toBe(100_000);
    expect(roi.upsellsWonPence).toBeNull();
  });
});
