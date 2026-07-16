import { cache } from "react";
import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import {
  briefs,
  clients,
  db,
  industries,
  metricRollups,
  projects,
} from "@azen/db";

/**
 * Phase 8 §P8-BENCH (docs/phase8/CONTRACTS.md) — the cross-client benchmarks
 * layer.
 *
 * For a given industry + metric key, we compute p25/p50/p75 across that
 * industry's ACTIVE (live) projects from metric_rollups over a London month
 * window — but ONLY when at least ANONYMITY_FLOOR distinct clients contribute.
 * Below the floor we return null: with fewer than three clients a "median"
 * would expose an individual client's numbers, which must never happen on a
 * white-label report a client can see. The floor is NON-NEGOTIABLE.
 *
 * Benchmarks are naturally org-scoped (industries are org-owned), so an agency
 * only ever compares its own book of business against itself — no cross-org
 * leakage. The view model that escapes to a shared report carries ONLY the
 * subject client's own values plus AGGREGATE peer percentiles — never another
 * client's identity, id, or raw value.
 *
 * DECISION (recorded for the lead): the percentile SAMPLE UNIT is the per-CLIENT
 * monthly aggregate (sum of that client's live projects for the metric), not the
 * per-project value. The benchmark is consumed as "your client vs the industry
 * median client", so the distribution must be over comparable client-level
 * totals; this also makes the anonymity floor exact (≥3 samples). Clients with
 * live projects but no rollup for a metric count as a real 0 (a fair data point).
 */

// ── headline metric specs (curated, clean rollup provenance) ──────────────────

export type BenchmarkUnit = "pence" | "hours" | "count";

export interface BenchmarkMetricSpec {
  /** metric_rollups.metric_key (day period), summed over the month */
  key: string;
  label: string;
  unit: BenchmarkUnit;
  goodDirection: "up" | "down";
  /** raw rollup sum → display value (monotonic, so it commutes with percentile) */
  toDisplay: (raw: number) => number;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/**
 * The headline benchmark metrics. Every key here is a day-rollup sum with clean,
 * client-comparable semantics that also match the shared report's value tiles
 * (so "your value vs the industry median" reinforces the same numbers). Ordered;
 * the report/strip render the first few that clear the zero-signal gate (3-5).
 */
export const BENCHMARK_METRICS: readonly BenchmarkMetricSpec[] = [
  {
    key: "revenue_attributed",
    label: "Value delivered",
    unit: "pence",
    goodDirection: "up",
    toDisplay: (raw) => Math.round(raw),
  },
  {
    key: "minutes_saved",
    label: "Hours saved",
    unit: "hours",
    goodDirection: "up",
    toDisplay: (raw) => round1(raw / 60),
  },
  {
    key: "conversations",
    label: "Conversations handled",
    unit: "count",
    goodDirection: "up",
    toDisplay: (raw) => Math.round(raw),
  },
] as const;

/** The anonymity floor: fewer distinct clients than this ⇒ no benchmark at all. */
export const ANONYMITY_FLOOR = 3;

// ── pure percentile math (exported for tests) ─────────────────────────────────

/**
 * Linear-interpolation percentile (the numpy default / Postgres percentile_cont
 * method), p in [0,1], over an ascending-sorted array. Deterministic.
 */
export function percentile(sortedAsc: readonly number[], p: number): number {
  const n = sortedAsc.length;
  if (n === 0) return 0;
  if (n === 1) return sortedAsc[0]!;
  const rank = p * (n - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sortedAsc[lo]!;
  return sortedAsc[lo]! + (rank - lo) * (sortedAsc[hi]! - sortedAsc[lo]!);
}

export interface MetricPercentiles {
  p25: number;
  p50: number;
  p75: number;
}

/** p25/p50/p75 over a set of per-client values (unsorted input is fine). */
export function percentilesFromValues(values: readonly number[]): MetricPercentiles {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p25: percentile(sorted, 0.25),
    p50: percentile(sorted, 0.5),
    p75: percentile(sorted, 0.75),
  };
}

// ── industry benchmark computation (DB) ───────────────────────────────────────

export interface IndustryBenchmark {
  sampleClients: number;
  /** metric key → RAW-value percentiles across the industry's clients */
  metrics: Record<string, MetricPercentiles>;
  /** clientId → (metric key → that client's RAW monthly aggregate) */
  perClientRaw: Map<string, Map<string, number>>;
}

export interface ComputeBenchmarkInput {
  orgId: string;
  industryId: string;
  /** inclusive UTC instant of the London month start */
  start: Date;
  /** exclusive UTC instant of the next London month start */
  end: Date;
  /** default = BENCHMARK_METRICS keys */
  keys?: readonly string[];
}

/**
 * Compute per-metric p25/p50/p75 across an industry's live-project clients for a
 * month window. Returns null when fewer than ANONYMITY_FLOOR distinct clients
 * have live projects in the industry (the floor gates the WHOLE benchmark).
 */
export async function computeIndustryBenchmark(
  input: ComputeBenchmarkInput,
): Promise<IndustryBenchmark | null> {
  const keys = input.keys ?? BENCHMARK_METRICS.map((m) => m.key);

  // Authoritative sample set: distinct clients with ≥1 live project in the
  // industry. This — not the rollup rows — defines n, so a client with live
  // projects but zero events counts as a real 0 for every metric.
  const clientRows = await db
    .selectDistinct({ clientId: clients.id })
    .from(clients)
    .innerJoin(
      projects,
      and(
        eq(projects.clientId, clients.id),
        eq(projects.orgId, clients.orgId),
        eq(projects.status, "live"),
      ),
    )
    .where(
      and(eq(clients.orgId, input.orgId), eq(clients.industryId, input.industryId)),
    );

  const clientIds = clientRows.map((r) => r.clientId);
  if (clientIds.length < ANONYMITY_FLOOR) return null;

  // Per-client × per-metric monthly aggregate (sum across the client's live
  // projects' day rollups inside the window).
  const sumRows = await db
    .select({
      clientId: clients.id,
      metricKey: metricRollups.metricKey,
      value: sql<number>`coalesce(sum(${metricRollups.value}), 0)`.mapWith(Number),
    })
    .from(clients)
    .innerJoin(
      projects,
      and(
        eq(projects.clientId, clients.id),
        eq(projects.orgId, clients.orgId),
        eq(projects.status, "live"),
      ),
    )
    .innerJoin(
      metricRollups,
      and(
        eq(metricRollups.projectId, projects.id),
        eq(metricRollups.period, "day"),
        inArray(metricRollups.metricKey, [...keys]),
        gte(metricRollups.periodStart, input.start),
        lt(metricRollups.periodStart, input.end),
      ),
    )
    .where(
      and(eq(clients.orgId, input.orgId), eq(clients.industryId, input.industryId)),
    )
    .groupBy(clients.id, metricRollups.metricKey);

  const perClientRaw = new Map<string, Map<string, number>>();
  for (const id of clientIds) perClientRaw.set(id, new Map());
  for (const row of sumRows) {
    const bucket = perClientRaw.get(row.clientId);
    if (bucket) bucket.set(row.metricKey, Number(row.value));
  }

  const metrics: Record<string, MetricPercentiles> = {};
  for (const key of keys) {
    const values = clientIds.map((id) => perClientRaw.get(id)?.get(key) ?? 0);
    metrics[key] = percentilesFromValues(values);
  }

  return { sampleClients: clientIds.length, metrics, perClientRaw };
}

// ── client-facing view model (white-label safe; serializable) ─────────────────

export type BenchmarkStanding = "ahead" | "near" | "behind";

export interface BenchmarkBar {
  key: string;
  label: string;
  unit: BenchmarkUnit;
  goodDirection: "up" | "down";
  /** the subject client's value, in DISPLAY units (pence / hours / count) */
  clientValue: number;
  /** peer percentiles, DISPLAY units */
  p25: number;
  p50: number;
  p75: number;
  /** the subject's standing vs the industry median (honours goodDirection) */
  standing: BenchmarkStanding;
}

export interface ClientBenchmark {
  industryName: string;
  monthLabel: string;
  /** always ≥ ANONYMITY_FLOOR */
  sampleClients: number;
  /** 1..5 headline bars that cleared the zero-signal gate */
  bars: BenchmarkBar[];
}

/** ±5% band around the median counts as "near"; beyond it, direction decides. */
function standingFor(
  clientValue: number,
  median: number,
  goodDirection: "up" | "down",
): BenchmarkStanding {
  if (median <= 0) return clientValue > 0 ? "ahead" : "near";
  const ratio = clientValue / median;
  if (ratio >= 0.95 && ratio <= 1.05) return "near";
  const above = clientValue > median;
  const better = goodDirection === "up" ? above : !above;
  return better ? "ahead" : "behind";
}

function buildBars(
  benchmark: IndustryBenchmark,
  subjectClientId: string,
): BenchmarkBar[] {
  const subject = benchmark.perClientRaw.get(subjectClientId);
  if (!subject) return [];

  const bars: BenchmarkBar[] = [];
  for (const spec of BENCHMARK_METRICS) {
    const raw = benchmark.metrics[spec.key];
    if (!raw) continue;
    // Zero-signal gate: an all-zero distribution carries no comparison.
    if (raw.p75 <= 0 && (subject.get(spec.key) ?? 0) <= 0) continue;

    const clientValue = spec.toDisplay(subject.get(spec.key) ?? 0);
    const p25 = spec.toDisplay(raw.p25);
    const p50 = spec.toDisplay(raw.p50);
    const p75 = spec.toDisplay(raw.p75);
    bars.push({
      key: spec.key,
      label: spec.label,
      unit: spec.unit,
      goodDirection: spec.goodDirection,
      clientValue,
      p25,
      p50,
      p75,
      standing: standingFor(clientValue, p50, spec.goodDirection),
    });
    if (bars.length >= 5) break;
  }
  return bars;
}

// ── month-window resolution (DST-safe, in Postgres) ───────────────────────────

interface WindowRow {
  start_utc: string;
  end_utc: string;
  month_label: string;
}

/**
 * Resolve a London month window. Given the UTC instant of a month start, returns
 * that month; given null, returns the LAST COMPLETE London month (the same month
 * the Monthly Strategist reports). Boundaries are derived inside Postgres so DST
 * never shifts a bucket.
 */
async function resolveMonthWindow(
  monthStartUTC: Date | null,
): Promise<{ start: Date; end: Date; monthLabel: string }> {
  const rows = (await db.execute(
    monthStartUTC
      ? sql`
          with base as (select ${monthStartUTC.toISOString()}::timestamptz as ms)
          select
            to_char(ms, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as start_utc,
            to_char(((ms at time zone 'Europe/London' + interval '1 month') at time zone 'Europe/London'), 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as end_utc,
            to_char(ms at time zone 'Europe/London', 'FMMonth YYYY') as month_label
          from base`
      : sql`
          with base as (
            select ((date_trunc('month', now() at time zone 'Europe/London') - interval '1 month') at time zone 'Europe/London') as ms
          )
          select
            to_char(ms, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as start_utc,
            to_char(((ms at time zone 'Europe/London' + interval '1 month') at time zone 'Europe/London'), 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as end_utc,
            to_char(ms at time zone 'Europe/London', 'FMMonth YYYY') as month_label
          from base`,
  )) as unknown as WindowRow[];
  const w = rows[0]!;
  return {
    start: new Date(w.start_utc),
    end: new Date(w.end_utc),
    monthLabel: w.month_label,
  };
}

// ── public loader (report slot + Client 360) ──────────────────────────────────

export interface LoadClientBenchmarkOptions {
  /** override the window; default = the client's latest monthly report month */
  monthStartUTC?: Date;
}

/**
 * Uncached core (exported for tests). Resolves the client's industry + month,
 * computes the industry benchmark, and shapes the white-label view model, or
 * null when: the client has no industry, the floor isn't met, or no metric
 * carries signal. Never leaks org ids, client ids, or other clients' values.
 */
export async function loadClientBenchmarkUncached(
  orgId: string,
  clientId: string,
  opts: LoadClientBenchmarkOptions = {},
): Promise<ClientBenchmark | null> {
  const client = await db.query.clients.findFirst({
    where: and(eq(clients.id, clientId), eq(clients.orgId, orgId)),
    columns: { industryId: true },
  });
  if (!client?.industryId) return null;

  // Window: explicit → the client's latest monthly value-report month (so a
  // shared report's benchmark matches the report shown) → last complete month.
  let monthStart = opts.monthStartUTC ?? null;
  if (!monthStart) {
    const [b] = await db
      .select({ periodStart: briefs.periodStart })
      .from(briefs)
      .where(
        and(
          eq(briefs.orgId, orgId),
          eq(briefs.period, "monthly"),
          sql`${briefs.dataSnapshot}->>'docType' = 'client_value_report'`,
          sql`${briefs.dataSnapshot}->>'clientId' = ${clientId}`,
        ),
      )
      .orderBy(desc(briefs.periodStart))
      .limit(1);
    monthStart = b?.periodStart ?? null;
  }

  const win = await resolveMonthWindow(monthStart);

  const industry = await db.query.industries.findFirst({
    where: and(eq(industries.id, client.industryId), eq(industries.orgId, orgId)),
    columns: { name: true },
  });

  const benchmark = await computeIndustryBenchmark({
    orgId,
    industryId: client.industryId,
    start: win.start,
    end: win.end,
  });
  if (!benchmark) return null;

  const bars = buildBars(benchmark, clientId);
  if (bars.length === 0) return null;

  return {
    industryName: industry?.name ?? "your industry",
    monthLabel: win.monthLabel,
    sampleClients: benchmark.sampleClients,
    bars,
  };
}

/**
 * Request-cached loader for server components (the shared report slot + Client
 * 360). Deterministic; the React cache dedupes repeated calls within one request.
 */
export const loadClientBenchmark = cache(loadClientBenchmarkUncached);
