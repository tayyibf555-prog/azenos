import {
  bigint,
  char,
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import type { Actor, Subject } from "@azen/events";
import { organizations } from "./core";
import { eventSource } from "./enums";
import { projects } from "./projects";

/**
 * §4.3 The event spine — the most important table in the system.
 * Everything the OS knows about a client business arrives as a row here.
 * Metrics, briefs, ROI, upsells are all derived from it. NEVER throw away raw.
 *
 * project_id is nullable: org-level events (agency Calendly) have no project.
 * Partition by month only if volume demands it — don't premature-build.
 */
export const events = pgTable(
  "events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    projectId: uuid("project_id").references(() => projects.id),
    type: text("type").notNull(),
    source: eventSource("source").notNull().default("sdk"),
    idempotencyKey: text("idempotency_key").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    actor: jsonb("actor").$type<Actor>(),
    subject: jsonb("subject").$type<Subject>(),
    data: jsonb("data")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    valuePence: bigint("value_pence", { mode: "number" }),
    currency: char("currency", { length: 3 }).notNull().default("gbp"),
    minutesSaved: numeric("minutes_saved", { mode: "number" }),
    raw: jsonb("raw").$type<unknown>().notNull(),
  },
  (t) => [
    // Dedup contract (§6.3 step 3). nullsNotDistinct so org-level events
    // (project_id NULL) still dedup correctly.
    unique("events_dedup_uq")
      .on(t.orgId, t.projectId, t.idempotencyKey)
      .nullsNotDistinct(),
    index("events_project_type_time_idx").on(
      t.projectId,
      t.type,
      t.occurredAt.desc(),
    ),
    index("events_org_time_idx").on(t.orgId, t.occurredAt.desc()),
    index("events_data_gin").using("gin", t.data),
  ],
);
