import type { Db } from "@azen/db";
import type {
  DailyPack,
  DailyPackInsight,
  DailyPackKpi,
  DailyPackProject,
} from "./types";

/**
 * buildAgencyDailyPack — the deterministic Agency Daily data pack
 * (docs/phase3/CONTRACTS.md §P3-RUNNER, spec §9). Pure SQL over metric_rollups,
 * open insights, subscriptions, bookings and events; NO raw-event dumps into
 * the prompt. Reused by the Daily Brief agent (Wave 2) and independently
 * testable against hand-built rollups.
 *
 * `forDayLondon` is the UTC instant of the London-day START for the day being
 * summarized ("yesterday" = the latest COMPLETE London day; today is skipped by
 * the caller). All day/window boundaries are derived from it inside Postgres
 * using the shared rollup bucket pattern (`… at time zone 'Europe/London'`) so
 * every boundary is DST-correct. drizzle-orm is not a dependency of this
 * package, so queries run through the postgres-js client (`db.$client`) — the
 * same connection the rest of the OS uses.
 */

const round2 = (n: number): number => Math.round(n * 100) / 100;

const num = (v: unknown): number => Number(v ?? 0);
const numOrNull = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v);

/** £ from integer pence, deterministic (no locale separators). */
const gbp = (pence: number): string => `£${(pence / 100).toFixed(2)}`;

interface AgencyRow {
  mrr_pence: number;
  live_projects: number;
  active_clients: number;
  green: number;
  amber: number;
  red: number;
  client_bookings_yday: number;
  for_day: string;
  generated_at: string;
}

interface ProjectRow {
  id: string;
  name: string;
  client_name: string;
  health: string;
  revenue_yday: number;
  minutes_yday: number;
  error_count_yday: number;
  last_event_at: string | null;
  hours_since: number | null;
}

interface KpiRow {
  key: string;
  name: string;
  unit: string;
  good_direction: string;
  value: number | null;
  avg7: number | null;
  avg28: number | null;
}

interface AnomalyRow {
  project_id: string;
  metric_key: string;
  title: string;
}

interface InsightRow {
  project_name: string;
  kind: string;
  title: string;
  confidence: string;
}

interface BaselineRow {
  rev_y: number;
  rev_7: number;
}

export async function buildAgencyDailyPack(
  db: Db,
  orgId: string,
  forDayLondon: Date,
): Promise<DailyPack> {
  const client = db.$client;
  // Date param as ISO string + explicit ::timestamptz (postgres-js convention).
  const d = forDayLondon.toISOString();

  // ── agency summary (one row of scalar subqueries) ──────────────────────────
  const agencyRows = (await client`
    select
      (select coalesce(sum(amount_pence_monthly), 0)::float8
         from subscriptions where org_id = ${orgId}::uuid and status = 'active') as mrr_pence,
      (select count(*)::int from projects
         where org_id = ${orgId}::uuid and status = 'live') as live_projects,
      (select count(*)::int from clients
         where org_id = ${orgId}::uuid and status = 'active') as active_clients,
      (select count(*)::int from projects
         where org_id = ${orgId}::uuid and status not in ('completed', 'cancelled') and health = 'green') as green,
      (select count(*)::int from projects
         where org_id = ${orgId}::uuid and status not in ('completed', 'cancelled') and health = 'amber') as amber,
      (select count(*)::int from projects
         where org_id = ${orgId}::uuid and status not in ('completed', 'cancelled') and health = 'red') as red,
      (select count(*)::int from bookings
         where org_id = ${orgId}::uuid and kind = 'client_end_customer'
           and starts_at >= ${d}::timestamptz
           and starts_at < (${d}::timestamptz at time zone 'Europe/London' + interval '1 day') at time zone 'Europe/London') as client_bookings_yday,
      to_char(${d}::timestamptz at time zone 'Europe/London', 'YYYY-MM-DD') as for_day,
      to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as generated_at
  `) as unknown as AgencyRow[];
  const a = agencyRows[0]!;

  // ── projects list + per-project daily aggregates + silence flag ────────────
  const projectRows = (await client`
    select
      p.id::text as id,
      p.name as name,
      coalesce(cl.name, '') as client_name,
      p.health::text as health,
      coalesce((select sum(e.value_pence) from events e
         where e.project_id = p.id
           and e.occurred_at >= ${d}::timestamptz
           and e.occurred_at < (${d}::timestamptz at time zone 'Europe/London' + interval '1 day') at time zone 'Europe/London'), 0)::float8 as revenue_yday,
      coalesce((select sum(e.minutes_saved) from events e
         where e.project_id = p.id
           and e.occurred_at >= ${d}::timestamptz
           and e.occurred_at < (${d}::timestamptz at time zone 'Europe/London' + interval '1 day') at time zone 'Europe/London'), 0)::float8 as minutes_yday,
      (select count(*)::int from events e
         where e.project_id = p.id and e.type = 'system.error'
           and e.occurred_at >= ${d}::timestamptz
           and e.occurred_at < (${d}::timestamptz at time zone 'Europe/London' + interval '1 day') at time zone 'Europe/London') as error_count_yday,
      case when le.m is null then null
           else to_char(le.m at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') end as last_event_at,
      case when le.m is null then null
           else extract(epoch from (now() - le.m)) / 3600 end as hours_since
    from projects p
    left join clients cl on cl.id = p.client_id
    left join lateral (select max(e2.occurred_at) as m from events e2 where e2.project_id = p.id) le on true
    where p.org_id = ${orgId}::uuid and p.status not in ('completed', 'cancelled')
    order by p.name
  `) as unknown as ProjectRow[];

  // ── open anomalies (all projects at once), grouped in JS ───────────────────
  const anomalyRows = (await client`
    select project_id::text as project_id, coalesce(evidence->>'metric_key', '') as metric_key, title
    from insights
    where org_id = ${orgId}::uuid and kind = 'anomaly' and status = 'new'
    order by created_at desc
  `) as unknown as AnomalyRow[];
  const anomaliesByProject = new Map<string, { metricKey: string; title: string }[]>();
  for (const r of anomalyRows) {
    const list = anomaliesByProject.get(r.project_id) ?? [];
    list.push({ metricKey: r.metric_key, title: r.title });
    anomaliesByProject.set(r.project_id, list);
  }

  // ── per-project KPI stats (effective global∪override defs, isKpi only) ──────
  const projects: DailyPackProject[] = [];
  for (const p of projectRows) {
    const kpiRows = (await client`
      with eff as (
        select distinct on (key)
          key, name, unit, good_direction::text as good_direction, is_kpi, sort
        from metric_definitions
        where org_id = ${orgId}::uuid and (project_id = ${p.id}::uuid or project_id is null)
        order by key, (project_id is not null) desc
      )
      select
        e.key as key, e.name as name, e.unit::text as unit, e.good_direction as good_direction,
        (select r.value from metric_rollups r
           where r.project_id = ${p.id}::uuid and r.metric_key = e.key
             and r.period = 'day' and r.period_start = ${d}::timestamptz)::float8 as value,
        (select avg(r.value) from metric_rollups r
           where r.project_id = ${p.id}::uuid and r.metric_key = e.key and r.period = 'day'
             and r.period_start >= (${d}::timestamptz at time zone 'Europe/London' - interval '7 days') at time zone 'Europe/London'
             and r.period_start < ${d}::timestamptz)::float8 as avg7,
        (select avg(r.value) from metric_rollups r
           where r.project_id = ${p.id}::uuid and r.metric_key = e.key and r.period = 'day'
             and r.period_start >= (${d}::timestamptz at time zone 'Europe/London' - interval '28 days') at time zone 'Europe/London'
             and r.period_start < ${d}::timestamptz)::float8 as avg28
      from eff e
      where e.is_kpi = true
      order by e.sort, e.key
    `) as unknown as KpiRow[];

    const kpis: DailyPackKpi[] = kpiRows.map((k) => {
      const value = numOrNull(k.value);
      const avg7 = numOrNull(k.avg7);
      const avg28 = numOrNull(k.avg28);
      const deltaPct =
        value !== null && avg7 !== null && avg7 !== 0
          ? round2(((value - avg7) / avg7) * 100)
          : null;
      return {
        key: k.key,
        name: k.name,
        unit: k.unit,
        value: value === null ? null : round2(value),
        avg7: avg7 === null ? null : round2(avg7),
        avg28: avg28 === null ? null : round2(avg28),
        deltaPct,
        goodDirection: k.good_direction,
      };
    });

    projects.push({
      id: p.id,
      name: p.name,
      clientName: p.client_name,
      health: p.health,
      kpis,
      revenueYesterdayPence: Math.round(num(p.revenue_yday)),
      minutesSavedYesterday: Math.round(num(p.minutes_yday)),
      lastEventAt: p.last_event_at,
      hoursSinceLastEvent:
        p.hours_since === null ? null : round2(num(p.hours_since)),
      openAnomalies: anomaliesByProject.get(p.id) ?? [],
      errorCountYesterday: num(p.error_count_yday),
    });
  }

  // ── open insights (all new, any kind), newest first ────────────────────────
  const insightRows = (await client`
    select coalesce(p.name, '') as project_name, i.kind::text as kind, i.title as title, i.confidence::text as confidence
    from insights i
    left join projects p on p.id = i.project_id
    where i.org_id = ${orgId}::uuid and i.status = 'new'
    order by i.created_at desc
  `) as unknown as InsightRow[];
  const openInsights: DailyPackInsight[] = insightRows.map((i) => ({
    projectName: i.project_name,
    kind: i.kind,
    title: i.title,
    confidence: i.confidence,
  }));

  // ── headline delta: agency revenue yesterday vs prior-7-day daily average ──
  const baselineRows = (await client`
    select
      coalesce((select sum(value_pence) from events
         where org_id = ${orgId}::uuid
           and occurred_at >= ${d}::timestamptz
           and occurred_at < (${d}::timestamptz at time zone 'Europe/London' + interval '1 day') at time zone 'Europe/London'), 0)::float8 as rev_y,
      coalesce((select sum(value_pence) from events
         where org_id = ${orgId}::uuid
           and occurred_at >= (${d}::timestamptz at time zone 'Europe/London' - interval '7 days') at time zone 'Europe/London'
           and occurred_at < ${d}::timestamptz), 0)::float8 as rev_7
  `) as unknown as BaselineRow[];
  const b = baselineRows[0]!;
  const revY = Math.round(num(b.rev_y));
  const avgDaily = num(b.rev_7) / 7;
  let note: string;
  if (revY === 0 && avgDaily === 0) {
    note = "No revenue recorded yesterday or in the prior 7 days.";
  } else if (avgDaily === 0) {
    note = `${gbp(revY)} in revenue yesterday, with no revenue in the prior 7 days.`;
  } else {
    const deltaPct = round2(((revY - avgDaily) / avgDaily) * 100);
    const dir = deltaPct >= 0 ? "up" : "down";
    note = `${gbp(revY)} in revenue yesterday, ${dir} ${Math.abs(deltaPct)}% vs the ${gbp(avgDaily)} prior-7-day daily average.`;
  }

  return {
    forDay: a.for_day,
    generatedAt: a.generated_at,
    agency: {
      mrrPence: Math.round(num(a.mrr_pence)),
      liveProjects: num(a.live_projects),
      activeClients: num(a.active_clients),
      healthSummary: {
        green: num(a.green),
        amber: num(a.amber),
        red: num(a.red),
      },
      clientBookingsYesterday: num(a.client_bookings_yday),
    },
    projects,
    openInsights,
    yesterdayVsBaseline: { note },
  };
}
