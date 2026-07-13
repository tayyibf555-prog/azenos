import { z } from "zod";
import { and, desc, eq, type SQL } from "drizzle-orm";
import { bookings, db } from "@azen/db";
import { defineTool } from "./types";
import { resolveProjectIdBySlug, timestampRangeConds } from "./shared";

/**
 * list_bookings — org-scoped bookings (§4.6): agency bookings (Calendly:
 * discovery/kickoff/review) and client-end bookings mirrored from booking.*
 * events (kind client_end_customer). Newest-first, capped at 50.
 */

const LIMIT_CAP = 50;

const bookingKinds = [
  "discovery",
  "kickoff",
  "review",
  "client_end_customer",
] as const;
const bookingStatuses = [
  "scheduled",
  "completed",
  "cancelled",
  "no_show",
] as const;

export const listBookings = defineTool({
  name: "list_bookings",
  description:
    "List bookings, org-scoped, newest-first, capped at 50. Two flavours: the agency's own Calendly bookings (kind discovery/kickoff/review) and end-customer bookings the client systems made (kind client_end_customer). Filter by project_slug, kind, status (scheduled/completed/cancelled/no_show), from/to (YYYY-MM-DD or ISO, on starts_at), and limit (<=50).",
  inputSchema: z
    .object({
      project_slug: z.string().min(1).optional(),
      kind: z.enum(bookingKinds).optional(),
      status: z.enum(bookingStatuses).optional(),
      from: z.string().min(1).optional(),
      to: z.string().min(1).optional(),
      limit: z.number().int().positive().optional(),
    })
    .strict(),
  run: async (orgId, input) => {
    const conds: SQL[] = [eq(bookings.orgId, orgId)];

    if (input.project_slug !== undefined) {
      const projectId = await resolveProjectIdBySlug(orgId, input.project_slug);
      if (projectId === null) {
        return {
          ok: true,
          data: {
            bookings: [],
            note: `no project '${input.project_slug}' in this org`,
          },
        };
      }
      conds.push(eq(bookings.projectId, projectId));
    }

    if (input.kind !== undefined) conds.push(eq(bookings.kind, input.kind));
    if (input.status !== undefined)
      conds.push(eq(bookings.status, input.status));
    conds.push(...timestampRangeConds(bookings.startsAt, input.from, input.to));

    const limit = Math.min(input.limit ?? LIMIT_CAP, LIMIT_CAP);
    const rows = await db
      .select({
        id: bookings.id,
        clientId: bookings.clientId,
        projectId: bookings.projectId,
        source: bookings.source,
        kind: bookings.kind,
        invitee: bookings.invitee,
        startsAt: bookings.startsAt,
        endsAt: bookings.endsAt,
        status: bookings.status,
        externalId: bookings.externalId,
      })
      .from(bookings)
      .where(and(...conds))
      .orderBy(desc(bookings.startsAt), desc(bookings.id))
      .limit(limit);

    return { ok: true, data: { bookings: rows, count: rows.length } };
  },
});
