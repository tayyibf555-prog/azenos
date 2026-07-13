import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, payments, projects, subscriptions } from "@azen/db";
import { getRetainers } from "../../lib/server/money";
import {
  cleanupMoneyHarness,
  createMoneyHarness,
  dayInMonth,
  monthStartIso,
  type MoneyHarness,
} from "./helpers";

/**
 * Retainer expected-vs-received: project P is paid in full this month (not
 * overdue); project Q's active retainer has NO payment this month → overdue,
 * shortfall = its full expected amount.
 */
describe("getRetainers", () => {
  let h: MoneyHarness;
  let projectQ: string;

  beforeAll(async () => {
    h = await createMoneyHarness();
    projectQ = randomUUID();
    await db.insert(projects).values({
      id: projectQ,
      orgId: h.orgId,
      clientId: h.clientId,
      name: "Project Q",
      slug: `money-q-${randomUUID()}`,
      type: "automation",
      status: "live",
      retainerPenceMonthly: 75_000,
    });
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
        projectId: projectQ,
        amountPenceMonthly: 75_000,
        status: "active",
        startedAt: monthStartIso(3),
      },
    ]);
    // Only P is paid this month.
    await db.insert(payments).values({
      orgId: h.orgId,
      clientId: h.clientId,
      projectId: h.projectId,
      source: "stripe",
      kind: "retainer",
      amountPence: 100_000,
      status: "paid",
      paidAt: dayInMonth(0),
    });
  });

  afterAll(async () => {
    await cleanupMoneyHarness(h);
  });

  it("flags the unpaid retainer as overdue and reconciles the paid one", async () => {
    const r = await getRetainers(h.orgId);
    const p = r.rows.find((row) => row.projectId === h.projectId);
    const q = r.rows.find((row) => row.projectId === projectQ);

    expect(p?.expectedPence).toBe(100_000);
    expect(p?.receivedPence).toBe(100_000);
    expect(p?.overdue).toBe(false);
    expect(p?.shortfallPence).toBe(0);

    expect(q?.expectedPence).toBe(75_000);
    expect(q?.receivedPence).toBe(0);
    expect(q?.overdue).toBe(true);
    expect(q?.shortfallPence).toBe(75_000);

    expect(r.totals.expectedPence).toBe(175_000);
    expect(r.totals.receivedPence).toBe(100_000);
    expect(r.totals.overdueCount).toBe(1);
    expect(r.totals.overduePence).toBe(75_000);
  });
});
