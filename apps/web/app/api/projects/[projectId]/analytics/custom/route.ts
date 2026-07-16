import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@azen/db";
import { jsonError, withErrorHandling } from "../../../../../../lib/server/http";
import { requireOrgId } from "../../../../../../lib/server/org";
import { isUuid } from "../../../../../../lib/server/schemas";
import {
  getProjectForAnalytics,
  parseRange,
} from "../../../../../../lib/server/analytics/base";
import {
  getMetricSeries,
  resolveEffectiveMetricDefinitions,
} from "../../../../../../lib/server/queries";
import { getDataQualitySummary } from "../../../../../../lib/server/analytics/data-quality";
import type { CustomData } from "../../../../../../components/analytics/sections/CustomSection";
import type { MetricAggregation, MetricUnit } from "../../../../../../components/metrics-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ projectId: string }> };

const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

interface RawEventRow {
  id: string;
  type: string;
  occurred_at: string;
  actor_kind: string | null;
  actor_id: string | null;
  subject_id: string | null;
  value_pence: number | string | null;
}
interface TypeCountRow {
  type: string;
  count: number | string;
}
interface RoleCountRow {
  role: string;
  count: number | string;
}

/**
 * Sum/count aggregations respect the metric's own aggregation kind:
 * additive kinds ("sum"/"count") are summed across the window's day-buckets,
 * point-in-time / statistical kinds ("avg"/"p95"/"last"/"rate") are averaged
 * across buckets — summing e.g. an average-per-day metric across 30 days
 * would not be a meaningful "window value". Returns null when every bucket in
 * the window is null (no rollup data yet).
 */
function aggregateWindow(
  points: { value: number | null }[],
  aggregation: string,
): number | null {
  const vals = points.map((p) => p.value).filter((v): v is number => v !== null);
  if (vals.length === 0) return null;
  const total = vals.reduce((a, b) => a + b, 0);
  return aggregation === "sum" || aggregation === "count"
    ? total
    : total / vals.length;
}

/**
 * P7-ANALYTICS · Custom & Raw — every metric_definition this project resolves
 * to (org defaults + project overrides, same precedence as the Metrics tab),
 * plus a raw event-spine explorer. All read-only, org+project scoped.
 *
 *   1. metrics       — resolveEffectiveMetricDefinitions (imported, NOT
 *                       reimplemented) gives the effective metric_definitions
 *                       set; getMetricSeries (imported, NOT reimplemented)
 *                       gives each one's daily series over the selected window
 *                       PLUS the prior equal-length window (compare:
 *                       "previous"), from which we derive:
 *                         - latestValue: the most recent non-null bucket
 *                         - delta:       current-window aggregate − prior-
 *                                        window aggregate (aggregateWindow
 *                                        picks sum vs average per the metric's
 *                                        own `aggregation` kind)
 *                       This is the exact rollup data the Metrics tab reads —
 *                       no parallel SQL against metric_rollups here.
 *   2. recentEvents  — the 50 most-recent raw events for this project
 *                       (unbounded by the range control — a live tail, like a
 *                       raw log — id / type / occurred_at / actor kind+id /
 *                       subject id / value_pence).
 *   3. typeBreakdown — per-type counts over the selected window (→ eventTypes,
 *                       the foundation-guaranteed field).
 *   4. roleBreakdown — per-actor-kind ("ai_agent" | "human" | "system" |
 *                       "unknown") counts over the selected window.
 *
 * Never throws on an empty project: no metric_definitions → metrics: [];
 * no events → recentEvents/eventTypes/roleBreakdown: [].
 */
export const GET = withErrorHandling(async (req: Request, { params }: Ctx) => {
  const orgId = await requireOrgId();
  const { projectId } = await params;
  if (!isUuid(projectId)) return jsonError(404, "project_not_found");

  const r = parseRange(new URL(req.url).searchParams);
  const project = await getProjectForAnalytics(orgId, projectId);
  if (!project) return jsonError(404, "project_not_found");

  // ── 1. effective metric_definitions + their series/latest/delta ────────────
  const defs = await resolveEffectiveMetricDefinitions(orgId, projectId);

  let metrics: CustomData["metrics"] = [];
  if (defs.length > 0) {
    // Pass the already-resolved `defs` through so getMetricSeries doesn't re-run
    // the identical org+project metric_definitions SELECT a second time.
    const { series, compare, meta } = await getMetricSeries(
      orgId,
      projectId,
      {
        keys: defs.map((d) => d.key),
        period: "day",
        from: r.fromDay,
        to: r.toDay,
        compare: "previous",
      },
      defs,
    );
    metrics = defs.map((d) => {
      const pts = series[d.key] ?? [];
      const cmpPts = compare?.[d.key] ?? [];
      let latestValue: number | null = null;
      for (let i = pts.length - 1; i >= 0; i--) {
        const v = pts[i]?.value;
        if (v !== null && v !== undefined) {
          latestValue = v;
          break;
        }
      }
      const currentAgg = aggregateWindow(pts, d.aggregation);
      const priorAgg = aggregateWindow(cmpPts, d.aggregation);
      const delta =
        currentAgg !== null && priorAgg !== null ? currentAgg - priorAgg : null;
      return {
        key: d.key,
        name: meta[d.key]?.name ?? d.name,
        // metric_definitions.unit/aggregation are Postgres enums whose values are
        // a strict subset of these client-facing unions; resolveEffectiveMetricDefinitions
        // widens them to `string`/`Aggregation` for its own generality.
        unit: d.unit as MetricUnit,
        aggregation: d.aggregation as MetricAggregation,
        goodDirection: d.goodDirection,
        isCustom: d.isCustom,
        latestValue,
        delta,
        series: pts.map((p) => ({ periodStart: p.periodStart, value: p.value })),
      };
    });
  }

  // ── 2. raw explorer: most-recent 50 events (unbounded by the range) ────────
  const eventRows = (await db.execute(sql`
    select
      e.id::text as id,
      e.type as type,
      to_char(e.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as occurred_at,
      e.actor->>'kind' as actor_kind,
      e.actor->>'id' as actor_id,
      e.subject->>'id' as subject_id,
      e.value_pence as value_pence
    from events e
    where e.org_id = ${orgId}::uuid and e.project_id = ${projectId}::uuid
    order by e.occurred_at desc
    limit 50
  `)) as unknown as RawEventRow[];

  // Inclusive [fromDay … toDay] London calendar days → UTC instants, for the
  // two range-scoped breakdowns.
  const win = sql`
    win as (
      select
        (${r.fromDay}::date::timestamp at time zone 'Europe/London') as w_start,
        ((${r.toDay}::date + 1)::timestamp at time zone 'Europe/London') as w_end
    )`;

  // ── 3. breakdown by event type, over the range ──────────────────────────────
  const typeRows = (await db.execute(sql`
    with ${win}
    select e.type as type, count(*)::int as count
    from events e, win
    where e.org_id = ${orgId}::uuid and e.project_id = ${projectId}::uuid
      and e.occurred_at >= win.w_start and e.occurred_at < win.w_end
    group by e.type
    order by count desc
  `)) as unknown as TypeCountRow[];

  // ── 4. breakdown by actor role (kind), over the range ───────────────────────
  const roleRows = (await db.execute(sql`
    with ${win}
    select coalesce(e.actor->>'kind', 'unknown') as role, count(*)::int as count
    from events e, win
    where e.org_id = ${orgId}::uuid and e.project_id = ${projectId}::uuid
      and e.occurred_at >= win.w_start and e.occurred_at < win.w_end
    group by 1
    order by count desc
  `)) as unknown as RoleCountRow[];

  // ── 5. P9-PACK3: data-quality card (ingest health + coverage) ──────────────
  const dataQuality = await getDataQualitySummary(orgId, projectId, project.type);

  const body: CustomData = {
    range: r.range,
    from: r.fromDay,
    to: r.toDay,
    eventTypes: typeRows.map((row) => ({ type: row.type, count: num(row.count) })),
    metrics,
    roleBreakdown: roleRows.map((row) => ({ role: row.role, count: num(row.count) })),
    recentEvents: eventRows.map((row) => ({
      id: row.id,
      type: row.type,
      occurredAt: row.occurred_at,
      actorKind: row.actor_kind,
      actorId: row.actor_id,
      subjectId: row.subject_id,
      valuePence: row.value_pence === null ? null : num(row.value_pence),
    })),
    dataQuality,
  };
  return NextResponse.json(body);
});
