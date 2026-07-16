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
import type {
  BookingsResponse,
  LabelledValue,
} from "../../../../../../components/analytics/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ projectId: string }> };

/**
 * Deep Bookings analytics — READ-ONLY SELECT/WITH over the `bookings` table and
 * `booking.*` rows in `events`, always scoped to (org_id, project_id). London
 * calendar-day boundaries are resolved in Postgres with the shared
 * `… at time zone 'Europe/London'` pattern (DST-correct), never in JS.
 *
 * Windowed metrics (status mix, rates, lead time, curve, series, kind/source
 * mix) are anchored on the appointment date `starts_at` inside the inclusive
 * [from … to] window of London days — i.e. "the appointments due in this range".
 * `upcoming` / `past` are a live all-time snapshot relative to now(), so the
 * forward book stays visible even when the range is entirely in the past.
 * Reschedule rate has no column on `bookings`, so it comes from the event
 * stream: `booking.rescheduled` ÷ `booking.created` in the same window.
 */

/** Extra fields layered onto the foundation contract (add-only; never removes). */
interface BookingsData extends BookingsResponse {
  statusCounts: {
    scheduled: number;
    completed: number;
    cancelled: number;
    noShow: number;
  };
  /** of resolved bookings (completed + cancelled + no-show); null when none resolved */
  completedRate: number | null;
  cancelledRate: number | null;
  noShowRate: number | null;
  /** booking.rescheduled ÷ booking.created in-window; null when nothing was booked */
  rescheduleRate: number | null;
  /** mean created→starts_at in hours (window; only non-negative lead); null when empty */
  avgLeadHours: number | null;
  /** Mon…Sun counts (7 entries, always present) — by starts_at */
  weekdayCurve: LabelledValue[];
  /** 0…23 counts (24 entries, always present) — by starts_at */
  hourCurve: LabelledValue[];
  /** weekday (1=Mon…7=Sun) × hour (0…23) intensity — by starts_at */
  heatmap: { weekday: number; hour: number; value: number }[];
  kindMix: LabelledValue[];
  sourceMix: LabelledValue[];
  /** live snapshot, all-time: future scheduled appointments */
  upcoming: number;
  /** live snapshot, all-time: appointments whose start is in the past */
  past: number;
}

const num = (v: unknown): number => Number(v ?? 0);
const round4 = (n: number): number => Math.round(n * 10000) / 10000;
const rate = (top: number, bottom: number): number | null =>
  bottom > 0 ? round4(top / bottom) : null;

interface SummaryRow {
  total: number | string;
  scheduled: number | string;
  completed: number | string;
  cancelled: number | string;
  no_show: number | string;
  avg_lead_hours: number | string | null;
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
interface MixRow {
  label: string;
  value: number | string;
}
interface SnapshotRow {
  upcoming: number | string;
  past: number | string;
}
interface RescheduleRow {
  created: number | string;
  rescheduled: number | string;
}

const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export const GET = withErrorHandling(async (req: Request, { params }: Ctx) => {
  const orgId = await requireOrgId();
  const { projectId } = await params;
  if (!isUuid(projectId)) return jsonError(404, "project_not_found");

  const r = parseRange(new URL(req.url).searchParams);
  const project = await getProjectForAnalytics(orgId, projectId);
  if (!project) return jsonError(404, "project_not_found");

  const from = r.fromDay;
  const to = r.toDay;

  // ── window status counts + lead time (bookings table, by starts_at) ──────────
  const summaryRows = (await db.execute(sql`
    with win as (
      select
        (${from}::date::timestamp at time zone 'Europe/London') as w_start,
        ((${to}::date + 1)::timestamp at time zone 'Europe/London') as w_end
    )
    select
      count(*)::int as total,
      count(*) filter (where b.status = 'scheduled')::int as scheduled,
      count(*) filter (where b.status = 'completed')::int as completed,
      count(*) filter (where b.status = 'cancelled')::int as cancelled,
      count(*) filter (where b.status = 'no_show')::int as no_show,
      (
        avg(extract(epoch from (b.starts_at - b.created_at)) / 3600.0)
          filter (where b.starts_at >= b.created_at)
      )::float8 as avg_lead_hours
    from bookings b, win
    where b.org_id = ${orgId}::uuid
      and b.project_id = ${projectId}::uuid
      and b.starts_at >= win.w_start
      and b.starts_at < win.w_end
  `)) as unknown as SummaryRow[];
  const s = summaryRows[0] ?? {
    total: 0,
    scheduled: 0,
    completed: 0,
    cancelled: 0,
    no_show: 0,
    avg_lead_hours: null,
  };

  // ── daily volume series (London day buckets, ascending; present days only) ───
  const seriesRows = (await db.execute(sql`
    with win as (
      select
        (${from}::date::timestamp at time zone 'Europe/London') as w_start,
        ((${to}::date + 1)::timestamp at time zone 'Europe/London') as w_end
    )
    select
      to_char(
        (date_trunc('day', b.starts_at at time zone 'Europe/London') at time zone 'Europe/London') at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS"Z"'
      ) as period_start,
      count(*)::int as value
    from bookings b, win
    where b.org_id = ${orgId}::uuid
      and b.project_id = ${projectId}::uuid
      and b.starts_at >= win.w_start
      and b.starts_at < win.w_end
    group by 1
    order by 1
  `)) as unknown as SeriesRow[];

  // ── booking curve: weekday × hour of starts_at (London) ──────────────────────
  const heatRows = (await db.execute(sql`
    with win as (
      select
        (${from}::date::timestamp at time zone 'Europe/London') as w_start,
        ((${to}::date + 1)::timestamp at time zone 'Europe/London') as w_end
    )
    select
      extract(isodow from b.starts_at at time zone 'Europe/London')::int as weekday,
      extract(hour from b.starts_at at time zone 'Europe/London')::int as hour,
      count(*)::int as value
    from bookings b, win
    where b.org_id = ${orgId}::uuid
      and b.project_id = ${projectId}::uuid
      and b.starts_at >= win.w_start
      and b.starts_at < win.w_end
    group by 1, 2
  `)) as unknown as HeatRow[];

  // ── kind + source mix (window, by starts_at) ─────────────────────────────────
  const kindRows = (await db.execute(sql`
    with win as (
      select
        (${from}::date::timestamp at time zone 'Europe/London') as w_start,
        ((${to}::date + 1)::timestamp at time zone 'Europe/London') as w_end
    )
    select b.kind::text as label, count(*)::int as value
    from bookings b, win
    where b.org_id = ${orgId}::uuid
      and b.project_id = ${projectId}::uuid
      and b.starts_at >= win.w_start
      and b.starts_at < win.w_end
    group by 1
    order by 2 desc, 1
  `)) as unknown as MixRow[];

  const sourceRows = (await db.execute(sql`
    with win as (
      select
        (${from}::date::timestamp at time zone 'Europe/London') as w_start,
        ((${to}::date + 1)::timestamp at time zone 'Europe/London') as w_end
    )
    select b.source::text as label, count(*)::int as value
    from bookings b, win
    where b.org_id = ${orgId}::uuid
      and b.project_id = ${projectId}::uuid
      and b.starts_at >= win.w_start
      and b.starts_at < win.w_end
    group by 1
    order by 2 desc, 1
  `)) as unknown as MixRow[];

  // ── forward book: live all-time snapshot (unbounded by the range) ────────────
  const snapshotRows = (await db.execute(sql`
    select
      count(*) filter (where b.starts_at >= now() and b.status = 'scheduled')::int as upcoming,
      count(*) filter (where b.starts_at < now())::int as past
    from bookings b
    where b.org_id = ${orgId}::uuid
      and b.project_id = ${projectId}::uuid
  `)) as unknown as SnapshotRow[];
  const snap = snapshotRows[0] ?? { upcoming: 0, past: 0 };

  // ── reschedule rate from the event stream (window, by occurred_at) ───────────
  const rescheduleRows = (await db.execute(sql`
    with win as (
      select
        (${from}::date::timestamp at time zone 'Europe/London') as w_start,
        ((${to}::date + 1)::timestamp at time zone 'Europe/London') as w_end
    )
    select
      count(*) filter (where e.type = 'booking.created')::int as created,
      count(*) filter (where e.type = 'booking.rescheduled')::int as rescheduled
    from events e, win
    where e.org_id = ${orgId}::uuid
      and e.project_id = ${projectId}::uuid
      and e.type like 'booking.%'
      and e.occurred_at >= win.w_start
      and e.occurred_at < win.w_end
  `)) as unknown as RescheduleRow[];
  const resched = rescheduleRows[0] ?? { created: 0, rescheduled: 0 };

  // ── derive ───────────────────────────────────────────────────────────────────
  const scheduled = num(s.scheduled);
  const completed = num(s.completed);
  const cancelled = num(s.cancelled);
  const noShow = num(s.no_show);
  const total = num(s.total);
  const resolved = completed + cancelled + noShow;

  const weekdayTotals = new Array(7).fill(0) as number[];
  const hourTotals = new Array(24).fill(0) as number[];
  const heatmap: { weekday: number; hour: number; value: number }[] = [];
  for (const h of heatRows) {
    const wd = num(h.weekday); // 1..7
    const hr = num(h.hour); // 0..23
    const v = num(h.value);
    if (wd >= 1 && wd <= 7) weekdayTotals[wd - 1]! += v;
    if (hr >= 0 && hr <= 23) hourTotals[hr]! += v;
    heatmap.push({ weekday: wd, hour: hr, value: v });
  }

  const avgLeadRaw = s.avg_lead_hours;
  const avgLeadHours =
    avgLeadRaw === null || avgLeadRaw === undefined
      ? null
      : round4(Number(avgLeadRaw));

  const body: BookingsData = {
    range: r.range,
    from,
    to,
    totalBookings: total,
    series: seriesRows.map((row) => ({
      periodStart: row.period_start,
      value: num(row.value),
    })),
    statusCounts: { scheduled, completed, cancelled, noShow },
    completedRate: rate(completed, resolved),
    cancelledRate: rate(cancelled, resolved),
    noShowRate: rate(noShow, resolved),
    rescheduleRate: rate(num(resched.rescheduled), num(resched.created)),
    avgLeadHours,
    weekdayCurve: WEEKDAY_LABELS.map((label, i) => ({
      label,
      value: weekdayTotals[i] ?? 0,
    })),
    hourCurve: hourTotals.map((value, hour) => ({
      label: `${String(hour).padStart(2, "0")}:00`,
      value,
    })),
    heatmap,
    kindMix: kindRows.map((row) => ({ label: row.label, value: num(row.value) })),
    sourceMix: sourceRows.map((row) => ({
      label: row.label,
      value: num(row.value),
    })),
    upcoming: num(snap.upcoming),
    past: num(snap.past),
  };
  return NextResponse.json(body);
});
