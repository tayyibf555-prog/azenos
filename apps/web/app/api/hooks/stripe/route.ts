import { db, payments, subscriptions } from "@azen/db";
import { and, eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { jsonError } from "../../../../lib/server/http";
import {
  recordHookDelivery,
  resolveAgencyOrgId,
  resolveClientRoute,
} from "../../../../lib/server/hooks/shared";
import { verifyStripeSignature } from "../../../../lib/server/hooks/verify";

export const runtime = "nodejs";

/**
 * Org-level agency Stripe webhook (§P4-HOOKS). Verifies the `Stripe-Signature`
 * header, then writes to the AGENCY ledger only:
 *   invoice.paid / invoice.payment_failed → `payments` (idempotent on
 *   externalId), customer.subscription.* → `subscriptions` (upsert on the
 *   Stripe subscription id).
 *
 * TWO-LEDGER RULE (§6.3/§10): this only accepts real Stripe event envelopes
 * for the handled types. A client end-customer taxonomy `payment.*` shape has
 * no Stripe `data.object` and no handled Stripe type, so it is ignored (200) —
 * it can never become an agency payment. Bad signature → 400 + rejected
 * delivery. Unknown/unhandled Stripe types → 200 ignored.
 */

// Real Stripe amounts are in the smallest currency unit — pennies for GBP —
// so they map straight onto our integer-pence columns.
const stripeMetadata = z.record(z.string(), z.string()).optional();

const invoiceObject = z.object({
  id: z.string(),
  object: z.literal("invoice").optional(),
  customer: z.string().nullish(),
  number: z.string().nullish(),
  currency: z.string().nullish(),
  amount_paid: z.number().int().nonnegative().nullish(),
  amount_due: z.number().int().nonnegative().nullish(),
  metadata: stripeMetadata,
  created: z.number().nullish(),
  status_transitions: z.object({ paid_at: z.number().nullish() }).nullish(),
});

// A price bills on a recurring interval (day/week/month/year × interval_count);
// amountPenceMonthly is a MONTHLY figure feeding MRR, so we must capture the
// interval to normalize a non-monthly price rather than store it verbatim.
const recurring = z
  .object({
    interval: z.string().nullish(),
    interval_count: z.number().int().positive().nullish(),
  })
  .nullish();
const subscriptionItem = z.object({
  price: z
    .object({ unit_amount: z.number().int().nullish(), recurring })
    .nullish(),
  plan: z
    .object({
      amount: z.number().int().nullish(),
      interval: z.string().nullish(),
      interval_count: z.number().int().positive().nullish(),
    })
    .nullish(),
});
const subscriptionObject = z.object({
  id: z.string(),
  object: z.literal("subscription").optional(),
  customer: z.string().nullish(),
  status: z.string(),
  start_date: z.number().nullish(),
  created: z.number().nullish(),
  canceled_at: z.number().nullish(),
  metadata: stripeMetadata,
  items: z.object({ data: z.array(subscriptionItem) }).nullish(),
});

const stripeEnvelope = z.object({
  id: z.string().optional(),
  type: z.string(),
  // object is validated per-handled-type; keep it optional here so an
  // unhandled event (or a non-Stripe payment.* shape) routes to 200-ignored
  // rather than an envelope error.
  data: z.object({ object: z.unknown().optional() }).optional(),
});

const PAYMENT_KINDS = ["build_fee", "retainer", "deposit", "other"] as const;
type PaymentKind = (typeof PAYMENT_KINDS)[number];
function toPaymentKind(value: string | undefined): PaymentKind {
  return (PAYMENT_KINDS as readonly string[]).includes(value ?? "")
    ? (value as PaymentKind)
    : "other";
}

type SubStatus = "active" | "past_due" | "paused" | "cancelled";
function toSubStatus(stripeStatus: string): SubStatus {
  switch (stripeStatus) {
    case "canceled":
    case "incomplete_expired":
      return "cancelled";
    case "past_due":
    case "unpaid":
      return "past_due";
    case "paused":
      return "paused";
    default:
      return "active";
  }
}

// Months contained in one billing interval; used to normalize a price amount
// to a per-month figure for MRR (a yearly retainer must not read as 12× MRR).
const MONTHS_PER_INTERVAL: Record<string, number> = {
  day: 12 / 365,
  week: 12 / 52,
  month: 1,
  year: 12,
};
function toMonthlyPence(
  amount: number,
  interval: string | null | undefined,
  intervalCount: number | null | undefined,
): number {
  const months =
    (MONTHS_PER_INTERVAL[interval ?? "month"] ?? 1) * (intervalCount ?? 1);
  // integer pence out; fall back to the raw amount if the interval is unknown
  return months > 0 ? Math.round(amount / months) : amount;
}

function unixToDate(unix: number | null | undefined): Date {
  return unix ? new Date(unix * 1000) : new Date();
}
function unixToDateStr(unix: number | null | undefined): string {
  return unixToDate(unix).toISOString().slice(0, 10);
}

export async function POST(req: Request): Promise<NextResponse> {
  const startedAt = performance.now();
  const orgId = resolveAgencyOrgId();
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  const raw = await req.text();

  // graceful degradation: no configured secret = clean typed error, no crash
  if (!secret) {
    console.error("[hooks/stripe] STRIPE_WEBHOOK_SECRET not configured");
    return jsonError(503, "stripe_not_configured");
  }

  const verified = verifyStripeSignature(
    secret,
    raw,
    req.headers.get("stripe-signature"),
  );
  if (!verified.ok) {
    console.error(`[hooks/stripe] signature ${verified.reason}`);
    await recordHookDelivery({
      orgId,
      status: "rejected",
      httpStatus: 400,
      startedAt,
      error: `signature ${verified.reason}`,
      raw: safeJson(raw),
    });
    return jsonError(400, "invalid_signature");
  }

  const parsed = stripeEnvelope.safeParse(safeJson(raw));
  if (!parsed.success) {
    // valid signature but not a Stripe event envelope — nothing to write
    console.error("[hooks/stripe] malformed event envelope");
    await recordHookDelivery({
      orgId,
      status: "rejected",
      httpStatus: 400,
      startedAt,
      error: "malformed_event",
      raw: safeJson(raw),
    });
    return jsonError(400, "malformed_event");
  }

  const event = parsed.data;
  try {
    const outcome = await handleStripeEvent(orgId, event);
    await recordHookDelivery({
      orgId,
      status: "accepted",
      httpStatus: 200,
      startedAt,
      error: outcome.note,
    });
    return NextResponse.json({ received: true, ...outcome.body });
  } catch (err) {
    console.error("[hooks/stripe] handler error:", err);
    return jsonError(500, "internal_error");
  }
}

interface Outcome {
  note: string | null;
  body: Record<string, unknown>;
}

async function handleStripeEvent(
  orgId: string,
  event: z.infer<typeof stripeEnvelope>,
): Promise<Outcome> {
  const object = event.data?.object;
  switch (event.type) {
    case "invoice.paid":
      return recordInvoice(orgId, object, "paid");
    case "invoice.payment_failed":
      return recordInvoice(orgId, object, "failed");
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      return upsertSubscription(orgId, object, event.type);
    default:
      return { note: `ignored ${event.type}`, body: { ignored: true } };
  }
}

async function recordInvoice(
  orgId: string,
  object: unknown,
  outcome: "paid" | "failed",
): Promise<Outcome> {
  const inv = invoiceObject.safeParse(object);
  if (!inv.success) return { note: "invoice parse failed", body: { ignored: true } };
  const invoice = inv.data;

  const route = await resolveClientRoute(orgId, {
    customerId: invoice.customer,
    clientId: invoice.metadata?.azen_client_id,
    projectId: invoice.metadata?.azen_project_id,
  });
  if (!route) {
    console.error(
      `[hooks/stripe] invoice ${invoice.id}: no client match (customer=${invoice.customer ?? "?"}) — skipped`,
    );
    return { note: `no client match for invoice ${invoice.id}`, body: { skipped: true } };
  }

  const amountPence =
    outcome === "paid"
      ? (invoice.amount_paid ?? invoice.amount_due ?? 0)
      : (invoice.amount_due ?? invoice.amount_paid ?? 0);
  // paid_at is the true payment time; fall back to the invoice's own `created`
  // (still lands in the correct reporting period) rather than the ingestion
  // moment, which would mis-attribute a late-arriving webhook to "now".
  const paidAt =
    outcome === "paid"
      ? unixToDate(invoice.status_transitions?.paid_at ?? invoice.created)
      : null;

  // Idempotent on externalId within the agency ledger. There is no unique index
  // (lead-owned schema), so serialize concurrent deliveries for the same invoice
  // with a transaction-scoped advisory lock keyed on (org, source, externalId):
  // this closes the check-then-insert race that Stripe's at-least-once (and
  // possibly concurrent) delivery would otherwise leave open. Inside the lock we
  // also promote a prior 'failed' row to 'paid' when a dunning retry finally
  // succeeds (failed→paid), so genuinely-collected cash is never dropped as a
  // "duplicate".
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`${orgId}:stripe:${invoice.id}`}))`,
    );
    const existing = await tx
      .select({ id: payments.id, status: payments.status })
      .from(payments)
      .where(
        and(
          eq(payments.orgId, orgId),
          eq(payments.source, "stripe"),
          eq(payments.externalId, invoice.id),
        ),
      );
    if (existing.length > 0) {
      const row = existing[0]!;
      if (outcome === "paid" && row.status !== "paid") {
        // dunning retry succeeded → promote failed→paid (never downgrade a paid)
        await tx
          .update(payments)
          .set({
            status: "paid",
            amountPence,
            paidAt,
            invoiceRef: invoice.number ?? invoice.id,
          })
          .where(eq(payments.id, row.id));
        return {
          note: `invoice ${invoice.id} failed→paid`,
          body: { paymentRecorded: true },
        };
      }
      return { note: `duplicate invoice ${invoice.id}`, body: { duplicate: true } };
    }

    await tx.insert(payments).values({
      orgId,
      clientId: route.clientId,
      projectId: route.projectId,
      source: "stripe",
      kind: toPaymentKind(invoice.metadata?.azen_kind),
      amountPence,
      currency: (invoice.currency ?? "gbp").toLowerCase().slice(0, 3),
      status: outcome === "paid" ? "paid" : "failed",
      externalId: invoice.id,
      invoiceRef: invoice.number ?? invoice.id,
      paidAt,
    });
    return {
      note: `invoice ${invoice.id} ${outcome}`,
      body: { paymentRecorded: true },
    };
  });
}

async function upsertSubscription(
  orgId: string,
  object: unknown,
  eventType: string,
): Promise<Outcome> {
  const sub = subscriptionObject.safeParse(object);
  if (!sub.success) {
    return { note: "subscription parse failed", body: { ignored: true } };
  }
  const subscription = sub.data;

  const route = await resolveClientRoute(orgId, {
    customerId: subscription.customer,
    clientId: subscription.metadata?.azen_client_id,
    projectId: subscription.metadata?.azen_project_id,
  });
  if (!route) {
    console.error(
      `[hooks/stripe] subscription ${subscription.id}: no client match — skipped`,
    );
    return {
      note: `no client match for subscription ${subscription.id}`,
      body: { skipped: true },
    };
  }

  const status =
    eventType === "customer.subscription.deleted"
      ? "cancelled"
      : toSubStatus(subscription.status);
  const item = subscription.items?.data[0];
  const rawAmount = item?.price?.unit_amount ?? item?.plan?.amount ?? 0;
  const interval = item?.price?.recurring?.interval ?? item?.plan?.interval;
  const intervalCount =
    item?.price?.recurring?.interval_count ?? item?.plan?.interval_count;
  const amountPenceMonthly = toMonthlyPence(rawAmount, interval, intervalCount);
  const startedAt = unixToDateStr(subscription.start_date ?? subscription.created);
  const cancelledAt =
    status === "cancelled"
      ? unixToDateStr(subscription.canceled_at ?? undefined)
      : null;

  // Same race as the invoice path: no unique index on (org, stripeSubscriptionId),
  // so serialize concurrent deliveries for this subscription with a
  // transaction-scoped advisory lock before the check-then-upsert.
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`${orgId}:stripe-sub:${subscription.id}`}))`,
    );
    const existing = await tx
      .select({ id: subscriptions.id })
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.orgId, orgId),
          eq(subscriptions.stripeSubscriptionId, subscription.id),
        ),
      );

    if (existing.length > 0) {
      await tx
        .update(subscriptions)
        .set({ status, amountPenceMonthly, cancelledAt })
        .where(eq(subscriptions.id, existing[0]!.id));
      return {
        note: `subscription ${subscription.id} updated`,
        body: { subscriptionUpdated: true },
      };
    }

    await tx.insert(subscriptions).values({
      orgId,
      clientId: route.clientId,
      projectId: route.projectId,
      stripeSubscriptionId: subscription.id,
      amountPenceMonthly,
      status,
      startedAt,
      cancelledAt,
    });
    return {
      note: `subscription ${subscription.id} created`,
      body: { subscriptionRecorded: true },
    };
  });
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
