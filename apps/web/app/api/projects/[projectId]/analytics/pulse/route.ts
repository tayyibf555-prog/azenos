import { NextResponse } from "next/server";
import { db } from "@azen/db";
import { jsonError, withErrorHandling } from "../../../../../../lib/server/http";
import { requireOrgId } from "../../../../../../lib/server/org";
import { isUuid } from "../../../../../../lib/server/schemas";
import {
  getProjectForAnalytics,
  parseRange,
} from "../../../../../../lib/server/analytics/base";
import { computeForecastBand } from "../../../../../../lib/server/forecast";
import { computeProjectGoalPacing } from "../../../../../../lib/server/pacing";
import { eventCategory } from "../../../../../../components/ui";
import type { PulseData } from "../../../../../../components/analytics/sections/PulseSection";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ projectId: string }> };

const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/** Rows returned by the fixed liveness / count snapshot query. */
interface SnapshotRow {
  spine_total: number | string;
  last_event_at: string | null;
  last_heartbeat_at: string | null;
  last_event_age_min: number | string | null;
  today: number | string;
  last_7d: number | string;
  prev_7d: number | string;
  last_30d: number | string;
  prev_30d: number | string;
}

interface SeriesRow {
  period_start: string;
  value: number | string;
}

interface HeatRow {
  weekday: number | string;
  hour: number | string;
  value: number | string;
}

interface TypeRow {
  type: string;
  count: number | string;
}

/**
 * P7-ANALYTICS · Pulse — the live health of one project's event spine.
 *
 * All read-only. Four SELECT/WITH passes, every one scoped to
 * (org_id, project_id):
 *   1. snapshot   — lifetime spine total, freshest event + agent.heartbeat
 *                   (liveness), and fixed today / 7d / 30d counts with their
 *                   immediately-preceding comparison windows (period-over-period).
 *                   "today" uses the London calendar day; the rolling 7/30d
 *                   windows are instant-based (a rolling window has no calendar
 *                   boundary to honour), matching the health-snapshot intent.
 *   2. series     — zero-filled daily volume across the selected London-day
 *                   window [from,to] (generate_series left-joined onto counts),
 *                   so the LineChart never gaps mid-range.
 *   3. heatmap    — event counts by London weekday (isodow 1-7) × hour (0-23)
 *                   over the window — the activity rhythm.
 *   4. typeMix    — per-type counts over the window, folded into taxonomy
 *                   categories client-side via eventCategory() for the donut.
 *
 * Never throws on an empty project: zero counts, [] series/heatmap/mix, and a
 * "down" liveness with null timestamps.
 */
export const GET = withErrorHandling(async (req: Request, { params }: Ctx) => {
  const orgId = await requireOrgId();
  const { projectId } = await params;
  if (!isUuid(projectId)) return jsonError(404, "project_not_found");

  const r = parseRange(new URL(req.url).searchParams);
  const project = await getProjectForAnalytics(orgId, projectId);
  if (!project) return jsonError(404, "project_not_found");

  // ── 1. liveness + fixed count windows (lifetime scan, org+project scoped) ──
  const snapshotRows = (await db.$client`
    with ev as (
      select occurred_at, type
      from events
      where org_id = ${orgId}::uuid and project_id = ${projectId}::uuid
    ),
    cal as (
      select (now() at time zone 'Europe/London')::date as today_d
    )
    select
      (select count(*) from ev)::int as spine_total,
      (select to_char(max(occurred_at) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
         from ev) as last_event_at,
      (select to_char(max(occurred_at) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
         from ev where type = 'agent.heartbeat') as last_heartbeat_at,
      (select (extract(epoch from (now() - max(occurred_at))) / 60.0)
         from ev)::float8 as last_event_age_min,
      (select count(*) from ev, cal
         where (occurred_at at time zone 'Europe/London')::date = cal.today_d)::int as today,
      (select count(*) from ev
         where occurred_at >= now() - interval '7 days')::int as last_7d,
      (select count(*) from ev
         where occurred_at >= now() - interval '14 days'
           and occurred_at <  now() - interval '7 days')::int as prev_7d,
      (select count(*) from ev
         where occurred_at >= now() - interval '30 days')::int as last_30d,
      (select count(*) from ev
         where occurred_at >= now() - interval '60 days'
           and occurred_at <  now() - interval '30 days')::int as prev_30d
  `) as unknown as SnapshotRow[];
  const s = snapshotRows[0];

  // ── 2. daily volume series across the selected window (zero-filled) ────────
  const seriesRows = (await db.$client`
    with days as (
      select generate_series(${r.fromDay}::date, ${r.toDay}::date, interval '1 day')::date as d
    ),
    ev as (
      select (occurred_at at time zone 'Europe/London')::date as d, count(*)::int as c
      from events
      where org_id = ${orgId}::uuid and project_id = ${projectId}::uuid
        and occurred_at >= (${r.fromDay}::date::timestamp at time zone 'Europe/London')
        and occurred_at <  ((${r.toDay}::date + 1)::timestamp at time zone 'Europe/London')
      group by 1
    )
    select
      to_char((days.d::timestamp at time zone 'Europe/London') at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS"Z"') as period_start,
      coalesce(ev.c, 0)::int as value
    from days
    left join ev on ev.d = days.d
    order by days.d
  `) as unknown as SeriesRow[];

  // ── 3. activity heatmap (London weekday × hour) over the window ────────────
  const heatRows = (await db.$client`
    select
      extract(isodow from occurred_at at time zone 'Europe/London')::int as weekday,
      extract(hour   from occurred_at at time zone 'Europe/London')::int as hour,
      count(*)::int as value
    from events
    where org_id = ${orgId}::uuid and project_id = ${projectId}::uuid
      and occurred_at >= (${r.fromDay}::date::timestamp at time zone 'Europe/London')
      and occurred_at <  ((${r.toDay}::date + 1)::timestamp at time zone 'Europe/London')
    group by 1, 2
  `) as unknown as HeatRow[];

  // ── 4. per-type counts over the window (→ category mix client-side) ────────
  const typeRows = (await db.$client`
    select type, count(*)::int as count
    from events
    where org_id = ${orgId}::uuid and project_id = ${projectId}::uuid
      and occurred_at >= (${r.fromDay}::date::timestamp at time zone 'Europe/London')
      and occurred_at <  ((${r.toDay}::date + 1)::timestamp at time zone 'Europe/London')
    group by type
    order by count desc
  `) as unknown as TypeRow[];

  // ── 5. forecast basis (P9-PACK1 additive): always the trailing 28 London
  //      days ending today, INDEPENDENT of the range selector above — a 7d
  //      view still forecasts off a real 28-day trend, not a 7-point one. ──
  const forecastRows = (await db.$client`
    with days as (
      select generate_series(
        (now() at time zone 'Europe/London')::date - interval '27 days',
        (now() at time zone 'Europe/London')::date,
        interval '1 day'
      )::date as d
    ),
    ev as (
      select (occurred_at at time zone 'Europe/London')::date as d, count(*)::int as c
      from events
      where org_id = ${orgId}::uuid and project_id = ${projectId}::uuid
        and occurred_at >= (((now() at time zone 'Europe/London')::date - interval '27 days')::timestamp at time zone 'Europe/London')
      group by 1
    )
    select
      to_char((days.d::timestamp at time zone 'Europe/London') at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS"Z"') as period_start,
      coalesce(ev.c, 0)::int as value
    from days
    left join ev on ev.d = days.d
    order by days.d
  `) as unknown as SeriesRow[];

  // ── liveness verdict from the freshest of (last event, last heartbeat) ─────
  const lastEventAt = s?.last_event_at ?? null;
  const lastHeartbeatAt = s?.last_heartbeat_at ?? null;
  const signals = [lastEventAt, lastHeartbeatAt].filter(
    (x): x is string => typeof x === "string",
  );
  const freshest = signals.length > 0 ? signals.sort().at(-1)! : null;
  let livenessStatus: "up" | "degraded" | "down" = "down";
  let freshestAgeMinutes: number | null = null;
  if (freshest) {
    freshestAgeMinutes = Math.max(
      0,
      Math.round((Date.now() - new Date(freshest).getTime()) / 60000),
    );
    livenessStatus =
      freshestAgeMinutes <= 1440
        ? "up"
        : freshestAgeMinutes <= 4320
          ? "degraded"
          : "down";
  }

  // ── fold per-type counts into ordered taxonomy-category segments ───────────
  const catMap = new Map<string, { label: string; color: string; value: number }>();
  for (const row of typeRows) {
    const { label, color } = eventCategory(row.type);
    const bucket = catMap.get(label) ?? { label, color, value: 0 };
    bucket.value += num(row.count);
    catMap.set(label, bucket);
  }
  const mix = [...catMap.values()].sort((a, b) => b.value - a.value);

  const series = seriesRows.map((row) => ({
    periodStart: row.period_start,
    value: num(row.value),
  }));
  const totalEvents = series.reduce((acc, p) => acc + p.value, 0);
  const activeDays = series.reduce((acc, p) => acc + (p.value > 0 ? 1 : 0), 0);

  // ── P9-PACK1 additive: goal pacing strip + daily-volume forecast band ──────
  const pacing =
    project.goals.length > 0
      ? await computeProjectGoalPacing(orgId, projectId, project.goals)
      : [];
  const forecast = computeForecastBand(
    forecastRows.map((row) => ({ periodStart: row.period_start, value: num(row.value) })),
  );

  const body: PulseData = {
    range: r.range,
    from: r.fromDay,
    to: r.toDay,
    totalEvents,
    activeDays,
    series,
    spineTotal: num(s?.spine_total),
    health: project.health,
    liveness: {
      status: livenessStatus,
      lastEventAt,
      lastHeartbeatAt,
      lastEventAgeMinutes:
        s?.last_event_age_min === null || s?.last_event_age_min === undefined
          ? null
          : Math.max(0, Math.round(num(s.last_event_age_min))),
      freshestAgeMinutes,
    },
    counts: {
      today: num(s?.today),
      last7d: num(s?.last_7d),
      prev7d: num(s?.prev_7d),
      last30d: num(s?.last_30d),
      prev30d: num(s?.prev_30d),
    },
    heatmap: heatRows.map((row) => ({
      weekday: num(row.weekday),
      hour: num(row.hour),
      value: num(row.value),
    })),
    mix,
    typeMix: typeRows.map((row) => ({ type: row.type, count: num(row.count) })),
    pacing,
    forecast: forecast
      ? {
          points: forecast.points.map((p) => ({
            periodStart: p.periodStart,
            low: p.low,
            high: p.high,
          })),
        }
      : null,
  };
  return NextResponse.json(body);
});
