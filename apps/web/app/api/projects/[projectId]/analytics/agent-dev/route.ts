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
  AgentDevResponse,
  LabelledValue,
  SeriesPoint,
} from "../../../../../../components/analytics/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ projectId: string }> };

/**
 * Agent & Dev — developer / operational analytics for the project's agents.
 *
 * READ-ONLY. Every query is org- + project-scoped and windowed to an inclusive
 * range of London calendar days (bounds resolved in Postgres with the shared
 * `… at time zone 'Europe/London'` pattern, DST-correct). Sources:
 *   - client-side agent telemetry on the event spine
 *     (agent.run.completed / agent.run.failed / agent.escalated_to_human /
 *      agent.feedback / agent.heartbeat, plus system.* and
 *      integration.disconnected for health), keyed by data->>'agent_id';
 *   - the agency's OWN OS agents in agent_runs, attributed to this project.
 * p95 latency comes from percentile_cont within SQL. Nothing throws on empty
 * data — aggregates return a single zero row and group-bys return [].
 */

// ── extended wire contract (superset of the foundation AgentDevResponse) ──────

interface AgentLeaderRow {
  agentId: string;
  name: string;
  /** completed + failed runs */
  runs: number;
  completed: number;
  failed: number;
  /** successful completed ÷ runs, 0..1; null when no runs */
  successRate: number | null;
  escalations: number;
  avgLatencyMs: number | null;
  p95LatencyMs: number | null;
  tokensIn: number;
  tokensOut: number;
  costPence: number;
  feedbackAvg: number | null;
  feedbackCount: number;
}

interface ComponentIssueRow {
  component: string;
  errors: number;
  warnings: number;
}

interface OsAgentRow {
  agent: string;
  runs: number;
  succeeded: number;
  failed: number;
  successRate: number | null;
  avgLatencyMs: number | null;
  p95LatencyMs: number | null;
  tokensIn: number;
  tokensOut: number;
  costPence: number;
}

interface HeartbeatSummary {
  total: number;
  agentsReporting: number;
  okCount: number;
  degradedCount: number;
  downCount: number;
  maxGapMinutes: number | null;
  lastSeen: string | null;
}

interface AgentDevPayload extends AgentDevResponse {
  totalCompleted: number;
  totalFailed: number;
  totalEscalations: number;
  /** failed ÷ runs, 0..1; null when no runs */
  errorRate: number | null;
  longestFailureStreak: number;
  avgLatencyMs: number | null;
  p95LatencyMs: number | null;
  tokensIn: number;
  tokensOut: number;
  costPence: number;
  feedbackAvg: number | null;
  feedbackCount: number;
  /** rich per-agent leaderboard (client-side agents) */
  agents: AgentLeaderRow[];
  /** runs/day (completed + failed), present London days only, ascending */
  throughput: SeriesPoint[];
  systemErrors: number;
  systemWarnings: number;
  issuesByComponent: ComponentIssueRow[];
  errorsBySeverity: LabelledValue[];
  integrationDisconnects: LabelledValue[];
  integrationDisconnectTotal: number;
  heartbeat: HeartbeatSummary;
  /** agency's own OS agents serving this project (agent_runs) */
  osAgents: OsAgentRow[];
  osTotalRuns: number;
  osCostPence: number;
}

// ── row shapes returned by db.execute ────────────────────────────────────────

interface AgentRow {
  agent_id: string;
  name: string;
  runs: number | string;
  completed: number | string;
  failed: number | string;
  escalations: number | string;
  successes: number | string;
  avg_latency: number | string | null;
  p95_latency: number | string | null;
  tokens_in: number | string;
  tokens_out: number | string;
  cost_pence: number | string;
  fb_avg: number | string | null;
  fb_count: number | string;
}

interface TotalsRow {
  completed: number | string;
  failed: number | string;
  escalations: number | string;
  successes: number | string;
  avg_latency: number | string | null;
  p95_latency: number | string | null;
  tokens_in: number | string;
  tokens_out: number | string;
  cost_pence: number | string;
  fb_avg: number | string | null;
  fb_count: number | string;
}

interface ThroughputRow {
  period_start: string;
  value: number | string;
}

interface StreakRow {
  longest: number | string;
}

interface ComponentRow {
  component: string;
  errors: number | string;
  warnings: number | string;
}

interface SeverityRow {
  severity: string;
  n: number | string;
}

interface IntegrationRow {
  provider: string;
  n: number | string;
}

interface HeartbeatRow {
  total: number | string;
  agents_reporting: number | string;
  ok_count: number | string;
  degraded_count: number | string;
  down_count: number | string;
  max_gap_min: number | string | null;
  last_seen: string | null;
}

interface OsRow {
  agent: string;
  runs: number | string;
  succeeded: number | string;
  failed: number | string;
  avg_latency: number | string | null;
  p95_latency: number | string | null;
  tokens_in: number | string;
  tokens_out: number | string;
  cost_pence: number | string;
}

// ── coercion helpers (Postgres numeric/bigint arrive as strings) ─────────────

const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const numOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const round = (n: number | null, p = 4): number | null =>
  n === null ? null : Math.round(n * 10 ** p) / 10 ** p;
const ratio = (numer: number, denom: number): number | null =>
  denom > 0 ? round(numer / denom) : null;

export const GET = withErrorHandling(async (req: Request, { params }: Ctx) => {
  const orgId = await requireOrgId();
  const { projectId } = await params;
  if (!isUuid(projectId)) return jsonError(404, "project_not_found");

  const r = parseRange(new URL(req.url).searchParams);
  const project = await getProjectForAnalytics(orgId, projectId);
  if (!project) return jsonError(404, "project_not_found");

  const org = sql`${orgId}::uuid`;
  const proj = sql`${projectId}::uuid`;
  // Inclusive London-day window → UTC instants; SQL owns the DST boundary.
  const win = sql`
    win as (
      select
        (${r.fromDay}::date::timestamp at time zone 'Europe/London') as w_start,
        ((${r.toDay}::date + 1)::timestamp at time zone 'Europe/London') as w_end
    )`;

  // ── per-agent leaderboard (client-side agents) ────────────────────────────
  const agentRows = (await db.execute(sql`
    with ${win},
    ev as (
      select e.type as etype, e.data as edata
      from events e, win
      where e.org_id = ${org}
        and e.project_id = ${proj}
        and e.occurred_at >= win.w_start
        and e.occurred_at < win.w_end
        and e.type in (
          'agent.run.completed','agent.run.failed',
          'agent.escalated_to_human','agent.feedback','agent.heartbeat'
        )
    ),
    base as (
      select
        coalesce(nullif(edata->>'agent_id',''), 'unknown') as agent_id,
        etype,
        case when etype in ('agent.run.completed','agent.run.failed')
             then (edata->>'duration_ms')::numeric end as duration_ms,
        case when etype = 'agent.run.completed'
             then coalesce((edata->>'tokens_in')::numeric, 0) else 0 end as tokens_in,
        case when etype = 'agent.run.completed'
             then coalesce((edata->>'tokens_out')::numeric, 0) else 0 end as tokens_out,
        case when etype = 'agent.run.completed'
             then coalesce((edata->>'cost_pence')::numeric, 0) else 0 end as cost_pence,
        case when etype = 'agent.run.completed'
             then case when coalesce(edata->>'success','true') = 'false' then 0 else 1 end
             end as success_flag,
        case when etype = 'agent.feedback' then (edata->>'rating')::numeric end as rating
      from ev
    ),
    names as (
      select coalesce(nullif(edata->>'agent_id',''),'unknown') as agent_id,
             max(edata->>'name') as name
      from ev where etype = 'agent.heartbeat' group by 1
    )
    select
      b.agent_id,
      coalesce(max(n.name), b.agent_id) as name,
      count(*) filter (where etype in ('agent.run.completed','agent.run.failed'))::int as runs,
      count(*) filter (where etype = 'agent.run.completed')::int as completed,
      count(*) filter (where etype = 'agent.run.failed')::int as failed,
      count(*) filter (where etype = 'agent.escalated_to_human')::int as escalations,
      coalesce(sum(success_flag), 0)::int as successes,
      avg(duration_ms) as avg_latency,
      percentile_cont(0.95) within group (order by duration_ms) as p95_latency,
      coalesce(sum(tokens_in), 0)::bigint as tokens_in,
      coalesce(sum(tokens_out), 0)::bigint as tokens_out,
      coalesce(sum(cost_pence), 0)::bigint as cost_pence,
      avg(rating) as fb_avg,
      count(*) filter (where etype = 'agent.feedback' and rating is not null)::int as fb_count
    from base b
    left join names n on n.agent_id = b.agent_id
    group by b.agent_id
    having count(*) filter (
      where etype in ('agent.run.completed','agent.run.failed',
                      'agent.escalated_to_human','agent.feedback')
    ) > 0
    order by runs desc, completed desc, b.agent_id
  `)) as unknown as AgentRow[];

  // ── overall totals + latency (authoritative; independent of leaderboard) ──
  const totalsRows = (await db.execute(sql`
    with ${win},
    ev as (
      select e.type as etype, e.data as edata
      from events e, win
      where e.org_id = ${org}
        and e.project_id = ${proj}
        and e.occurred_at >= win.w_start
        and e.occurred_at < win.w_end
        and e.type in (
          'agent.run.completed','agent.run.failed',
          'agent.escalated_to_human','agent.feedback'
        )
    )
    select
      count(*) filter (where etype = 'agent.run.completed')::int as completed,
      count(*) filter (where etype = 'agent.run.failed')::int as failed,
      count(*) filter (where etype = 'agent.escalated_to_human')::int as escalations,
      coalesce(sum(
        case when etype = 'agent.run.completed'
             and coalesce(edata->>'success','true') <> 'false' then 1 else 0 end
      ), 0)::int as successes,
      avg((edata->>'duration_ms')::numeric)
        filter (where etype in ('agent.run.completed','agent.run.failed')) as avg_latency,
      percentile_cont(0.95) within group (order by (edata->>'duration_ms')::numeric)
        filter (where etype in ('agent.run.completed','agent.run.failed')) as p95_latency,
      coalesce(sum((edata->>'tokens_in')::numeric)
        filter (where etype = 'agent.run.completed'), 0)::bigint as tokens_in,
      coalesce(sum((edata->>'tokens_out')::numeric)
        filter (where etype = 'agent.run.completed'), 0)::bigint as tokens_out,
      coalesce(sum((edata->>'cost_pence')::numeric)
        filter (where etype = 'agent.run.completed'), 0)::bigint as cost_pence,
      avg((edata->>'rating')::numeric) filter (where etype = 'agent.feedback') as fb_avg,
      count(*) filter (where etype = 'agent.feedback' and edata->>'rating' is not null)::int as fb_count
    from ev
  `)) as unknown as TotalsRow[];

  // ── throughput: runs/day (completed + failed), present days only ──────────
  const throughputRows = (await db.execute(sql`
    with ${win}
    select
      to_char(
        (date_trunc('day', e.occurred_at at time zone 'Europe/London')
          at time zone 'Europe/London') at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS"Z"'
      ) as period_start,
      count(*)::int as value
    from events e, win
    where e.org_id = ${org}
      and e.project_id = ${proj}
      and e.occurred_at >= win.w_start
      and e.occurred_at < win.w_end
      and e.type in ('agent.run.completed','agent.run.failed')
    group by 1
    order by 1
  `)) as unknown as ThroughputRow[];

  // ── longest consecutive-failure streak (gaps-and-islands) ─────────────────
  const streakRows = (await db.execute(sql`
    with ${win},
    seq as (
      select
        case when e.type = 'agent.run.failed'
              or (e.type = 'agent.run.completed'
                  and coalesce(e.data->>'success','true') = 'false')
             then 1 else 0 end as is_fail,
        row_number() over (order by e.occurred_at, e.id) as rn
      from events e, win
      where e.org_id = ${org}
        and e.project_id = ${proj}
        and e.occurred_at >= win.w_start
        and e.occurred_at < win.w_end
        and e.type in ('agent.run.completed','agent.run.failed')
    ),
    grp as (
      select is_fail,
             rn - row_number() over (partition by is_fail order by rn) as island
      from seq
    ),
    islands as (
      select count(*) as cnt from grp where is_fail = 1 group by island
    )
    select coalesce(max(cnt), 0)::int as longest from islands
  `)) as unknown as StreakRow[];

  // ── system.error / system.warning by component ────────────────────────────
  const componentRows = (await db.execute(sql`
    with ${win},
    ev as (
      select e.type as etype, e.data as edata
      from events e, win
      where e.org_id = ${org}
        and e.project_id = ${proj}
        and e.occurred_at >= win.w_start
        and e.occurred_at < win.w_end
        and e.type in ('system.error','system.warning')
    )
    select
      coalesce(nullif(edata->>'component',''),'unknown') as component,
      count(*) filter (where etype = 'system.error')::int as errors,
      count(*) filter (where etype = 'system.warning')::int as warnings
    from ev
    group by 1
    order by errors desc, warnings desc, component
  `)) as unknown as ComponentRow[];

  // ── system.error by severity ──────────────────────────────────────────────
  const severityRows = (await db.execute(sql`
    with ${win}
    select
      coalesce(nullif(e.data->>'severity',''),'unspecified') as severity,
      count(*)::int as n
    from events e, win
    where e.org_id = ${org}
      and e.project_id = ${proj}
      and e.occurred_at >= win.w_start
      and e.occurred_at < win.w_end
      and e.type = 'system.error'
    group by 1
    order by n desc, severity
  `)) as unknown as SeverityRow[];

  // ── integration.disconnected by provider ──────────────────────────────────
  const integrationRows = (await db.execute(sql`
    with ${win}
    select
      coalesce(nullif(e.data->>'provider',''),'unknown') as provider,
      count(*)::int as n
    from events e, win
    where e.org_id = ${org}
      and e.project_id = ${proj}
      and e.occurred_at >= win.w_start
      and e.occurred_at < win.w_end
      and e.type = 'integration.disconnected'
    group by 1
    order by n desc, provider
  `)) as unknown as IntegrationRow[];

  // ── heartbeat uptime / gaps ───────────────────────────────────────────────
  const heartbeatRows = (await db.execute(sql`
    with ${win},
    hb as (
      select
        coalesce(nullif(e.data->>'agent_id',''),'unknown') as agent_id,
        e.data->>'status' as status,
        e.occurred_at,
        lag(e.occurred_at) over (
          partition by coalesce(nullif(e.data->>'agent_id',''),'unknown')
          order by e.occurred_at
        ) as prev_at
      from events e, win
      where e.org_id = ${org}
        and e.project_id = ${proj}
        and e.occurred_at >= win.w_start
        and e.occurred_at < win.w_end
        and e.type = 'agent.heartbeat'
    )
    select
      count(*)::int as total,
      count(distinct agent_id)::int as agents_reporting,
      count(*) filter (where status = 'ok')::int as ok_count,
      count(*) filter (where status = 'degraded')::int as degraded_count,
      count(*) filter (where status = 'down')::int as down_count,
      max(extract(epoch from (occurred_at - prev_at)) / 60.0) as max_gap_min,
      to_char(max(occurred_at) at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS"Z"') as last_seen
    from hb
  `)) as unknown as HeartbeatRow[];

  // ── the agency's OWN OS agents serving this project (agent_runs) ──────────
  const osRows = (await db.execute(sql`
    with ${win}
    select
      ar.agent::text as agent,
      count(*)::int as runs,
      count(*) filter (where ar.status = 'succeeded')::int as succeeded,
      count(*) filter (where ar.status = 'failed')::int as failed,
      avg(extract(epoch from (ar.finished_at - ar.started_at)) * 1000)
        filter (where ar.finished_at is not null) as avg_latency,
      percentile_cont(0.95) within group (
        order by extract(epoch from (ar.finished_at - ar.started_at)) * 1000)
        filter (where ar.finished_at is not null) as p95_latency,
      coalesce(sum(ar.tokens_in), 0)::bigint as tokens_in,
      coalesce(sum(ar.tokens_out), 0)::bigint as tokens_out,
      coalesce(sum(ar.cost_estimate_pence), 0)::bigint as cost_pence
    from agent_runs ar, win
    where ar.org_id = ${org}
      and ar.project_id = ${proj}
      and ar.started_at >= win.w_start
      and ar.started_at < win.w_end
    group by ar.agent
    order by runs desc, ar.agent
  `)) as unknown as OsRow[];

  // ── assemble typed payload ────────────────────────────────────────────────
  const agents: AgentLeaderRow[] = agentRows.map((a) => {
    const runs = num(a.runs);
    return {
      agentId: a.agent_id,
      name: a.name,
      runs,
      completed: num(a.completed),
      failed: num(a.failed),
      successRate: ratio(num(a.successes), runs),
      escalations: num(a.escalations),
      avgLatencyMs: round(numOrNull(a.avg_latency), 0),
      p95LatencyMs: round(numOrNull(a.p95_latency), 0),
      tokensIn: num(a.tokens_in),
      tokensOut: num(a.tokens_out),
      costPence: num(a.cost_pence),
      feedbackAvg: round(numOrNull(a.fb_avg), 2),
      feedbackCount: num(a.fb_count),
    };
  });

  const t = totalsRows[0];
  const completed = num(t?.completed);
  const failed = num(t?.failed);
  const runs = completed + failed;
  const successes = num(t?.successes);

  const componentIssues: ComponentIssueRow[] = componentRows.map((c) => ({
    component: c.component,
    errors: num(c.errors),
    warnings: num(c.warnings),
  }));
  const systemErrors = componentIssues.reduce((s, c) => s + c.errors, 0);
  const systemWarnings = componentIssues.reduce((s, c) => s + c.warnings, 0);

  const integrationDisconnects: LabelledValue[] = integrationRows.map((i) => ({
    label: i.provider,
    value: num(i.n),
  }));

  const osAgents: OsAgentRow[] = osRows.map((o) => {
    const oRuns = num(o.runs);
    return {
      agent: o.agent,
      runs: oRuns,
      succeeded: num(o.succeeded),
      failed: num(o.failed),
      successRate: ratio(num(o.succeeded), oRuns),
      avgLatencyMs: round(numOrNull(o.avg_latency), 0),
      p95LatencyMs: round(numOrNull(o.p95_latency), 0),
      tokensIn: num(o.tokens_in),
      tokensOut: num(o.tokens_out),
      costPence: num(o.cost_pence),
    };
  });

  const hb = heartbeatRows[0];

  const body: AgentDevPayload = {
    range: r.range,
    from: r.fromDay,
    to: r.toDay,
    // foundation contract
    totalRuns: runs,
    successRate: ratio(successes, runs),
    leaderboard: agents.map((a) => ({ label: a.name, value: a.runs })),
    // extended
    totalCompleted: completed,
    totalFailed: failed,
    totalEscalations: num(t?.escalations),
    // Errors = runs that did NOT succeed: agent.run.failed events PLUS completed
    // runs flagged success=false. `failed` alone (agent.run.failed only) would
    // read 0% while successRate and longestFailureStreak both count success=false
    // completions as failures — so runs-successes keeps the three metrics
    // mutually consistent.
    errorRate: ratio(runs - successes, runs),
    longestFailureStreak: num(streakRows[0]?.longest),
    avgLatencyMs: round(numOrNull(t?.avg_latency), 0),
    p95LatencyMs: round(numOrNull(t?.p95_latency), 0),
    tokensIn: num(t?.tokens_in),
    tokensOut: num(t?.tokens_out),
    costPence: num(t?.cost_pence),
    feedbackAvg: round(numOrNull(t?.fb_avg), 2),
    feedbackCount: num(t?.fb_count),
    agents,
    throughput: throughputRows.map((p) => ({
      periodStart: p.period_start,
      value: num(p.value),
    })),
    systemErrors,
    systemWarnings,
    issuesByComponent: componentIssues,
    errorsBySeverity: severityRows.map((s) => ({
      label: s.severity,
      value: num(s.n),
    })),
    integrationDisconnects,
    integrationDisconnectTotal: integrationDisconnects.reduce(
      (s, i) => s + i.value,
      0,
    ),
    heartbeat: {
      total: num(hb?.total),
      agentsReporting: num(hb?.agents_reporting),
      okCount: num(hb?.ok_count),
      degradedCount: num(hb?.degraded_count),
      downCount: num(hb?.down_count),
      maxGapMinutes: round(numOrNull(hb?.max_gap_min), 1),
      lastSeen: hb?.last_seen ?? null,
    },
    osAgents,
    osTotalRuns: osAgents.reduce((s, o) => s + o.runs, 0),
    osCostPence: osAgents.reduce((s, o) => s + o.costPence, 0),
  };

  return NextResponse.json(body);
});
