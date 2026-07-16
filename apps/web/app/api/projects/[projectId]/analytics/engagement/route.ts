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
  EngagementResponse,
  LabelledValue,
  SeriesPoint,
} from "../../../../../../components/analytics/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ projectId: string }> };

/**
 * ENGAGEMENT & USAGE — how much the client's end-users actually use the system.
 *
 * READ-ONLY: every statement is a SELECT/WITH over `events`, scoped to
 * (org_id, project_id) and an inclusive [from,to] window of London calendar
 * days resolved to UTC instants in Postgres with the shared
 * `… at time zone 'Europe/London'` pattern (DST-correct). An "end-user" is any
 * event carrying a `subject` (customer / lead / patient / …); the agency's own
 * agents/systems live in `actor`, so subject-identity is the right unit for
 * unique / new / returning users. Never throws on empty data — every metric
 * degrades to 0 / [] / null.
 *
 * The wire shape extends the foundation `EngagementResponse` (range/from/to/
 * totalEvents/heatmap/topEvents kept intact; richer fields ADDED).
 */
export interface EngagementData extends EngagementResponse {
  /** llm.conversation count in window */
  totalConversations: number;
  /** distinct end-users (subject id, falling back to name) active in window */
  uniqueUsers: number;
  /** active users whose first-ever event in this project falls inside the window */
  newUsers: number;
  /** active users first seen before the window opened */
  returningUsers: number;
  /** sessions ≈ conversations */
  sessions: number;
  /** mean turns per conversation; null when no turn data */
  avgTurns: number | null;
  /** mean conversation duration in seconds; null when no duration data */
  avgSessionSeconds: number | null;
  /** message.received + inbound calls */
  inboundMessages: number;
  /** message.sent + email.sent + outbound calls */
  outboundMessages: number;
  /** channel mix across conversations / messages / email / calls */
  channelMix: LabelledValue[];
  /** distinct active end-users per London day */
  activeUsersSeries: SeriesPoint[];
  /** count of login/session-style custom events (0 when the product emits none) */
  logins: number;
  /** whether any login/session custom events exist in window */
  hasLoginEvents: boolean;
  /**
   * P9-PACK2 additive: end-user retention cohorts — 8 rolling 7-day blocks
   * ending "today" (`to`), independent of the `?range=` selector (always the
   * most recent ~56 days, comfortably inside the 90d lookback the contract
   * describes). Block 7 is the most recent (possibly partial) week, block 0
   * is 7 weeks earlier. A subject's cohort is the block its ALL-TIME
   * first-ever event falls in; a cohort cell tracks the % of that cohort
   * still active `offset` blocks later — naturally triangular since offset
   * cannot exceed `7 - cohortBlock`.
   */
  retentionCohorts: RetentionCohortRow[];
  /** weighted % of cohort subjects still active exactly 1 block after cohort start; null with no data at that horizon. */
  retentionWeek1Pct: number | null;
  /** weighted % of cohort subjects still active exactly 4 blocks after cohort start; null with no data at that horizon. */
  retentionWeek4Pct: number | null;
  /**
   * P9-PACK2 additive: channel-shift — each channel's share of channelled
   * activity this window vs the prior equal-length window, so a mix change
   * (e.g. voice giving way to chat) reads as a delta chip, not just a ring.
   */
  channelShift: ChannelShiftRow[];
}

export interface RetentionCohortCell {
  /** blocks since the cohort's first-seen block (0..7-cohortBlock). */
  offset: number;
  activeCount: number;
  /** 0..100, one decimal; null only if cohortSize is 0 (never rendered). */
  activePct: number | null;
}

export interface RetentionCohortRow {
  /** 0 (oldest tracked cohort) .. 7 (this block, most recent). */
  block: number;
  /** London calendar day the cohort's 7-day block starts on. */
  blockStart: string;
  cohortSize: number;
  cells: RetentionCohortCell[];
}

export interface ChannelShiftRow {
  label: string;
  /** share of this window's channelled activity, 0..100. */
  currentPct: number;
  /** share of the prior equal-length window's channelled activity, 0..100. */
  priorPct: number;
  /** percentage-point change, currentPct - priorPct. */
  deltaPct: number;
}

const num = (v: unknown): number => Number(v ?? 0);
const round1 = (n: number): number => Math.round(n * 10) / 10;

interface OverviewRow {
  total_events: number | string;
  conversations: number | string;
  unique_users: number | string;
  msg_in: number | string;
  msg_out: number | string;
  call_in: number | string;
  call_out: number | string;
  avg_turns: number | string | null;
  avg_dur: number | string | null;
  has_turns: number | string;
  has_dur: number | string;
  logins: number | string;
}
interface NewReturningRow {
  new_users: number | string;
  returning_users: number | string;
}
interface LabelRow {
  label: string;
  value: number | string;
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
interface RetentionSqlRow {
  cohort_block: number | string;
  block_start: string;
  cohort_size: number | string;
  active_block: number | string | null;
  active_count: number | string;
}
interface ChannelShiftSqlRow {
  label: string | null;
  current_count: number | string;
  prior_count: number | string;
}

export const GET = withErrorHandling(async (req: Request, { params }: Ctx) => {
  const orgId = await requireOrgId();
  const { projectId } = await params;
  if (!isUuid(projectId)) return jsonError(404, "project_not_found");

  const r = parseRange(new URL(req.url).searchParams);
  const project = await getProjectForAnalytics(orgId, projectId);
  if (!project) return jsonError(404, "project_not_found");

  const from = r.fromDay;
  const to = r.toDay;

  // Shared window CTE fragment. `ev` = all in-window events for this project.
  // ── overview scalars (one round-trip) ───────────────────────────────────────
  const overviewRows = (await db.execute(sql`
    with win as (
      select
        (${from}::date::timestamp at time zone 'Europe/London') as w_start,
        (((${to}::date) + 1)::timestamp at time zone 'Europe/London') as w_end
    ),
    ev as (
      select e.type, e.subject, e.data
      from events e, win
      where e.org_id = ${orgId}::uuid
        and e.project_id = ${projectId}::uuid
        and e.occurred_at >= win.w_start
        and e.occurred_at < win.w_end
    )
    select
      (select count(*) from ev)::int as total_events,
      (select count(*) from ev where type = 'llm.conversation')::int as conversations,
      (select count(distinct coalesce(subject->>'id', subject->>'name'))
         from ev
        where subject is not null
          and coalesce(subject->>'id', subject->>'name') is not null)::int as unique_users,
      (select count(*) from ev where type = 'message.received')::int as msg_in,
      (select count(*) from ev where type in ('message.sent', 'email.sent'))::int as msg_out,
      (select count(*) from ev where type = 'call.completed' and data->>'direction' = 'inbound')::int as call_in,
      (select count(*) from ev where type = 'call.completed' and data->>'direction' = 'outbound')::int as call_out,
      (select coalesce(avg((data->>'turns')::numeric), 0)
         from ev where type = 'llm.conversation' and (data->>'turns') is not null) as avg_turns,
      (select coalesce(avg((data->>'duration_seconds')::numeric), 0)
         from ev where type = 'llm.conversation' and (data->>'duration_seconds') is not null) as avg_dur,
      (select count(*) from ev where type = 'llm.conversation' and (data->>'turns') is not null)::int as has_turns,
      (select count(*) from ev where type = 'llm.conversation' and (data->>'duration_seconds') is not null)::int as has_dur,
      (select count(*) from ev where type ilike 'custom.%login%' or type ilike 'custom.%session%')::int as logins
  `)) as unknown as OverviewRow[];
  const o = overviewRows[0]!;

  // ── new vs returning end-users (first-seen classification, all-time) ─────────
  const nrRows = (await db.execute(sql`
    with win as (
      select
        (${from}::date::timestamp at time zone 'Europe/London') as w_start,
        (((${to}::date) + 1)::timestamp at time zone 'Europe/London') as w_end
    ),
    firsts as (
      select coalesce(e.subject->>'id', e.subject->>'name') as uid, min(e.occurred_at) as first_seen
      from events e, win
      where e.org_id = ${orgId}::uuid
        and e.project_id = ${projectId}::uuid
        and e.subject is not null
        and coalesce(e.subject->>'id', e.subject->>'name') is not null
        and e.occurred_at < win.w_end
      group by 1
    ),
    active as (
      select distinct coalesce(e.subject->>'id', e.subject->>'name') as uid
      from events e, win
      where e.org_id = ${orgId}::uuid
        and e.project_id = ${projectId}::uuid
        and e.subject is not null
        and coalesce(e.subject->>'id', e.subject->>'name') is not null
        and e.occurred_at >= win.w_start
        and e.occurred_at < win.w_end
    )
    select
      count(*) filter (where f.first_seen >= (select w_start from win))::int as new_users,
      count(*) filter (where f.first_seen <  (select w_start from win))::int as returning_users
    from active a
    join firsts f on f.uid = a.uid
  `)) as unknown as NewReturningRow[];
  const nr = nrRows[0] ?? { new_users: 0, returning_users: 0 };

  // ── channel mix (conversations / messages / email / calls) ───────────────────
  const channelRows = (await db.execute(sql`
    with win as (
      select
        (${from}::date::timestamp at time zone 'Europe/London') as w_start,
        (((${to}::date) + 1)::timestamp at time zone 'Europe/London') as w_end
    )
    select ch as label, count(*)::int as value
    from (
      select case
        when e.type = 'llm.conversation' then coalesce(e.data->>'channel', 'unknown')
        when e.type in ('message.sent', 'message.received') then coalesce(e.data->>'channel', 'unknown')
        when e.type in ('email.sent', 'email.opened') then 'email'
        when e.type = 'call.completed' then 'voice'
      end as ch
      from events e, win
      where e.org_id = ${orgId}::uuid
        and e.project_id = ${projectId}::uuid
        and e.occurred_at >= win.w_start
        and e.occurred_at < win.w_end
        and e.type in ('llm.conversation', 'message.sent', 'message.received', 'email.sent', 'email.opened', 'call.completed')
    ) t
    where ch is not null
    group by ch
    order by value desc
  `)) as unknown as LabelRow[];

  // ── busiest hour × weekday heatmap (end-user events, London tz) ──────────────
  const heatRows = (await db.execute(sql`
    with win as (
      select
        (${from}::date::timestamp at time zone 'Europe/London') as w_start,
        (((${to}::date) + 1)::timestamp at time zone 'Europe/London') as w_end
    )
    select
      extract(isodow from e.occurred_at at time zone 'Europe/London')::int as weekday,
      extract(hour   from e.occurred_at at time zone 'Europe/London')::int as hour,
      count(*)::int as value
    from events e, win
    where e.org_id = ${orgId}::uuid
      and e.project_id = ${projectId}::uuid
      and e.subject is not null
      and e.occurred_at >= win.w_start
      and e.occurred_at < win.w_end
    group by 1, 2
    order by 1, 2
  `)) as unknown as HeatRow[];

  // ── active end-users per London day ──────────────────────────────────────────
  // Zero-filled across every London day in [from,to] via generate_series (same
  // convention as pulse/route.ts), so quiet days (e.g. Sundays with no end-user
  // activity) render as dips to 0 rather than collapsing out. The LineChart/
  // MiniTrend position points by array index, not by date, so absent days would
  // otherwise distort the time axis and mis-locate the x-axis date labels.
  const activeRows = (await db.execute(sql`
    with win as (
      select
        (${from}::date::timestamp at time zone 'Europe/London') as w_start,
        (((${to}::date) + 1)::timestamp at time zone 'Europe/London') as w_end
    ),
    days as (
      select generate_series(${from}::date, ${to}::date, interval '1 day')::date as d
    ),
    active as (
      select
        (e.occurred_at at time zone 'Europe/London')::date as d,
        count(distinct coalesce(e.subject->>'id', e.subject->>'name'))::int as value
      from events e, win
      where e.org_id = ${orgId}::uuid
        and e.project_id = ${projectId}::uuid
        and e.subject is not null
        and coalesce(e.subject->>'id', e.subject->>'name') is not null
        and e.occurred_at >= win.w_start
        and e.occurred_at < win.w_end
      group by 1
    )
    select
      to_char((days.d::timestamp at time zone 'Europe/London') at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS"Z"') as period_start,
      coalesce(active.value, 0)::int as value
    from days
    left join active on active.d = days.d
    order by days.d
  `)) as unknown as SeriesRow[];

  // ── top event types ──────────────────────────────────────────────────────────
  const topRows = (await db.execute(sql`
    with win as (
      select
        (${from}::date::timestamp at time zone 'Europe/London') as w_start,
        (((${to}::date) + 1)::timestamp at time zone 'Europe/London') as w_end
    )
    select e.type as label, count(*)::int as value
    from events e, win
    where e.org_id = ${orgId}::uuid
      and e.project_id = ${projectId}::uuid
      and e.occurred_at >= win.w_start
      and e.occurred_at < win.w_end
    group by e.type
    order by value desc, e.type asc
    limit 12
  `)) as unknown as LabelRow[];

  // ── P9-PACK2 · retention cohorts (8 rolling 7-day blocks ending `to`) ────────
  // Fixed lookback, independent of `range`: block 7 = this (possibly partial)
  // week, block 0 = 7 weeks earlier. A subject's cohort = the block their
  // ALL-TIME first-ever event (any type, with a subject) falls in; "active"
  // in a later block = any subject-bearing event in that block. The triangle
  // shape falls out naturally from `active_block >= cohort_block` capped at 7.
  const retentionRows = (await db.execute(sql`
    with anchor as (
      select ${to}::date as today_ld
    ),
    blocks as (
      select
        gs as block_index,
        ((select today_ld from anchor) - ((7 - gs) * 7 + 6)) as block_start_ld,
        ((select today_ld from anchor) - (7 - gs) * 7) as block_end_ld
      from generate_series(0, 7) as gs
    ),
    bounds as (
      select
        block_index,
        block_start_ld,
        (block_start_ld::timestamp at time zone 'Europe/London') as b_start,
        ((block_end_ld + 1)::timestamp at time zone 'Europe/London') as b_end
      from blocks
    ),
    subj_first as (
      select
        coalesce(e.subject->>'id', e.subject->>'name') as sid,
        min(e.occurred_at) as first_seen
      from events e
      where e.org_id = ${orgId}::uuid
        and e.project_id = ${projectId}::uuid
        and e.subject is not null
        and coalesce(e.subject->>'id', e.subject->>'name') is not null
      group by 1
    ),
    cohort as (
      select sf.sid, b.block_index as cohort_block, b.block_start_ld
      from subj_first sf
      join bounds b on sf.first_seen >= b.b_start and sf.first_seen < b.b_end
    ),
    activity as (
      select distinct
        coalesce(e.subject->>'id', e.subject->>'name') as sid,
        b.block_index as active_block
      from events e
      join bounds b on e.occurred_at >= b.b_start and e.occurred_at < b.b_end
      where e.org_id = ${orgId}::uuid
        and e.project_id = ${projectId}::uuid
        and e.subject is not null
        and coalesce(e.subject->>'id', e.subject->>'name') is not null
    ),
    sizes as (
      select
        cohort_block,
        min(block_start_ld) as block_start_ld,
        count(distinct sid)::int as cohort_size
      from cohort
      group by cohort_block
    ),
    grid as (
      select c.cohort_block, a.active_block, count(distinct c.sid)::int as active_count
      from cohort c
      join activity a on a.sid = c.sid and a.active_block >= c.cohort_block
      group by c.cohort_block, a.active_block
    )
    select
      s.cohort_block,
      to_char(s.block_start_ld, 'YYYY-MM-DD') as block_start,
      s.cohort_size,
      g.active_block,
      coalesce(g.active_count, 0)::int as active_count
    from sizes s
    left join grid g on g.cohort_block = s.cohort_block
    order by s.cohort_block, g.active_block
  `)) as unknown as RetentionSqlRow[];

  const retentionByBlock = new Map<number, RetentionCohortRow>();
  for (const row of retentionRows) {
    const block = num(row.cohort_block);
    const cohortSize = num(row.cohort_size);
    let entry = retentionByBlock.get(block);
    if (!entry) {
      entry = { block, blockStart: row.block_start, cohortSize, cells: [] };
      retentionByBlock.set(block, entry);
    }
    if (row.active_block !== null) {
      const offset = num(row.active_block) - block;
      const activeCount = num(row.active_count);
      entry.cells.push({
        offset,
        activeCount,
        activePct: cohortSize > 0 ? round1((activeCount / cohortSize) * 100) : null,
      });
    }
  }
  const retentionCohorts = [...retentionByBlock.values()].sort((a, b) => a.block - b.block);

  /** Weighted % of cohort subjects still active exactly `k` blocks later. */
  function weightedRetention(k: number): number | null {
    let num_ = 0;
    let denom = 0;
    for (const row of retentionCohorts) {
      if (row.block > 7 - k) continue; // this horizon hasn't happened yet for this cohort
      denom += row.cohortSize;
      num_ += row.cells.find((c) => c.offset === k)?.activeCount ?? 0;
    }
    return denom > 0 ? round1((num_ / denom) * 100) : null;
  }
  const retentionWeek1Pct = weightedRetention(1);
  const retentionWeek4Pct = weightedRetention(4);

  // ── P9-PACK2 · channel-shift (this window vs the prior equal window) ────────
  const channelShiftRows = (await db.execute(sql`
    with windows as (
      select
        (${from}::date::timestamp at time zone 'Europe/London') as cur_start,
        (((${to}::date) + 1)::timestamp at time zone 'Europe/London') as cur_end,
        ((${from}::date - ${r.days}::int)::timestamp at time zone 'Europe/London') as prior_start,
        (${from}::date::timestamp at time zone 'Europe/London') as prior_end
    ),
    ev as (
      select
        e.occurred_at,
        case
          when e.type = 'llm.conversation' then coalesce(e.data->>'channel', 'unknown')
          when e.type in ('message.sent', 'message.received') then coalesce(e.data->>'channel', 'unknown')
          when e.type in ('email.sent', 'email.opened') then 'email'
          when e.type = 'call.completed' then 'voice'
        end as ch
      from events e, windows w
      where e.org_id = ${orgId}::uuid
        and e.project_id = ${projectId}::uuid
        and e.type in ('llm.conversation', 'message.sent', 'message.received', 'email.sent', 'email.opened', 'call.completed')
        and e.occurred_at >= w.prior_start
        and e.occurred_at < w.cur_end
    )
    select
      ch as label,
      (count(*) filter (where ev.occurred_at >= w.cur_start and ev.occurred_at < w.cur_end))::int as current_count,
      (count(*) filter (where ev.occurred_at >= w.prior_start and ev.occurred_at < w.prior_end))::int as prior_count
    from ev, windows w
    where ch is not null
    group by ch
    order by current_count desc, ch asc
  `)) as unknown as ChannelShiftSqlRow[];

  const shiftCurrentTotal = channelShiftRows.reduce((s, r) => s + num(r.current_count), 0);
  const shiftPriorTotal = channelShiftRows.reduce((s, r) => s + num(r.prior_count), 0);
  const channelShift: ChannelShiftRow[] = channelShiftRows.slice(0, 8).map((row) => {
    const cur = num(row.current_count);
    const prior = num(row.prior_count);
    const currentPct = shiftCurrentTotal > 0 ? round1((cur / shiftCurrentTotal) * 100) : 0;
    const priorPct = shiftPriorTotal > 0 ? round1((prior / shiftPriorTotal) * 100) : 0;
    return {
      label: row.label ?? "unknown",
      currentPct,
      priorPct,
      deltaPct: round1(currentPct - priorPct),
    };
  });

  const conversations = num(o.conversations);
  const inbound = num(o.msg_in) + num(o.call_in);
  const outbound = num(o.msg_out) + num(o.call_out);
  const logins = num(o.logins);

  const body: EngagementData = {
    range: r.range,
    from,
    to,
    totalEvents: num(o.total_events),
    heatmap: heatRows.map((h) => ({
      weekday: num(h.weekday),
      hour: num(h.hour),
      value: num(h.value),
    })),
    topEvents: topRows.map((t): LabelledValue => ({ label: t.label, value: num(t.value) })),
    totalConversations: conversations,
    uniqueUsers: num(o.unique_users),
    newUsers: num(nr.new_users),
    returningUsers: num(nr.returning_users),
    sessions: conversations,
    avgTurns: num(o.has_turns) > 0 ? round1(num(o.avg_turns)) : null,
    avgSessionSeconds: num(o.has_dur) > 0 ? Math.round(num(o.avg_dur)) : null,
    inboundMessages: inbound,
    outboundMessages: outbound,
    channelMix: channelRows.map((c): LabelledValue => ({ label: c.label, value: num(c.value) })),
    activeUsersSeries: activeRows.map((a): SeriesPoint => ({
      periodStart: a.period_start,
      value: num(a.value),
    })),
    logins,
    hasLoginEvents: logins > 0,
    retentionCohorts,
    retentionWeek1Pct,
    retentionWeek4Pct,
    channelShift,
  };
  return NextResponse.json(body);
});
