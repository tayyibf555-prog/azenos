import { sql, type SQL } from "drizzle-orm";

/**
 * SQL grammar for metric evaluation (docs/phase2/CONTRACTS.md §Metric
 * semantics + §Rollup engine). Everything here is pure set-based SQL — the
 * engine never loops over event rows in JS; aggregation happens in Postgres.
 *
 * All raw fragments reference the events table aliased as `e`. Bucket starts
 * are UTC instants of the Europe/London local boundary (spec §13) computed by
 * Postgres so DST is always correct.
 */

export const ROLLUP_PERIODS = ["hour", "day", "week", "month"] as const;
export type RollupPeriod = (typeof ROLLUP_PERIODS)[number];

export type Aggregation = "count" | "sum" | "avg" | "p95" | "last" | "rate";

/** A metric_definitions row resolved for a project (global ∪ override). */
export interface EffectiveDefinition {
  key: string;
  name: string;
  unit: string;
  aggregation: Aggregation;
  eventType: string;
  valuePath: string | null;
  whereEquals: Record<string, string | number | boolean> | null;
  goodDirection: "up" | "down";
  isKpi: boolean;
  sort: number;
}

/** A definition validated into something the engine can compute in SQL. */
export interface EvaluableDefinition {
  key: string;
  aggregation: Aggregation;
  eventType: string;
  /** value expression (numeric) or null when the metric just counts rows */
  value: SQL | null;
  /** whereEquals conditions, already rendered as `<pathText> = <scalar>` */
  where: SQL[];
}

type ValueSource =
  | { kind: "none" }
  | { kind: "value_pence" }
  | { kind: "minutes_saved" }
  | { kind: "data"; key: string };

const DATA_KEY_RE = /^\$\.data\.([A-Za-z0-9_]+)$/;
// Guarded text→numeric parse: JSON text that isn't a plain number contributes
// nothing (NULL), so it is excluded from count/sum/avg (contract grammar).
const NUMERIC_GUARD = "'^-?[0-9]+([.][0-9]+)?$'";

function parseValuePath(vp: string | null): ValueSource | null {
  if (vp === null || vp === undefined) return { kind: "none" };
  if (vp === "$.value_pence") return { kind: "value_pence" };
  if (vp === "$.minutes_saved") return { kind: "minutes_saved" };
  const m = DATA_KEY_RE.exec(vp);
  if (m) return { kind: "data", key: m[1]! };
  return null; // unsupported path (e.g. nested $.data.a.b) → invalid definition
}

function valueSQL(src: ValueSource): SQL | null {
  switch (src.kind) {
    case "none":
      return null;
    case "value_pence":
      return sql`e.value_pence`;
    case "minutes_saved":
      return sql`e.minutes_saved`;
    case "data":
      return sql`case when (e.data->>${src.key}) ~ ${sql.raw(NUMERIC_GUARD)} then (e.data->>${src.key})::numeric end`;
  }
}

/** whereEquals paths reuse the value grammar but compare as text. */
function pathTextSQL(path: string): SQL | null {
  if (path === "$.value_pence") return sql`e.value_pence::text`;
  if (path === "$.minutes_saved") return sql`e.minutes_saved::text`;
  const m = DATA_KEY_RE.exec(path);
  if (m) return sql`e.data->>${m[1]!}`;
  return null; // $.type and anything else is not permitted here
}

/**
 * Validate an effective definition into an evaluable one, or return null
 * (caller logs a console.warn and skips it). Rules (contract):
 * - null valuePath + count/rate → count rows; null + sum/avg/p95/last → invalid
 * - unsupported valuePath / whereEquals path → invalid
 */
export function toEvaluable(def: EffectiveDefinition): EvaluableDefinition | null {
  const src = parseValuePath(def.valuePath);
  if (src === null) return null;

  const needsValue =
    def.aggregation === "sum" ||
    def.aggregation === "avg" ||
    def.aggregation === "p95" ||
    def.aggregation === "last";
  if (needsValue && src.kind === "none") return null;

  const where: SQL[] = [];
  if (def.whereEquals) {
    for (const [path, scalar] of Object.entries(def.whereEquals)) {
      const text = pathTextSQL(path);
      if (text === null) return null;
      where.push(sql`(${text}) = ${String(scalar)}`);
    }
  }

  return {
    key: def.key,
    aggregation: def.aggregation,
    eventType: def.eventType,
    value: src.kind === "none" ? null : valueSQL(src),
    where,
  };
}

/** date_trunc bucket start (a timestamptz) for `e.occurred_at`. */
export function bucketStartSQL(period: RollupPeriod): SQL {
  if (period === "hour") return sql`date_trunc('hour', e.occurred_at)`;
  return sql`date_trunc(${period}, e.occurred_at at time zone 'Europe/London') at time zone 'Europe/London'`;
}

/** Exclusive end of the bucket whose start is `maxIso` (DST-correct). */
export function periodEndSQL(period: RollupPeriod, maxIso: string): SQL {
  if (period === "hour") return sql`${maxIso}::timestamptz + interval '1 hour'`;
  const step =
    period === "day"
      ? sql`interval '1 day'`
      : period === "week"
        ? sql`interval '1 week'`
        : sql`interval '1 month'`;
  return sql`(${maxIso}::timestamptz at time zone 'Europe/London' + ${step}) at time zone 'Europe/London'`;
}

/** The per-bucket aggregate value, over columns v/occ/id of the inner select. */
export function aggregateValueSQL(agg: Aggregation): SQL {
  switch (agg) {
    case "count":
    case "rate":
      return sql`count(*)::numeric`;
    case "sum":
      return sql`sum(v)`;
    case "avg":
      return sql`avg(v)`;
    case "p95":
      return sql`percentile_cont(0.95) within group (order by v)`;
    case "last":
      return sql`(array_agg(v order by occ desc, id desc))[1]`;
  }
}

/** Format a timestamptz expression as ISO-8601 UTC to the second (exact for
 * bucket starts, which are always whole hours). */
export function isoUTC(expr: SQL): SQL {
  return sql`to_char(${expr} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;
}

/** ISO-8601 UTC with microseconds — for received_at/watermark values, whose
 * sub-second part MUST survive the round-trip or the drain loop can reprocess
 * events in the same second and stall (Phase 2 DECISIONS #17). */
export function isoUTCMicros(expr: SQL): SQL {
  return sql`to_char(${expr} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}
