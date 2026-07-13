export { db, getDb, closeDb, getDbUrl, schema, type Db } from "./client";
export * from "./schema/index";

// Europe/London day boundaries (spec §13) — the one tz implementation,
// shared by seed, rollups, and the web app's "today" queries.
export {
  londonDayUTC,
  londonMonthStartUTC,
  londonTodayUTC,
} from "./seed/time";

// Local demo mode (no hosted Supabase yet): the org every request resolves
// to until real auth activates. Matches packages/db/src/seed/demo-data.ts.
export { ORG_ID as DEMO_ORG_ID } from "./seed/demo-data";
export { mirrorBookingEvents, type MirrorableEventRow } from "./mirror";

// Phase 2 (M1) — metric rollup engine (spec §8/§13, docs/phase2/CONTRACTS.md).
export {
  runRollups,
  runIncrementalRollupForProject,
  type RollupOptions,
  type RollupRunSummary,
} from "./rollup/engine";
export { detectAnomaliesForProject } from "./rollup/anomaly";

// Phase 2 (M2, wave 2) — read-side reuse of the engine's metric grammar so the
// metrics read API + live preview share ONE bucket/value/aggregate
// implementation (docs/phase2/CONTRACTS.md §Metrics/read API: "reuse metric-sql
// helpers; do NOT reimplement bucket math"). These were previously only used
// internally by the rollup engine; re-exported here so apps/web can import them
// from @azen/db instead of forking the DST-sensitive London bucket SQL.
export {
  toEvaluable,
  bucketStartSQL,
  aggregateValueSQL,
  isoUTC,
  type Aggregation,
  type EffectiveDefinition,
  type EvaluableDefinition,
} from "./rollup/metric-sql";
