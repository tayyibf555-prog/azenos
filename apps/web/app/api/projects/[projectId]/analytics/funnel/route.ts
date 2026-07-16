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
  FunnelResponse,
  LabelledValue,
  SeriesPoint,
} from "../../../../../../components/analytics/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ projectId: string }> };

/**
 * Funnel & Conversion — the revenue funnel for one project.
 *
 * READ-ONLY SELECT/WITH over the `events` spine, org- + project-scoped, London
 * calendar-day window resolved in SQL. Five stages:
 *   lead.created → lead.qualified → booking.created → booking.completed →
 *   payment.captured / invoice.paid
 * with per-stage conversion (from previous + from top), drop-off, an
 * approximate avg lag between stages (mean event-time delta), a lead-source
 * breakdown (lead.created source vs form.submitted), and a leads-over-time
 * trend. Never throws on an empty project — returns zeros / [].
 */

/** Per-stage detail beyond the flat `stages` contract. */
export interface FunnelStageDetail {
  key: string;
  label: string;
  count: number;
  /** count ÷ previous stage, 0..100; null for the top stage or empty previous. */
  fromPrevPct: number | null;
  /** count ÷ top stage, 0..100; null when there are no leads. */
  fromTopPct: number | null;
  /** entities lost since the previous stage (never negative). */
  dropFromPrev: number;
  /**
   * Approximate lag from the previous stage: the difference between the mean
   * occurred_at of each stage, in hours. Aggregate proxy (events carry no
   * reliable cross-stage join key), null when a stage is empty or the delta
   * is negative.
   */
  avgLagHoursFromPrev: number | null;
}

/** Richer funnel payload — extends the flat foundation contract. */
export interface FunnelData extends FunnelResponse {
  stageDetail: FunnelStageDetail[];
  leadTotal: number;
  paidTotal: number;
  /** paid ÷ leads, 0..100; null when there are no leads. */
  overallConversionPct: number | null;
  /** the single steepest stage-to-stage drop, for a headline callout. */
  biggestDrop: { fromLabel: string; toLabel: string; dropPct: number } | null;
  /** leads split by source / channel (lead.created source + form submissions). */
  sources: LabelledValue[];
  /** daily lead.created counts, London day buckets, ascending, present days. */
  leadsSeries: SeriesPoint[];
  /**
   * P9-PACK2 additive: REAL stage-to-stage time percentiles, computed by
   * matching individual entities across stages via `subject.id` (falling
   * back to `subject.name`) — unlike `avgLagHoursFromPrev` above (a
   * structural mean-time-of-stage proxy, since most events carry no
   * cross-stage join key), this only uses entities seen at BOTH adjacent
   * stages in-window, so it degrades to null/0 gracefully when subjects
   * aren't tagged.
   */
  stagePercentiles: FunnelStagePercentile[];
  /** top intents of llm.conversation events that ended `resolution: abandoned` in window — a drop-off reasons hint. */
  abandonedIntents: LabelledValue[];
}

export interface FunnelStagePercentile {
  key: string;
  fromLabel: string;
  toLabel: string;
  /** entities matched at both stages, delta >= 0. */
  sampleSize: number;
  p50Hours: number | null;
  p90Hours: number | null;
}

interface StageRow {
  leads: number | string;
  qualified: number | string;
  booked: number | string;
  completed: number | string;
  paid: number | string;
  t_leads: number | string | null;
  t_qualified: number | string | null;
  t_booked: number | string | null;
  t_completed: number | string | null;
  t_paid: number | string | null;
}

interface SourceRow {
  label: string;
  value: number | string;
}

interface SeriesRow {
  period_start: string;
  value: number | string;
}

interface PercentileSqlRow {
  n1: number | string;
  p50_1: number | string | null;
  p90_1: number | string | null;
  n2: number | string;
  p50_2: number | string | null;
  p90_2: number | string | null;
  n3: number | string;
  p50_3: number | string | null;
  p90_3: number | string | null;
  n4: number | string;
  p50_4: number | string | null;
  p90_4: number | string | null;
}

interface IntentRow {
  intent: string;
  value: number | string;
}

const num = (v: unknown): number => Number(v ?? 0);
const numOrNull = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v);
const round1 = (n: number): number => Math.round(n * 10) / 10;

export const GET = withErrorHandling(async (req: Request, { params }: Ctx) => {
  const orgId = await requireOrgId();
  const { projectId } = await params;
  if (!isUuid(projectId)) return jsonError(404, "project_not_found");

  const r = parseRange(new URL(req.url).searchParams);
  const project = await getProjectForAnalytics(orgId, projectId);
  if (!project) return jsonError(404, "project_not_found");

  const from = r.fromDay;
  const to = r.toDay;

  // ── stage counts + mean event time (epoch seconds) per stage ────────────────
  const stageRows = (await db.execute(sql`
    with win as (
      select
        (${from}::date::timestamp at time zone 'Europe/London') as w_start,
        (((${to}::date) + 1)::timestamp at time zone 'Europe/London') as w_end
    ),
    ev as (
      select e.type, e.occurred_at
      from events e, win
      where e.org_id = ${orgId}::uuid
        and e.project_id = ${projectId}::uuid
        and e.occurred_at >= win.w_start
        and e.occurred_at < win.w_end
        and e.type in (
          'lead.created', 'lead.qualified', 'booking.created',
          'booking.completed', 'payment.captured', 'invoice.paid'
        )
    )
    select
      count(*) filter (where type = 'lead.created')::int as leads,
      count(*) filter (where type = 'lead.qualified')::int as qualified,
      count(*) filter (where type = 'booking.created')::int as booked,
      count(*) filter (where type = 'booking.completed')::int as completed,
      count(*) filter (where type in ('payment.captured', 'invoice.paid'))::int as paid,
      avg(extract(epoch from occurred_at)) filter (where type = 'lead.created') as t_leads,
      avg(extract(epoch from occurred_at)) filter (where type = 'lead.qualified') as t_qualified,
      avg(extract(epoch from occurred_at)) filter (where type = 'booking.created') as t_booked,
      avg(extract(epoch from occurred_at)) filter (where type = 'booking.completed') as t_completed,
      avg(extract(epoch from occurred_at)) filter (where type in ('payment.captured', 'invoice.paid')) as t_paid
    from ev
  `)) as unknown as StageRow[];

  const s = stageRows[0] ?? {
    leads: 0,
    qualified: 0,
    booked: 0,
    completed: 0,
    paid: 0,
    t_leads: null,
    t_qualified: null,
    t_booked: null,
    t_completed: null,
    t_paid: null,
  };

  const raw = [
    { key: "leads", label: "Leads", count: num(s.leads), t: numOrNull(s.t_leads) },
    {
      key: "qualified",
      label: "Qualified",
      count: num(s.qualified),
      t: numOrNull(s.t_qualified),
    },
    { key: "booked", label: "Booked", count: num(s.booked), t: numOrNull(s.t_booked) },
    {
      key: "completed",
      label: "Attended",
      count: num(s.completed),
      t: numOrNull(s.t_completed),
    },
    { key: "paid", label: "Paid", count: num(s.paid), t: numOrNull(s.t_paid) },
  ];

  const top = raw[0]!.count;

  const stageDetail: FunnelStageDetail[] = raw.map((st, i) => {
    const prev = i > 0 ? raw[i - 1]! : null;
    const fromPrevPct =
      prev && prev.count > 0 ? round1((st.count / prev.count) * 100) : null;
    const fromTopPct = top > 0 ? round1((st.count / top) * 100) : null;
    const dropFromPrev = prev ? Math.max(0, prev.count - st.count) : 0;
    let avgLagHoursFromPrev: number | null = null;
    if (prev && prev.t !== null && st.t !== null) {
      const h = (st.t - prev.t) / 3600;
      avgLagHoursFromPrev = h >= 0 ? round1(h) : null;
    }
    return {
      key: st.key,
      label: st.label,
      count: st.count,
      fromPrevPct,
      fromTopPct,
      dropFromPrev,
      avgLagHoursFromPrev,
    };
  });

  // Drop-off is only meaningful between INSTRUMENTED stages. A stage that is
  // structurally empty while a later stage still has entities is un-instrumented
  // (the demo never emits lead.qualified / booking.completed, so leads flow
  // straight through to booking.created / payment.captured) — measuring a drop
  // into it yields a false -100% cliff. Fold those pass-through zeros out before
  // ranking drops, so the headline reflects a real stage-to-stage loss.
  const effective = raw.filter(
    (st, i) => st.count > 0 || !raw.slice(i + 1).some((later) => later.count > 0),
  );
  let biggestDrop: FunnelData["biggestDrop"] = null;
  for (let i = 1; i < effective.length; i++) {
    const prev = effective[i - 1]!;
    const cur = effective[i]!;
    if (prev.count > 0) {
      const dropPct = round1((1 - cur.count / prev.count) * 100);
      if (dropPct > 0 && (!biggestDrop || dropPct > biggestDrop.dropPct)) {
        biggestDrop = { fromLabel: prev.label, toLabel: cur.label, dropPct };
      }
    }
  }

  const paidTotal = raw[4]!.count;
  const overallConversionPct = top > 0 ? round1((paidTotal / top) * 100) : null;

  // ── lead source / channel breakdown (lead.created source only) ──────────────
  // Counts ONLY lead.created, keyed by data.source, so the bars sum to leadTotal
  // (the adjacent "Leads in range" stat). form.submitted is a distinct event
  // type (not a lead source) and folding it in made the bars total more than the
  // lead count shown beside them.
  const sourceRows = (await db.execute(sql`
    with win as (
      select
        (${from}::date::timestamp at time zone 'Europe/London') as w_start,
        (((${to}::date) + 1)::timestamp at time zone 'Europe/London') as w_end
    )
    select
      coalesce(nullif(trim(e.data->>'source'), ''), 'Unattributed') as label,
      count(*)::int as value
    from events e, win
    where e.org_id = ${orgId}::uuid
      and e.project_id = ${projectId}::uuid
      and e.type = 'lead.created'
      and e.occurred_at >= win.w_start
      and e.occurred_at < win.w_end
    group by 1
    having count(*) > 0
    order by value desc, label asc
    limit 12
  `)) as unknown as SourceRow[];

  // ── leads-over-time trend (London day buckets, ascending, present days) ─────
  const seriesRows = (await db.execute(sql`
    with win as (
      select
        (${from}::date::timestamp at time zone 'Europe/London') as w_start,
        (((${to}::date) + 1)::timestamp at time zone 'Europe/London') as w_end
    )
    select
      to_char(
        (date_trunc('day', e.occurred_at at time zone 'Europe/London') at time zone 'Europe/London') at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS"Z"'
      ) as period_start,
      count(*)::int as value
    from events e, win
    where e.org_id = ${orgId}::uuid
      and e.project_id = ${projectId}::uuid
      and e.type = 'lead.created'
      and e.occurred_at >= win.w_start
      and e.occurred_at < win.w_end
    group by 1
    order by 1
  `)) as unknown as SeriesRow[];

  // ── P9-PACK2 · stage-to-stage time percentiles (real per-entity deltas) ────
  // Matches individual entities across adjacent stages via subject.id
  // (falling back to subject.name), unlike the structural avgLagHoursFromPrev
  // proxy above. Only entities present at BOTH stages in-window, delta >= 0,
  // contribute — a stage pair with no matched entities degrades to null/0.
  const percentileRows = (await db.execute(sql`
    with win as (
      select
        (${from}::date::timestamp at time zone 'Europe/London') as w_start,
        (((${to}::date) + 1)::timestamp at time zone 'Europe/London') as w_end
    ),
    subj_stage as (
      select
        coalesce(e.subject->>'id', e.subject->>'name') as sid,
        e.type,
        min(e.occurred_at) as at
      from events e, win
      where e.org_id = ${orgId}::uuid
        and e.project_id = ${projectId}::uuid
        and e.subject is not null
        and coalesce(e.subject->>'id', e.subject->>'name') is not null
        and e.occurred_at >= win.w_start
        and e.occurred_at < win.w_end
        and e.type in (
          'lead.created', 'lead.qualified', 'booking.created',
          'booking.completed', 'payment.captured', 'invoice.paid'
        )
      group by 1, 2
    ),
    pivot as (
      select
        sid,
        max(at) filter (where type = 'lead.created') as leads_at,
        max(at) filter (where type = 'lead.qualified') as qualified_at,
        max(at) filter (where type = 'booking.created') as booked_at,
        max(at) filter (where type = 'booking.completed') as completed_at,
        max(at) filter (where type in ('payment.captured', 'invoice.paid')) as paid_at
      from subj_stage
      group by sid
    ),
    deltas as (
      select
        case when leads_at is not null and qualified_at is not null and qualified_at >= leads_at
          then extract(epoch from (qualified_at - leads_at)) / 3600 end as d1,
        case when qualified_at is not null and booked_at is not null and booked_at >= qualified_at
          then extract(epoch from (booked_at - qualified_at)) / 3600 end as d2,
        case when booked_at is not null and completed_at is not null and completed_at >= booked_at
          then extract(epoch from (completed_at - booked_at)) / 3600 end as d3,
        case when completed_at is not null and paid_at is not null and paid_at >= completed_at
          then extract(epoch from (paid_at - completed_at)) / 3600 end as d4
      from pivot
    ),
    d1s as (select d1 from deltas where d1 is not null),
    d2s as (select d2 from deltas where d2 is not null),
    d3s as (select d3 from deltas where d3 is not null),
    d4s as (select d4 from deltas where d4 is not null)
    select
      (select count(*) from d1s)::int as n1,
      (select percentile_cont(0.5) within group (order by d1) from d1s) as p50_1,
      (select percentile_cont(0.9) within group (order by d1) from d1s) as p90_1,
      (select count(*) from d2s)::int as n2,
      (select percentile_cont(0.5) within group (order by d2) from d2s) as p50_2,
      (select percentile_cont(0.9) within group (order by d2) from d2s) as p90_2,
      (select count(*) from d3s)::int as n3,
      (select percentile_cont(0.5) within group (order by d3) from d3s) as p50_3,
      (select percentile_cont(0.9) within group (order by d3) from d3s) as p90_3,
      (select count(*) from d4s)::int as n4,
      (select percentile_cont(0.5) within group (order by d4) from d4s) as p50_4,
      (select percentile_cont(0.9) within group (order by d4) from d4s) as p90_4
  `)) as unknown as PercentileSqlRow[];
  const pr = percentileRows[0]!;

  const percentileLabels: { key: string; fromLabel: string; toLabel: string }[] = [
    { key: "leads_qualified", fromLabel: "Leads", toLabel: "Qualified" },
    { key: "qualified_booked", fromLabel: "Qualified", toLabel: "Booked" },
    { key: "booked_completed", fromLabel: "Booked", toLabel: "Attended" },
    { key: "completed_paid", fromLabel: "Attended", toLabel: "Paid" },
  ];
  const percentileValues: [number, number | null, number | null][] = [
    [num(pr.n1), numOrNull(pr.p50_1), numOrNull(pr.p90_1)],
    [num(pr.n2), numOrNull(pr.p50_2), numOrNull(pr.p90_2)],
    [num(pr.n3), numOrNull(pr.p50_3), numOrNull(pr.p90_3)],
    [num(pr.n4), numOrNull(pr.p50_4), numOrNull(pr.p90_4)],
  ];
  const stagePercentiles: FunnelStagePercentile[] = percentileLabels.map((lbl, i) => {
    const [sampleSize, p50, p90] = percentileValues[i]!;
    return {
      ...lbl,
      sampleSize,
      p50Hours: sampleSize > 0 ? round1(p50 ?? 0) : null,
      p90Hours: sampleSize > 0 ? round1(p90 ?? 0) : null,
    };
  });

  // ── P9-PACK2 · drop-off reasons hint: top intents of abandoned conversations ──
  const abandonedIntentRows = (await db.execute(sql`
    with win as (
      select
        (${from}::date::timestamp at time zone 'Europe/London') as w_start,
        (((${to}::date) + 1)::timestamp at time zone 'Europe/London') as w_end
    )
    select
      coalesce(nullif(e.data->>'intent', ''), 'unknown') as intent,
      (count(*))::int as value
    from events e, win
    where e.org_id = ${orgId}::uuid
      and e.project_id = ${projectId}::uuid
      and e.type = 'llm.conversation'
      and e.data->>'resolution' = 'abandoned'
      and e.occurred_at >= win.w_start
      and e.occurred_at < win.w_end
    group by 1
    order by value desc, intent asc
    limit 8
  `)) as unknown as IntentRow[];
  const abandonedIntents: LabelledValue[] = abandonedIntentRows.map((row) => ({
    label: String(row.intent).replace(/_/g, " "),
    value: num(row.value),
  }));

  const body: FunnelData = {
    range: r.range,
    from: r.fromDay,
    to: r.toDay,
    stages: raw.map((st) => ({ label: st.label, value: st.count })),
    stageDetail,
    leadTotal: top,
    paidTotal,
    overallConversionPct,
    biggestDrop,
    sources: sourceRows.map((row) => ({
      label: row.label,
      value: num(row.value),
    })),
    leadsSeries: seriesRows.map((row) => ({
      periodStart: row.period_start,
      value: num(row.value),
    })),
    stagePercentiles,
    abandonedIntents,
  };
  return NextResponse.json(body);
});
