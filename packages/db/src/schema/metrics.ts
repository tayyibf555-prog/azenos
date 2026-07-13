import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "./core";
import {
  goodDirection,
  metricAggregation,
  metricUnit,
  rollupPeriod,
} from "./enums";
import { projects } from "./projects";

// §4.4 Metrics & rollups

export const metricDefinitions = pgTable(
  "metric_definitions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    // null = global default seeded onto every project (§8.1 KPI pack)
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "cascade",
    }),
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    unit: metricUnit("unit").notNull().default("count"),
    aggregation: metricAggregation("aggregation").notNull().default("count"),
    eventType: text("event_type").notNull(),
    // JSONPath into event data; null = count rows / sum envelope fields
    valuePath: text("value_path"),
    // equality filter on event fields, e.g. {"$.data.success": true} — enables
    // rate-style metrics (success rate numerators) without schema changes
    whereEquals: jsonb("where_equals").$type<Record<
      string,
      string | number | boolean
    > | null>(),
    goodDirection: goodDirection("good_direction").notNull().default("up"),
    isKpi: boolean("is_kpi").notNull().default(false),
    sort: integer("sort").notNull().default(0),
  },
  (t) => [index("metric_defs_project_idx").on(t.projectId, t.key)],
);

/**
 * Rollups are recomputed idempotently by the hourly job (last 48h re-rolled
 * every run so late events self-heal). period_start = the UTC instant of the
 * Europe/London local boundary (§13 — DST transitions get tests).
 * Dashboards read rollups, never scan raw events.
 */
/**
 * Incremental rollup cursor (§6.3 step 6 / §8): the engine recomputes every
 * bucket touched by events with received_at > processed_through — late
 * events self-heal because arrival time, not occurrence time, drives it.
 */
export const rollupWatermarks = pgTable("rollup_watermarks", {
  projectId: uuid("project_id")
    .primaryKey()
    .references(() => projects.id, { onDelete: "cascade" }),
  orgId: uuid("org_id")
    .notNull()
    .references(() => organizations.id),
  processedThrough: timestamp("processed_through", {
    withTimezone: true,
  }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const metricRollups = pgTable(
  "metric_rollups",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    metricKey: text("metric_key").notNull(),
    period: rollupPeriod("period").notNull(),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    value: numeric("value", { mode: "number" }).notNull(),
    sampleCount: integer("sample_count").notNull().default(0),
  },
  (t) => [
    primaryKey({
      columns: [t.projectId, t.metricKey, t.period, t.periodStart],
    }),
    index("rollups_period_idx").on(t.period, t.periodStart.desc()),
  ],
);
