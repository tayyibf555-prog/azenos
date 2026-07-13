import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, events, payments } from "@azen/db";
import { getRevenueByClient } from "../../lib/server/money";
import {
  cleanupMoneyHarness,
  createMoneyHarness,
  dayInMonth,
  type MoneyHarness,
} from "./helpers";

/**
 * THE TWO-LEDGER RULE (§6.3/§10). Client END-CUSTOMER `payment.*` events live
 * in `events` and must NEVER be counted as agency revenue. Here the client's
 * project has a fat end-customer payment event; by-client revenue must reflect
 * only the AGENCY payment (the client paying Azen).
 */
describe("two-ledger: by-client revenue excludes end-customer payments", () => {
  let h: MoneyHarness;

  beforeAll(async () => {
    h = await createMoneyHarness();
    // Agency ledger: the client paid Azen a build fee.
    await db.insert(payments).values({
      orgId: h.orgId,
      clientId: h.clientId,
      projectId: h.projectId,
      source: "bank_transfer",
      kind: "build_fee",
      amountPence: 500_000,
      status: "paid",
      paidAt: dayInMonth(0),
    });
    // End-customer ledger: a customer paid the CLIENT's system £9,999.99.
    // This is an `events` row and must never surface as agency revenue.
    await db.insert(events).values({
      orgId: h.orgId,
      projectId: h.projectId,
      type: "payment.received",
      source: "sdk",
      idempotencyKey: `endcust:${randomUUID()}`,
      occurredAt: dayInMonth(0),
      valuePence: 999_999,
      data: { amount_pence: 999_999 },
      raw: { end_customer: true },
    });
  });

  afterAll(async () => {
    await cleanupMoneyHarness(h);
  });

  it("counts only the agency payment", async () => {
    const { clients } = await getRevenueByClient(h.orgId);
    const c = clients.find((x) => x.clientId === h.clientId)!;
    expect(c.ltvPence).toBe(500_000);
    expect(c.paidThisMonthPence).toBe(500_000);
    // The £9,999.99 end-customer event is nowhere in the agency ledger.
    expect(c.ltvPence).not.toBe(1_499_999);
  });
});
