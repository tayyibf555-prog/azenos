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
  FeedbackBoardItem,
  FeedbackData,
  FeedbackItemStatus,
} from "../../../../../../components/analytics/sections/FeedbackSection";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ projectId: string }> };

const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const round4 = (n: number): number => Math.round(n * 10000) / 10000;

interface RangeCountRow {
  total_this_range: number | string;
  total_prev_range: number | string;
}
interface SeriesRow {
  period_start: string;
  value: number | string;
}
interface KindRow {
  label: string;
  value: number | string;
}
interface SeverityRow {
  label: string;
  value: number | string;
}
interface StatusRow {
  status: FeedbackItemStatus;
  count: number | string;
}
interface ResolutionRow {
  done: number | string;
  total: number | string;
}
interface BoardRow {
  id: string;
  kind: string;
  severity: number | null;
  message: string;
  submitter_name: string | null;
  submitter_email: string | null;
  page_url: string | null;
  status: FeedbackItemStatus;
  created_at: string;
  rn: number | string;
}
interface RecentRow {
  id: string;
  kind: string;
  severity: number | null;
  message: string;
  submitter_name: string | null;
  submitter_email: string | null;
  page_url: string | null;
  status: FeedbackItemStatus;
  created_at: string;
}
interface SubmitterRow {
  label: string;
  value: number | string;
}

const STATUS_FLOW: FeedbackItemStatus[] = ["new", "seen", "planned", "done"];
const BOARD_CAP = 25;
const RECENT_CAP = 20;
const LEADERBOARD_CAP = 10;

/**
 * P7-ANALYTICS · Feedback — the triage inbox for `feedback.submitted` events
 * (docs/phase7/PLAN.md §B2). Read-only SELECT/WITH over `feedback_items`,
 * always scoped to (org_id, project_id).
 *
 * Two families of numbers, deliberately on different clocks (see the doc
 * comment on `FeedbackData` in FeedbackSection.tsx):
 *   - RANGE-scoped: total-this-range vs the equal-length prior period, the
 *     zero-filled daily series, kind mix, severity mix — all bounded to the
 *     selected [from, to] London-day window, by `created_at`.
 *   - LIVE all-time: status counts, resolution rate, the triage board
 *     (newest-first, capped per column via `row_number() over (partition by
 *     status …)`), the 20 most recent items across every status, and the
 *     submitter leaderboard. A backlog doesn't reset when someone flips the
 *     range control, same rationale as Bookings' `upcoming`/`past`.
 *
 * Never throws on an empty project: zero counts, [] series/mix/board/recent,
 * a null resolution rate.
 */
export const GET = withErrorHandling(async (req: Request, { params }: Ctx) => {
  const orgId = await requireOrgId();
  const { projectId } = await params;
  if (!isUuid(projectId)) return jsonError(404, "project_not_found");

  const r = parseRange(new URL(req.url).searchParams);
  const project = await getProjectForAnalytics(orgId, projectId);
  if (!project) return jsonError(404, "project_not_found");

  const from = r.fromDay;
  const to = r.toDay;

  // ── range total vs the equal-length prior period ──────────────────────────
  const rangeRows = (await db.execute(sql`
    with win as (
      select
        (${from}::date::timestamp at time zone 'Europe/London') as w_start,
        ((${to}::date + 1)::timestamp at time zone 'Europe/London') as w_end
    ),
    prevwin as (
      select
        win.w_start - (win.w_end - win.w_start) as p_start,
        win.w_start as p_end
      from win
    )
    select
      (select count(*) from feedback_items f, win
         where f.org_id = ${orgId}::uuid and f.project_id = ${projectId}::uuid
           and f.created_at >= win.w_start and f.created_at < win.w_end)::int
        as total_this_range,
      (select count(*) from feedback_items f, prevwin
         where f.org_id = ${orgId}::uuid and f.project_id = ${projectId}::uuid
           and f.created_at >= prevwin.p_start and f.created_at < prevwin.p_end)::int
        as total_prev_range
  `)) as unknown as RangeCountRow[];
  const rangeRow = rangeRows[0] ?? { total_this_range: 0, total_prev_range: 0 };

  // ── zero-filled daily volume across the selected window ───────────────────
  const seriesRows = (await db.execute(sql`
    with days as (
      select generate_series(${from}::date, ${to}::date, interval '1 day')::date as d
    ),
    fi as (
      select (created_at at time zone 'Europe/London')::date as d, count(*)::int as c
      from feedback_items
      where org_id = ${orgId}::uuid and project_id = ${projectId}::uuid
        and created_at >= (${from}::date::timestamp at time zone 'Europe/London')
        and created_at <  ((${to}::date + 1)::timestamp at time zone 'Europe/London')
      group by 1
    )
    select
      to_char((days.d::timestamp at time zone 'Europe/London') at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS"Z"') as period_start,
      coalesce(fi.c, 0)::int as value
    from days
    left join fi on fi.d = days.d
    order by days.d
  `)) as unknown as SeriesRow[];

  // ── kind mix over the window ───────────────────────────────────────────────
  const kindRows = (await db.execute(sql`
    select kind::text as label, count(*)::int as value
    from feedback_items
    where org_id = ${orgId}::uuid and project_id = ${projectId}::uuid
      and created_at >= (${from}::date::timestamp at time zone 'Europe/London')
      and created_at <  ((${to}::date + 1)::timestamp at time zone 'Europe/London')
    group by 1
    order by 2 desc, 1
  `)) as unknown as KindRow[];

  // ── severity mix over the window (bugs only carry a severity) ─────────────
  const severityRows = (await db.execute(sql`
    select
      case severity when 3 then 'Blocking' when 2 then 'Annoying' when 1 then 'Minor'
        else 'Unspecified' end as label,
      count(*)::int as value
    from feedback_items
    where org_id = ${orgId}::uuid and project_id = ${projectId}::uuid
      and created_at >= (${from}::date::timestamp at time zone 'Europe/London')
      and created_at <  ((${to}::date + 1)::timestamp at time zone 'Europe/London')
    group by 1
    order by 2 desc, 1
  `)) as unknown as SeverityRow[];

  // ── LIVE all-time snapshot: status counts + resolution ────────────────────
  const statusRows = (await db.execute(sql`
    select status::text as status, count(*)::int as count
    from feedback_items
    where org_id = ${orgId}::uuid and project_id = ${projectId}::uuid
    group by 1
  `)) as unknown as StatusRow[];

  const resolutionRows = (await db.execute(sql`
    select
      count(*) filter (where status = 'done')::int as done,
      count(*)::int as total
    from feedback_items
    where org_id = ${orgId}::uuid and project_id = ${projectId}::uuid
  `)) as unknown as ResolutionRow[];
  const resolutionRow = resolutionRows[0] ?? { done: 0, total: 0 };

  // ── LIVE triage board: newest-first, capped per column IN SQL ──────────────
  // The per-status cap is enforced by the outer `rn <= BOARD_CAP` filter so the
  // query returns at most 4×BOARD_CAP rows — never the whole (potentially huge)
  // table — regardless of total feedback volume.
  const boardRows = (await db.execute(sql`
    select * from (
      select id, kind::text as kind, severity, message,
        submitter_name, submitter_email, page_url, status::text as status,
        to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as created_at,
        row_number() over (partition by status order by created_at desc) as rn
      from feedback_items
      where org_id = ${orgId}::uuid and project_id = ${projectId}::uuid
    ) ranked
    where ranked.rn <= ${BOARD_CAP}
  `)) as unknown as BoardRow[];

  // ── LIVE recent 20, any status ──────────────────────────────────────────────
  const recentRows = (await db.execute(sql`
    select id, kind::text as kind, severity, message,
      submitter_name, submitter_email, page_url, status::text as status,
      to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as created_at
    from feedback_items
    where org_id = ${orgId}::uuid and project_id = ${projectId}::uuid
    order by created_at desc
    limit ${RECENT_CAP}
  `)) as unknown as RecentRow[];

  // ── LIVE submitter leaderboard (name/email, or bucketed "Anonymous") ───────
  const submitterRows = (await db.execute(sql`
    select coalesce(submitter_name, submitter_email, 'Anonymous') as label,
      count(*)::int as value
    from feedback_items
    where org_id = ${orgId}::uuid and project_id = ${projectId}::uuid
    group by 1
    order by 2 desc, 1
    limit ${LEADERBOARD_CAP}
  `)) as unknown as SubmitterRow[];

  // ── assemble ────────────────────────────────────────────────────────────────
  const toBoardItem = (row: BoardRow | RecentRow): FeedbackBoardItem => ({
    id: row.id,
    kind: row.kind as FeedbackBoardItem["kind"],
    severity: row.severity === null || row.severity === undefined ? null : num(row.severity),
    message: row.message,
    submitterName: row.submitter_name,
    submitterEmail: row.submitter_email,
    pageUrl: row.page_url,
    status: row.status,
    createdAt: row.created_at,
  });

  const board = STATUS_FLOW.map((status) => ({
    status,
    items: boardRows
      .filter((row) => row.status === status && num(row.rn) <= BOARD_CAP)
      .map(toBoardItem),
  }));

  const statusCounts: Record<FeedbackItemStatus, number> = {
    new: 0,
    seen: 0,
    planned: 0,
    done: 0,
  };
  for (const row of statusRows) {
    statusCounts[row.status] = num(row.count);
  }

  const done = num(resolutionRow.done);
  const total = num(resolutionRow.total);

  const body: FeedbackData = {
    range: r.range,
    from,
    to,
    totalThisRange: num(rangeRow.total_this_range),
    prevRangeTotal: num(rangeRow.total_prev_range),
    series: seriesRows.map((row) => ({
      periodStart: row.period_start,
      value: num(row.value),
    })),
    kindMix: kindRows.map((row) => ({ label: row.label, value: num(row.value) })),
    severityMix: severityRows.map((row) => ({ label: row.label, value: num(row.value) })),
    statusCounts,
    resolution: { done, total, rate: total > 0 ? round4(done / total) : null },
    board,
    recentItems: recentRows.map(toBoardItem),
    submitterLeaderboard: submitterRows.map((row) => ({
      label: row.label,
      value: num(row.value),
    })),
  };
  return NextResponse.json(body);
});
