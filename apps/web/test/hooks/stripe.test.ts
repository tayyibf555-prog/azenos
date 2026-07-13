import {
  closeDb,
  db,
  payments,
  projectIntegrations,
  subscriptions,
  webhookDeliveries,
} from "@azen/db";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cleanupHookHarness,
  createHookHarness,
  postStripe,
  readJson,
  stripeInvoiceEvent,
  stripeSubscriptionEvent,
  type HookHarness,
} from "./helpers";

describe("POST /api/hooks/stripe", () => {
  let h: HookHarness;

  beforeAll(async () => {
    h = await createHookHarness();
  });
  afterAll(async () => {
    await cleanupHookHarness(h);
    await closeDb();
  });

  it("writes an agency payment row on a valid invoice.paid", async () => {
    const event = stripeInvoiceEvent(h.clientId, {
      invoiceId: "in_paid_1",
      amountPence: 50_000,
      kind: "retainer",
      projectId: h.projectId,
    });
    const res = await postStripe(event);
    expect(res.status).toBe(200);
    expect((await readJson(res)).paymentRecorded).toBe(true);

    const rows = await db
      .select()
      .from(payments)
      .where(and(eq(payments.orgId, h.orgId), eq(payments.externalId, "in_paid_1")));
    expect(rows).toHaveLength(1);
    // hand-checked: amount_paid 50000p, source stripe, kind from metadata,
    // routed to the harness client + project via azen_project_id
    expect(rows[0]!.amountPence).toBe(50_000);
    expect(rows[0]!.source).toBe("stripe");
    expect(rows[0]!.kind).toBe("retainer");
    expect(rows[0]!.status).toBe("paid");
    expect(rows[0]!.clientId).toBe(h.clientId);
    expect(rows[0]!.projectId).toBe(h.projectId);
  });

  it("records a failed payment on invoice.payment_failed", async () => {
    const event = stripeInvoiceEvent(h.clientId, {
      type: "invoice.payment_failed",
      invoiceId: "in_failed_1",
      amountPence: 12_345,
    });
    const res = await postStripe(event);
    expect(res.status).toBe(200);
    const [row] = await db
      .select()
      .from(payments)
      .where(and(eq(payments.orgId, h.orgId), eq(payments.externalId, "in_failed_1")));
    expect(row!.status).toBe("failed");
    expect(row!.amountPence).toBe(12_345);
    expect(row!.paidAt).toBeNull();
  });

  it("rejects a bad signature with 400 and a rejected delivery", async () => {
    const event = stripeInvoiceEvent(h.clientId, { invoiceId: "in_badsig" });
    const res = await postStripe(event, { secret: "wrong_secret" });
    expect(res.status).toBe(400);

    // no payment written
    const paid = await db
      .select()
      .from(payments)
      .where(and(eq(payments.orgId, h.orgId), eq(payments.externalId, "in_badsig")));
    expect(paid).toHaveLength(0);

    // delivery logged as rejected, raw kept
    const rejected = (
      await db
        .select()
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.orgId, h.orgId))
    ).find((d) => d.status === "rejected" && d.error === "signature mismatch");
    expect(rejected).toBeDefined();
    expect(rejected!.httpStatus).toBe(400);
    expect(rejected!.raw).not.toBeNull();
  });

  it("upserts a subscription on customer.subscription.created", async () => {
    const event = stripeSubscriptionEvent(h.clientId, {
      subId: "sub_created_1",
      amountPenceMonthly: 30_000,
    });
    const res = await postStripe(event);
    expect(res.status).toBe(200);
    expect((await readJson(res)).subscriptionRecorded).toBe(true);

    const rows = await db
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.orgId, h.orgId),
          eq(subscriptions.stripeSubscriptionId, "sub_created_1"),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amountPenceMonthly).toBe(30_000);
    expect(rows[0]!.status).toBe("active");
    expect(rows[0]!.clientId).toBe(h.clientId);
  });

  it("maps subscription.deleted to a cancelled subscription", async () => {
    await postStripe(
      stripeSubscriptionEvent(h.clientId, { subId: "sub_life_1" }),
    );
    const res = await postStripe(
      stripeSubscriptionEvent(h.clientId, {
        type: "customer.subscription.deleted",
        subId: "sub_life_1",
        status: "canceled",
      }),
    );
    expect(res.status).toBe(200);
    const rows = await db
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.orgId, h.orgId),
          eq(subscriptions.stripeSubscriptionId, "sub_life_1"),
        ),
      );
    expect(rows).toHaveLength(1); // upsert, not a second row
    expect(rows[0]!.status).toBe("cancelled");
  });

  it("is idempotent: the same invoice externalId twice → one row", async () => {
    const event = stripeInvoiceEvent(h.clientId, { invoiceId: "in_dupe_1" });
    const first = await postStripe(event);
    expect((await readJson(first)).paymentRecorded).toBe(true);
    const second = await postStripe(event);
    expect((await readJson(second)).duplicate).toBe(true);

    const rows = await db
      .select()
      .from(payments)
      .where(and(eq(payments.orgId, h.orgId), eq(payments.externalId, "in_dupe_1")));
    expect(rows).toHaveLength(1);
  });

  it("TWO-LEDGER: a client end-customer payment.* shape is NOT an agency payment", async () => {
    // A taxonomy end-customer event (as ingested from a project), correctly
    // signed at the agency Stripe hook. It has no Stripe data.object and no
    // handled Stripe type — it must be ignored, never written to `payments`.
    const before = (
      await db.select().from(payments).where(eq(payments.orgId, h.orgId))
    ).length;
    const endCustomerEvent = {
      type: "payment.succeeded",
      occurred_at: new Date().toISOString(),
      idempotency_key: `evt:${Date.now()}`,
      subject: { name: "End Customer", email: "buyer@example.com" },
      data: { amount_pence: 4_999, currency: "gbp" },
    };
    const res = await postStripe(endCustomerEvent);
    // "payment.succeeded" is not a handled Stripe type → 200 ignored; the
    // agency `payments` ledger is untouched (two-ledger rule holds).
    expect(res.status).toBe(200);
    expect((await readJson(res)).ignored).toBe(true);
    const after = (
      await db.select().from(payments).where(eq(payments.orgId, h.orgId))
    ).length;
    expect(after).toBe(before);
  });

  it("ignores unknown Stripe event types with a 200", async () => {
    const res = await postStripe({
      id: "evt_unknown",
      type: "charge.dispute.created",
      data: { object: { id: "dp_1" } },
    });
    expect(res.status).toBe(200);
    expect((await readJson(res)).ignored).toBe(true);
  });

  it("skips (no crash) when no client matches the customer", async () => {
    const res = await postStripe({
      id: "evt_orphan",
      type: "invoice.paid",
      data: {
        object: {
          id: "in_orphan",
          object: "invoice",
          customer: "cus_nomatch",
          amount_paid: 1_000,
          currency: "gbp",
          metadata: {},
        },
      },
    });
    expect(res.status).toBe(200);
    expect((await readJson(res)).skipped).toBe(true);
    const rows = await db
      .select()
      .from(payments)
      .where(and(eq(payments.orgId, h.orgId), eq(payments.externalId, "in_orphan")));
    expect(rows).toHaveLength(0);
  });

  it("promotes a failed invoice to paid when a dunning retry succeeds", async () => {
    // invoice.payment_failed first (card declined), then invoice.paid for the
    // SAME invoice id — the collected cash must not be dropped as a duplicate.
    const failed = await postStripe(
      stripeInvoiceEvent(h.clientId, {
        type: "invoice.payment_failed",
        invoiceId: "in_dunning_1",
        amountPence: 12_345,
        kind: "retainer",
        projectId: h.projectId,
      }),
    );
    expect((await readJson(failed)).paymentRecorded).toBe(true);

    const paid = await postStripe(
      stripeInvoiceEvent(h.clientId, {
        invoiceId: "in_dunning_1",
        amountPence: 50_000,
        kind: "retainer",
        projectId: h.projectId,
      }),
    );
    expect(paid.status).toBe(200);
    expect((await readJson(paid)).paymentRecorded).toBe(true);

    // exactly one row, now paid with the collected amount + a paidAt
    const rows = await db
      .select()
      .from(payments)
      .where(
        and(eq(payments.orgId, h.orgId), eq(payments.externalId, "in_dunning_1")),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("paid");
    expect(rows[0]!.amountPence).toBe(50_000);
    expect(rows[0]!.paidAt).not.toBeNull();
  });

  it("normalizes a yearly price to a monthly MRR figure", async () => {
    // £6000/yr retainer must store £500/mo, not £6000/mo (no 12× MRR inflation)
    const res = await postStripe(
      stripeSubscriptionEvent(h.clientId, {
        subId: "sub_yearly_1",
        amountPenceMonthly: 600_000,
        interval: "year",
      }),
    );
    expect(res.status).toBe(200);
    const [row] = await db
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.orgId, h.orgId),
          eq(subscriptions.stripeSubscriptionId, "sub_yearly_1"),
        ),
      );
    expect(row!.amountPenceMonthly).toBe(50_000);
  });

  it("routes via project_integrations when metadata is absent", async () => {
    // The primary real-world path: no azen_* metadata, resolved by the Stripe
    // customer → project_integrations mapping.
    const customerId = `cus_${randomUUID().slice(0, 12)}`;
    await db.insert(projectIntegrations).values({
      orgId: h.orgId,
      projectId: h.projectId,
      provider: "stripe",
      externalId: customerId,
    });
    const res = await postStripe({
      id: "evt_pi_route",
      type: "invoice.paid",
      data: {
        object: {
          id: "in_pi_route",
          object: "invoice",
          customer: customerId,
          amount_paid: 7_500,
          currency: "gbp",
          status_transitions: { paid_at: Math.floor(Date.now() / 1000) },
          metadata: {},
        },
      },
    });
    expect(res.status).toBe(200);
    expect((await readJson(res)).paymentRecorded).toBe(true);
    const [row] = await db
      .select()
      .from(payments)
      .where(
        and(eq(payments.orgId, h.orgId), eq(payments.externalId, "in_pi_route")),
      );
    expect(row!.clientId).toBe(h.clientId);
    expect(row!.projectId).toBe(h.projectId);
    expect(row!.amountPence).toBe(7_500);
  });

  it("rejects a stale (out-of-replay-window) timestamp with 400", async () => {
    // A correctly-signed body but a timestamp 10min old (> ±5min window) must
    // be rejected — otherwise a captured signed payload could be replayed.
    const staleT = Math.floor(Date.now() / 1000) - 600;
    const res = await postStripe(
      stripeInvoiceEvent(h.clientId, { invoiceId: "in_stale" }),
      { timestampS: staleT },
    );
    expect(res.status).toBe(400);
    const paid = await db
      .select()
      .from(payments)
      .where(and(eq(payments.orgId, h.orgId), eq(payments.externalId, "in_stale")));
    expect(paid).toHaveLength(0);
    const rejected = (
      await db
        .select()
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.orgId, h.orgId))
    ).find((d) => d.status === "rejected" && d.error === "signature stale");
    expect(rejected).toBeDefined();
    expect(rejected!.httpStatus).toBe(400);
  });

  it("concurrent duplicate invoice.paid deliveries → exactly one row", async () => {
    const event = stripeInvoiceEvent(h.clientId, {
      invoiceId: "in_race_1",
      amountPence: 25_000,
      projectId: h.projectId,
    });
    const [a, b] = await Promise.all([postStripe(event), postStripe(event)]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const rows = await db
      .select()
      .from(payments)
      .where(and(eq(payments.orgId, h.orgId), eq(payments.externalId, "in_race_1")));
    expect(rows).toHaveLength(1);
  });

  it("concurrent subscription.created deliveries → exactly one row", async () => {
    const event = stripeSubscriptionEvent(h.clientId, {
      subId: "sub_race_1",
      amountPenceMonthly: 40_000,
    });
    await Promise.all([postStripe(event), postStripe(event)]);
    const rows = await db
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.orgId, h.orgId),
          eq(subscriptions.stripeSubscriptionId, "sub_race_1"),
        ),
      );
    expect(rows).toHaveLength(1);
  });
});
