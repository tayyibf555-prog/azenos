import { bookings, db } from "@azen/db";
import { and, eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { jsonError } from "../../../../lib/server/http";
import {
  recordHookDelivery,
  resolveAgencyOrgId,
} from "../../../../lib/server/hooks/shared";
import { verifyCalendlySignature } from "../../../../lib/server/hooks/verify";

export const runtime = "nodejs";

/**
 * Org-level agency Calendly webhook (§P4-HOOKS). Verifies the
 * `Calendly-Webhook-Signature` header, then maps agency-calendar events onto
 * the `bookings` table (source 'calendly', no project — these are Tayyib's
 * discovery/kickoff/review calls):
 *   invitee.created  → a scheduled booking (kind from the event-type name)
 *   invitee.canceled → flip the matching booking to 'cancelled'
 * Bad signature → 400 + rejected delivery. Other event types → 200 ignored.
 */

const scheduledEvent = z.object({
  uri: z.string().nullish(),
  name: z.string().nullish(),
  start_time: z.string().nullish(),
  end_time: z.string().nullish(),
});
const calendlyPayload = z.object({
  uri: z.string().nullish(),
  name: z.string().nullish(),
  email: z.string().nullish(),
  scheduled_event: scheduledEvent.nullish(),
});
const calendlyEnvelope = z.object({
  event: z.string(),
  payload: calendlyPayload,
});

type BookingKind = "discovery" | "kickoff" | "review";
function toBookingKind(eventName: string | null | undefined): BookingKind {
  const name = (eventName ?? "").toLowerCase();
  if (name.includes("kickoff") || name.includes("kick off") || name.includes("kick-off")) {
    return "kickoff";
  }
  if (name.includes("review")) return "review";
  return "discovery"; // default (§P4-HOOKS)
}

export async function POST(req: Request): Promise<NextResponse> {
  const startedAt = performance.now();
  const orgId = resolveAgencyOrgId();
  const secret = process.env.CALENDLY_WEBHOOK_SIGNING_KEY;
  const raw = await req.text();

  if (!secret) {
    console.error("[hooks/calendly] CALENDLY_WEBHOOK_SIGNING_KEY not configured");
    return jsonError(503, "calendly_not_configured");
  }

  const verified = verifyCalendlySignature(
    secret,
    raw,
    req.headers.get("calendly-webhook-signature"),
  );
  if (!verified.ok) {
    console.error(`[hooks/calendly] signature ${verified.reason}`);
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

  const parsed = calendlyEnvelope.safeParse(safeJson(raw));
  if (!parsed.success) {
    console.error("[hooks/calendly] malformed event envelope");
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

  try {
    const outcome = await handleCalendlyEvent(orgId, parsed.data);
    await recordHookDelivery({
      orgId,
      status: "accepted",
      httpStatus: 200,
      startedAt,
      error: outcome.note,
    });
    return NextResponse.json({ received: true, ...outcome.body });
  } catch (err) {
    console.error("[hooks/calendly] handler error:", err);
    return jsonError(500, "internal_error");
  }
}

interface Outcome {
  note: string | null;
  body: Record<string, unknown>;
}

async function handleCalendlyEvent(
  orgId: string,
  event: z.infer<typeof calendlyEnvelope>,
): Promise<Outcome> {
  switch (event.event) {
    case "invitee.created":
      return createBooking(orgId, event.payload);
    case "invitee.canceled":
      return cancelBooking(orgId, event.payload);
    default:
      return { note: `ignored ${event.event}`, body: { ignored: true } };
  }
}

// Stable per-booking identity across created↔canceled: the invitee uri, with
// the scheduled-event uri as fallback for payloads that omit it.
function externalIdOf(payload: z.infer<typeof calendlyPayload>): string | null {
  return payload.uri ?? payload.scheduled_event?.uri ?? null;
}

async function createBooking(
  orgId: string,
  payload: z.infer<typeof calendlyPayload>,
): Promise<Outcome> {
  const startTime = payload.scheduled_event?.start_time;
  if (!startTime) {
    return { note: "missing start_time", body: { ignored: true } };
  }
  const externalId = externalIdOf(payload);

  const values = {
    orgId,
    clientId: null,
    projectId: null,
    source: "calendly" as const,
    kind: toBookingKind(payload.scheduled_event?.name),
    invitee: {
      name: payload.name ?? null,
      email: payload.email ?? null,
      uri: payload.uri ?? null,
    },
    startsAt: new Date(startTime),
    endsAt: payload.scheduled_event?.end_time
      ? new Date(payload.scheduled_event.end_time)
      : null,
    status: "scheduled" as const,
    externalId,
    raw: payload,
  };

  // No externalId → no way to dedup; just insert.
  if (!externalId) {
    await db.insert(bookings).values(values);
    return { note: "booking created", body: { bookingCreated: true } };
  }

  // Idempotent: a repeated invitee.created for the same booking is a no-op.
  // No unique index on (org, source, externalId), so serialize concurrent
  // deliveries for this invitee with a transaction-scoped advisory lock before
  // the check-then-insert (closes the duplicate-booking race).
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`${orgId}:calendly:${externalId}`}))`,
    );
    const existing = await tx
      .select({ id: bookings.id })
      .from(bookings)
      .where(
        and(
          eq(bookings.orgId, orgId),
          eq(bookings.source, "calendly"),
          eq(bookings.externalId, externalId),
        ),
      );
    if (existing.length > 0) {
      return { note: `duplicate booking ${externalId}`, body: { duplicate: true } };
    }
    await tx.insert(bookings).values(values);
    return { note: "booking created", body: { bookingCreated: true } };
  });
}

async function cancelBooking(
  orgId: string,
  payload: z.infer<typeof calendlyPayload>,
): Promise<Outcome> {
  const externalId = externalIdOf(payload);
  if (!externalId) {
    return { note: "missing invitee uri", body: { ignored: true } };
  }
  const updated = await db
    .update(bookings)
    .set({ status: "cancelled" })
    .where(
      and(
        eq(bookings.orgId, orgId),
        eq(bookings.source, "calendly"),
        eq(bookings.externalId, externalId),
      ),
    )
    .returning({ id: bookings.id });
  if (updated.length === 0) {
    return { note: `no booking to cancel for ${externalId}`, body: { ignored: true } };
  }
  return { note: "booking cancelled", body: { bookingCancelled: true } };
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
