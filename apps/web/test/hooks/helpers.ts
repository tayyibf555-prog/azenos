import { randomUUID } from "node:crypto";
import {
  bookings,
  clients,
  db,
  organizations,
  payments,
  projectIntegrations,
  projects,
  subscriptions,
  users,
  webhookDeliveries,
} from "@azen/db";
import { eq } from "drizzle-orm";
import { signHookBody } from "../../lib/server/hooks/verify";

export const STRIPE_SECRET = "whsec_test_stripe_secret";
export const CALENDLY_SECRET = "whsec_test_calendly_secret";

export interface HookHarness {
  orgId: string;
  userId: string;
  clientId: string;
  projectId: string;
}

/**
 * Throwaway agency org for the hook tests. The Stripe/Calendly hooks resolve
 * the agency org from AZEN_AGENCY_ORG_ID (config, not payload) — point it at
 * this org so nothing ever touches DEMO_ORG_ID.
 */
export async function createHookHarness(): Promise<HookHarness> {
  const orgId = randomUUID();
  const userId = randomUUID();
  const clientId = randomUUID();
  const projectId = randomUUID();
  const name = `Hooks Test ${orgId.slice(0, 8)}`;

  await db.insert(organizations).values({ id: orgId, name });
  await db.insert(users).values({
    id: userId,
    orgId,
    name: "Hooks Owner",
    email: `owner+${orgId.slice(0, 8)}@test.example`,
  });
  await db.insert(clients).values({
    id: clientId,
    orgId,
    name: "Hooks Client",
    status: "active",
  });
  await db.insert(projects).values({
    id: projectId,
    orgId,
    clientId,
    name,
    slug: `hooks-test-${randomUUID()}`,
    type: "ai_agent",
    status: "live",
  });

  process.env.AZEN_AGENCY_ORG_ID = orgId;
  process.env.STRIPE_WEBHOOK_SECRET = STRIPE_SECRET;
  process.env.CALENDLY_WEBHOOK_SIGNING_KEY = CALENDLY_SECRET;

  return { orgId, userId, clientId, projectId };
}

export async function cleanupHookHarness(h: HookHarness): Promise<void> {
  await db.delete(webhookDeliveries).where(eq(webhookDeliveries.orgId, h.orgId));
  await db.delete(payments).where(eq(payments.orgId, h.orgId));
  await db.delete(subscriptions).where(eq(subscriptions.orgId, h.orgId));
  await db.delete(bookings).where(eq(bookings.orgId, h.orgId));
  await db
    .delete(projectIntegrations)
    .where(eq(projectIntegrations.orgId, h.orgId));
  await db.delete(projects).where(eq(projects.orgId, h.orgId));
  await db.delete(clients).where(eq(clients.orgId, h.orgId));
  await db.delete(users).where(eq(users.orgId, h.orgId));
  await db.delete(organizations).where(eq(organizations.id, h.orgId));
  delete process.env.AZEN_AGENCY_ORG_ID;
}

interface StripeSendOptions {
  secret?: string;
  /** Send this exact header value instead of a freshly computed signature. */
  signatureOverride?: string;
  timestampS?: number;
}

export function postStripe(
  body: unknown,
  opts: StripeSendOptions = {},
): Promise<Response> {
  const raw = JSON.stringify(body);
  const headers = new Headers({ "content-type": "application/json" });
  const sig =
    opts.signatureOverride ??
    signHookBody(opts.secret ?? STRIPE_SECRET, raw, opts.timestampS);
  headers.set("stripe-signature", sig);
  return import("../../app/api/hooks/stripe/route").then((m) =>
    m.POST(
      new Request("http://test.local/api/hooks/stripe", {
        method: "POST",
        headers,
        body: raw,
      }),
    ),
  );
}

export function postCalendly(
  body: unknown,
  opts: StripeSendOptions = {},
): Promise<Response> {
  const raw = JSON.stringify(body);
  const headers = new Headers({ "content-type": "application/json" });
  const sig =
    opts.signatureOverride ??
    signHookBody(opts.secret ?? CALENDLY_SECRET, raw, opts.timestampS);
  headers.set("calendly-webhook-signature", sig);
  return import("../../app/api/hooks/calendly/route").then((m) =>
    m.POST(
      new Request("http://test.local/api/hooks/calendly", {
        method: "POST",
        headers,
        body: raw,
      }),
    ),
  );
}

export function stripeInvoiceEvent(
  clientId: string,
  opts: {
    type?: string;
    invoiceId?: string;
    amountPence?: number;
    kind?: string;
    projectId?: string;
  } = {},
): Record<string, unknown> {
  const stamp = Date.now();
  const metadata: Record<string, string> = { azen_client_id: clientId };
  if (opts.kind) metadata.azen_kind = opts.kind;
  if (opts.projectId) metadata.azen_project_id = opts.projectId;
  return {
    id: `evt_${randomUUID()}`,
    type: opts.type ?? "invoice.paid",
    data: {
      object: {
        id: opts.invoiceId ?? `in_${randomUUID()}`,
        object: "invoice",
        customer: `cus_${clientId.slice(0, 8)}`,
        number: `INV-${stamp}`,
        currency: "gbp",
        amount_paid: opts.amountPence ?? 50_000,
        amount_due: opts.amountPence ?? 50_000,
        status_transitions: { paid_at: Math.floor(stamp / 1000) },
        metadata,
      },
    },
  };
}

export function stripeSubscriptionEvent(
  clientId: string,
  opts: {
    type?: string;
    subId?: string;
    /** Raw Stripe price unit_amount (per the interval below, default monthly). */
    amountPenceMonthly?: number;
    status?: string;
    /** price.recurring.interval — omit for a plain monthly price (no recurring). */
    interval?: string;
    intervalCount?: number;
  } = {},
): Record<string, unknown> {
  const price: Record<string, unknown> = {
    unit_amount: opts.amountPenceMonthly ?? 30_000,
  };
  if (opts.interval) {
    price.recurring = {
      interval: opts.interval,
      interval_count: opts.intervalCount ?? 1,
    };
  }
  return {
    id: `evt_${randomUUID()}`,
    type: opts.type ?? "customer.subscription.created",
    data: {
      object: {
        id: opts.subId ?? `sub_${randomUUID()}`,
        object: "subscription",
        customer: `cus_${clientId.slice(0, 8)}`,
        status: opts.status ?? "active",
        start_date: Math.floor(Date.now() / 1000),
        items: { data: [{ price }] },
        metadata: { azen_client_id: clientId },
      },
    },
  };
}

export function calendlyEvent(
  opts: {
    type?: string;
    inviteeUri?: string;
    eventName?: string;
    invitee?: string;
  } = {},
): Record<string, unknown> {
  const stamp = Date.now();
  const uri =
    opts.inviteeUri ??
    `https://api.calendly.com/scheduled_events/${randomUUID()}/invitees/${randomUUID()}`;
  const start = new Date(stamp + 24 * 3_600_000);
  return {
    event: opts.type ?? "invitee.created",
    payload: {
      uri,
      name: opts.invitee ?? "Jamie Prospect",
      email: "jamie@prospect.example",
      scheduled_event: {
        uri: `https://api.calendly.com/scheduled_events/${randomUUID()}`,
        name: opts.eventName ?? "Discovery Call",
        start_time: start.toISOString(),
        end_time: new Date(start.getTime() + 30 * 60_000).toISOString(),
      },
    },
  };
}

export async function readJson<T = Record<string, unknown>>(
  res: Response,
): Promise<T> {
  return (await res.json()) as T;
}
