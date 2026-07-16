import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getClientMargins, setClientMarkup } from "../../lib/server/money";
import {
  createMoneyHarness,
  cleanupMoneyHarness,
  dayInMonth,
  type MoneyHarness,
} from "../money/helpers";
import { insertAgentRun, insertSubscription } from "./helpers";

/**
 * Margin per client (P9-COST). LEAD RULING 2026-07-16 (B): margin = retainer +
 * billable markup spread over the streams billed under the statement default;
 * the reimbursed cost is NOT subtracted (the statement bills it back). Fully
 * determined by the fixture: retainer £1000/mo, 20% markup, OS £10 this month /
 * £5 last month (no client-system AI rollup → markup is on OS alone).
 */
describe("getClientMargins", () => {
  let h: MoneyHarness;

  beforeEach(async () => {
    h = await createMoneyHarness();
    await insertSubscription({ orgId: h.orgId, clientId: h.clientId, amountPenceMonthly: 100_000 });
    await setClientMarkup(h.orgId, h.clientId, 20);
    // OS cost: £10 this month, £5 prior month.
    await insertAgentRun({ orgId: h.orgId, clientId: h.clientId, projectId: h.projectId, agent: "daily_brief", startedAt: dayInMonth(0), costEstimatePence: 1_000 });
    await insertAgentRun({ orgId: h.orgId, clientId: h.clientId, projectId: h.projectId, agent: "daily_brief", startedAt: dayInMonth(1), costEstimatePence: 500 });
  });

  afterEach(async () => {
    await cleanupMoneyHarness(h);
  });

  it("computes retainer + markup (reimbursed cost billed back) for MTD and prior", async () => {
    const { rows } = await getClientMargins(h.orgId);
    const m = rows.find((r) => r.clientId === h.clientId)!;

    expect(m.retainerPence).toBe(100_000);
    expect(m.markupPct).toBe(20);

    // MTD: markup = round(1000×1.2) − 1000 = 200; margin = 100000 + 200 = £1002.
    expect(m.mtd.osCostPence).toBe(1_000);
    expect(m.mtd.markupPence).toBe(200);
    expect(m.mtd.marginPence).toBe(100_200);

    // Prior: markup = round(500×1.2) − 500 = 100; margin = 100000 + 100 = £1001.
    expect(m.prior.osCostPence).toBe(500);
    expect(m.prior.markupPence).toBe(100);
    expect(m.prior.marginPence).toBe(100_100);
  });

  it("returns zero-cost period cleanly when a client has no OS spend", async () => {
    const h2 = await createMoneyHarness();
    await insertSubscription({ orgId: h2.orgId, clientId: h2.clientId, amountPenceMonthly: 50_000 });
    const { rows } = await getClientMargins(h2.orgId);
    const m = rows.find((r) => r.clientId === h2.clientId)!;
    expect(m.mtd.osCostPence).toBe(0);
    expect(m.mtd.markupPence).toBe(0);
    expect(m.mtd.marginPence).toBe(50_000); // retainer only
    await cleanupMoneyHarness(h2);
  });
});
