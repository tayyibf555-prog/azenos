import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "./core";
import {
  alertChannel,
  alertKind,
  alertSeverity,
  deliveryStatus,
} from "./enums";
import { events } from "./events";
import { projectKeys } from "./projects";
import { projects } from "./projects";

// §4.8 Delivery log & alert rules

/**
 * Every hit on /api/ingest is logged; powers the Setup tab delivery log.
 * Rejected/failed deliveries keep their raw payload so they can be replayed
 * through pipeline steps 4-6 (dead-letter recovery, §6.3).
 */
export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    projectKeyId: uuid("project_key_id").references(() => projectKeys.id),
    status: deliveryStatus("status").notNull(),
    httpStatus: integer("http_status").notNull(),
    latencyMs: integer("latency_ms"),
    error: text("error"),
    // set when accepted
    eventId: uuid("event_id").references(() => events.id),
    // payload kept ONLY for rejected/failed — accepted events keep raw on the event row
    raw: jsonb("raw").$type<unknown>(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("deliveries_key_time_idx").on(t.projectKeyId, t.receivedAt.desc()),
    index("deliveries_status_idx").on(t.status, t.receivedAt.desc()),
  ],
);

/**
 * Fixed-window ingest rate counters (§6.3 step 2) — the Postgres fallback
 * used when Upstash env vars are absent (local dev). Internal infra: no
 * org_id, no RLS (the migration makes it UNLOGGED — feel free to lose it).
 */
export const ingestRateCounters = pgTable(
  "ingest_rate_counters",
  {
    projectKeyId: uuid("project_key_id")
      .notNull()
      .references(() => projectKeys.id, { onDelete: "cascade" }),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.projectKeyId, t.windowStart] })],
);

/**
 * Evaluated in the ingest pipeline (§6.3 step 6) and by rollup jobs.
 * condition examples:
 *   {event_type:'system.error', count:3, window_minutes:30}
 *   {hours_since_last_event: 24}
 */
export const alertRules = pgTable(
  "alert_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    // null = org-wide default applied to every project
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "cascade",
    }),
    kind: alertKind("kind").notNull(),
    condition: jsonb("condition")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    channel: alertChannel("channel").notNull().default("whatsapp"),
    cooldownMinutes: integer("cooldown_minutes").notNull().default(60),
    enabled: boolean("enabled").notNull().default(true),
    lastFiredAt: timestamp("last_fired_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("alert_rules_project_idx").on(t.projectId, t.enabled)],
);

// Phase 8 §P8-HEALTH (docs/phase8/CONTRACTS.md) — alert_instances: the actual
// firings the Health Center grid shows and acks/resolves. alert_rules define
// WHEN to fire; instances record each breach. The evaluator dedupes on an open
// instance of the same kind+project and auto-resolves when the condition
// clears; ack/resolve are the only UI mutations.
export const alertInstances = pgTable(
  "alert_instances",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    // null = org-level (e.g. agency-wide cost spike)
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "cascade",
    }),
    kind: alertKind("kind").notNull(),
    severity: alertSeverity("severity").notNull().default("warn"),
    message: text("message").notNull(),
    evidence: jsonb("evidence")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    firedAt: timestamp("fired_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    ackedAt: timestamp("acked_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [
    index("alert_instances_open_idx").on(t.orgId, t.resolvedAt, t.firedAt),
  ],
);
