import { index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./core";
import { feedbackKind, feedbackStatus } from "./enums";
import { events } from "./events";
import { projects } from "./projects";

// Phase 7 §B (docs/phase7/PLAN.md) — feedback_items, the triage mirror of
// feedback.submitted events. The event spine stays the source of truth (the
// public webhook writes the event first, then mirrors here in the same
// transaction); this table adds the mutable triage status the UI board needs
// (new → seen → planned → done), mirroring how bookings mirrors booking.*.
export const feedbackItems = pgTable(
  "feedback_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id),
    kind: feedbackKind("kind").notNull(),
    message: text("message").notNull(),
    // 1 = minor, 2 = annoying, 3 = blocking (optional, submitter-declared)
    severity: integer("severity"),
    submitterName: text("submitter_name"),
    submitterEmail: text("submitter_email"),
    pageUrl: text("page_url"),
    status: feedbackStatus("status").notNull().default("new"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("feedback_items_project_created_idx").on(
      t.orgId,
      t.projectId,
      t.createdAt,
    ),
    index("feedback_items_project_status_idx").on(
      t.orgId,
      t.projectId,
      t.status,
    ),
  ],
);
