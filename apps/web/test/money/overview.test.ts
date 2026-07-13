import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, payments, subscriptions, expenses } from "@azen/db";
import { getMoneyOverview } from "../../lib/server/money";
import {
  cleanupMoneyHarness,
  createMoneyHarness,
  dayInMonth,
  monthLabel,
  monthStartIso,
  type MoneyHarness,
} from "./helpers";

/**
 * Overview MRR + cash math, checked against hand-built numbers.
 *
 * Fixture (this = current London month):
 *  - sub A: £1,000/mo, active, started 3 months ago
 *  - sub B:   £500/mo, active, started THIS month
 *  → current MRR = 150000; last month's MRR = 100000 (B not yet started)
 *  - cash in this month: 120000 + 30000 = 150000; last month: 90000
 *  - expenses this month: recurring 2000 + 4200 = 6200, plus one-off 1000
 *  → cash out this month = 7200; recurring monthly = 6200
 *  → net this month = 142800; coverage = 150000 / 6200 = 24.19
 */
describe("getMoneyOverview", () => {
  let h: MoneyHarness;

  beforeAll(async () => {
    h = await createMoneyHarness();
    await db.insert(subscriptions).values([
      {
        orgId: h.orgId,
        clientId: h.clientId,
        projectId: h.projectId,
        amountPenceMonthly: 100_000,
        status: "active",
        startedAt: monthStartIso(3),
      },
      {
        orgId: h.orgId,
        clientId: h.clientId,
        amountPenceMonthly: 50_000,
        status: "active",
        startedAt: monthStartIso(0),
      },
    ]);
    await db.insert(payments).values([
      {
        orgId: h.orgId,
        clientId: h.clientId,
        projectId: h.projectId,
        source: "bank_transfer",
        kind: "retainer",
        amountPence: 120_000,
        status: "paid",
        paidAt: dayInMonth(0),
      },
      {
        orgId: h.orgId,
        clientId: h.clientId,
        source: "stripe",
        kind: "other",
        amountPence: 30_000,
        status: "paid",
        paidAt: dayInMonth(0),
      },
      {
        orgId: h.orgId,
        clientId: h.clientId,
        source: "bank_transfer",
        kind: "retainer",
        amountPence: 90_000,
        status: "paid",
        paidAt: dayInMonth(1),
      },
      // A pending payment must NOT count toward cash in.
      {
        orgId: h.orgId,
        clientId: h.clientId,
        source: "stripe",
        kind: "other",
        amountPence: 999_999,
        status: "pending",
        paidAt: dayInMonth(0),
      },
    ]);
    await db.insert(expenses).values([
      {
        orgId: h.orgId,
        category: "hosting",
        vendor: "Vercel",
        amountPence: 2_000,
        recurring: true,
        period: monthLabel(0),
        incurredAt: monthStartIso(0),
      },
      {
        orgId: h.orgId,
        category: "api",
        vendor: "Anthropic",
        amountPence: 4_200,
        recurring: true,
        period: monthLabel(0),
        incurredAt: monthStartIso(0),
      },
      {
        orgId: h.orgId,
        category: "other",
        vendor: "One-off",
        amountPence: 1_000,
        recurring: false,
        period: monthLabel(0),
        incurredAt: monthStartIso(0),
      },
    ]);
  });

  afterAll(async () => {
    await cleanupMoneyHarness(h);
  });

  it("computes current MRR as the sum of active subscriptions", async () => {
    const o = await getMoneyOverview(h.orgId, 6);
    expect(o.currentMrrPence).toBe(150_000);
  });

  it("MRR-over-time excludes subs not yet started", async () => {
    const o = await getMoneyOverview(h.orgId, 6);
    const thisMonth = o.mrrSeries.find((p) => p.month === monthLabel(0));
    const lastMonth = o.mrrSeries.find((p) => p.month === monthLabel(1));
    expect(thisMonth?.pence).toBe(150_000);
    expect(lastMonth?.pence).toBe(100_000);
  });

  it("cash in counts only paid payments in the month", async () => {
    const o = await getMoneyOverview(h.orgId, 6);
    expect(o.cashInThisMonthPence).toBe(150_000);
    const last = o.cashInSeries.find((p) => p.month === monthLabel(1));
    expect(last?.pence).toBe(90_000);
  });

  it("cash out, recurring, net and coverage match the hand math", async () => {
    const o = await getMoneyOverview(h.orgId, 6);
    expect(o.cashOutThisMonthPence).toBe(7_200);
    expect(o.recurringExpensesMonthlyPence).toBe(6_200);
    expect(o.netThisMonthPence).toBe(142_800);
    expect(o.retainerCoverage).toBeCloseTo(24.19, 2);
  });
});
