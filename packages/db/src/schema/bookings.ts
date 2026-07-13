import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { clients, organizations } from "./core";
import { bookingKind, bookingSource, bookingStatus } from "./enums";
import { projects } from "./projects";

/**
 * §4.6 Bookings — two flavors:
 * - agency bookings (Tayyib's Calendly): kind discovery|kickoff|review
 * - client-end bookings (mirrored from booking.* project events): kind
 *   client_end_customer, for cross-project booking analytics
 */
export const bookings = pgTable(
  "bookings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    clientId: uuid("client_id").references(() => clients.id),
    projectId: uuid("project_id").references(() => projects.id),
    source: bookingSource("source").notNull(),
    kind: bookingKind("kind").notNull(),
    invitee: jsonb("invitee").$type<Record<string, unknown>>(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    status: bookingStatus("status").notNull().default("scheduled"),
    externalId: text("external_id"),
    // for mirrored rows: the source event id
    sourceEventId: uuid("source_event_id"),
    raw: jsonb("raw").$type<unknown>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("bookings_org_time_idx").on(t.orgId, t.startsAt.desc()),
    index("bookings_project_idx").on(t.projectId, t.startsAt.desc()),
  ],
);
