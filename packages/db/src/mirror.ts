import { and, eq, inArray } from "drizzle-orm";
import type { Subject } from "@azen/events";
import type { Db } from "./client";
import { bookings } from "./schema/bookings";

/**
 * §6.3 step 5 mirror: booking.* project events → bookings rows
 * (kind client_end_customer). Column population mirrors the seed's reference
 * implementation in seed/index.ts: external_id carries the sender's
 * data.booking_id (data.external_id fallback), source_event_id points at the
 * events row, invitee keeps the subject, raw keeps the original event JSON.
 *
 * Lifecycle events (cancelled/rescheduled/completed/no_show) match the
 * created row by (project_id, external_id = data.booking_id); senders that
 * don't reuse their booking_id simply match nothing and are skipped silently
 * — the event row is still the source of truth.
 */

/** An events row that was actually INSERTED (not a duplicate) this request. */
export interface MirrorableEventRow {
  id: string;
  orgId: string;
  projectId: string;
  clientId: string;
  type: string;
  idempotencyKey: string;
  subject: Subject | null;
  data: Record<string, unknown>;
  raw: unknown;
}

const LIFECYCLE_STATUS = {
  "booking.cancelled": "cancelled",
  "booking.completed": "completed",
  "booking.no_show": "no_show",
} as const;

type LifecycleType = keyof typeof LIFECYCLE_STATUS;

function bookingIdOf(row: MirrorableEventRow): string | null {
  const id = row.data.booking_id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

export async function mirrorBookingEvents(
  db: Db,
  rows: MirrorableEventRow[],
): Promise<void> {
  const created = rows.filter((r) => r.type === "booking.created");
  if (created.length > 0) {
    await db.insert(bookings).values(
      created.map((r) => {
        // parseEvent guarantees starts_at (and ends_at when present) are ISO
        const startsAt = new Date(String(r.data.starts_at));
        const endsAt =
          typeof r.data.ends_at === "string"
            ? new Date(r.data.ends_at)
            : new Date(startsAt.getTime() + 30 * 60_000);
        return {
          orgId: r.orgId,
          clientId: r.clientId,
          projectId: r.projectId,
          source: "client_system" as const,
          kind: "client_end_customer" as const,
          invitee: (r.subject ?? null) as Record<string, unknown> | null,
          startsAt,
          endsAt,
          status: "scheduled" as const,
          externalId:
            String(r.data.booking_id ?? r.data.external_id ?? "") || null,
          sourceEventId: r.id,
          raw: r.raw,
        };
      }),
    );
  }

  // status flips: one UPDATE per (lifecycle type, project) group
  for (const type of Object.keys(LIFECYCLE_STATUS) as LifecycleType[]) {
    const groups = new Map<string, { orgId: string; ids: string[] }>();
    for (const r of rows) {
      if (r.type !== type) continue;
      const bookingId = bookingIdOf(r);
      if (!bookingId) continue;
      const group = groups.get(r.projectId) ?? { orgId: r.orgId, ids: [] };
      group.ids.push(bookingId);
      groups.set(r.projectId, group);
    }
    for (const [projectId, { orgId, ids }] of groups) {
      await db
        .update(bookings)
        .set({ status: LIFECYCLE_STATUS[type] })
        .where(
          and(
            eq(bookings.orgId, orgId),
            eq(bookings.projectId, projectId),
            inArray(bookings.externalId, ids),
          ),
        );
    }
  }

  for (const r of rows) {
    if (r.type !== "booking.rescheduled") continue;
    const bookingId = bookingIdOf(r);
    if (!bookingId || typeof r.data.new_starts_at !== "string") continue;
    const startsAt = new Date(r.data.new_starts_at);
    await db
      .update(bookings)
      .set({ startsAt, endsAt: new Date(startsAt.getTime() + 30 * 60_000) })
      .where(
        and(
          eq(bookings.orgId, r.orgId),
          eq(bookings.projectId, r.projectId),
          eq(bookings.externalId, bookingId),
        ),
      );
  }
}
