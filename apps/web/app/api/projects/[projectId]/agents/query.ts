import { and, eq, sql } from "drizzle-orm";
import { db, projects } from "@azen/db";
import { DEFAULT_HOURLY_RATE_PENCE } from "@azen/config";
import { z } from "zod";

/**
 * P5-AGENTS-TAB — the Agents tab data source (docs/phase5/CONTRACTS.md).
 * Pure, org-scoped SQL over the event spine — NO LLM. The registry of agents is
 * defined by `agent.heartbeat` events (keyed by `data.agent_id`); run metrics
 * come from `agent.run.completed`, escalations from `agent.escalated_to_human`.
 * Every aggregate is bounded by an inclusive [from,to] window of London
 * calendar days, resolved to UTC instants inside Postgres with the shared
 * `… at time zone 'Europe/London'` pattern so boundaries are DST-correct.
 */

/** from/to are inclusive London calendar days (YYYY-MM-DD); both optional. */
export const agentsQuerySchema = z.object({
  from: z.preprocess(
    (v) => (v === "" || v === null ? undefined : v),
    z.iso.date().optional(),
  ),
  to: z.preprocess(
    (v) => (v === "" || v === null ? undefined : v),
    z.iso.date().optional(),
  ),
});
export type AgentsQuery = z.infer<typeof agentsQuerySchema>;

export interface AgentRoi {
  minutesSaved: number;
  timeValuePence: number;
  costPence: number;
  /** time value ÷ agent run cost; null when the agent has no measured cost. */
  roiMultiple: number | null;
  note: string;
}

export interface AgentSummary {
  agentId: string;
  name: string | null;
  version: string | null;
  /** latest heartbeat status: "ok" | "degraded" | "down" (default "ok"). */
  status: string;
  lastHeartbeatAt: string;
  runs: number;
  /** successes ÷ runs, 0..1; null when there are no completed runs. */
  successRate: number | null;
  avgDurationMs: number | null;
  tokensTotal: number;
  costPence: number;
  minutesSaved: number;
  escalations: number;
  perAgentRoi: AgentRoi;
}

export interface AgentsResponse {
  from: string;
  to: string;
  hourlyRatePence: number;
  agents: AgentSummary[];
}

interface AgentRow {
  agent_id: string;
  name: string | null;
  version: string | null;
  status: string;
  last_heartbeat_at: string;
  runs: number | string;
  successes: number | string;
  avg_duration_ms: number | string | null;
  tokens_total: number | string;
  cost_pence: number | string;
  minutes_saved: number | string;
  escalations: number | string;
  from_s: string;
  to_s: string;
}

const num = (v: unknown): number => Number(v ?? 0);
const round2 = (n: number): number => Math.round(n * 100) / 100;
const gbp = (pence: number): string => `£${(pence / 100).toFixed(2)}`;

function roiFor(
  minutesSaved: number,
  costPence: number,
  hourlyRatePence: number,
): AgentRoi {
  const timeValuePence = Math.round((minutesSaved / 60) * hourlyRatePence);
  const roiMultiple =
    costPence > 0 ? round2(timeValuePence / costPence) : null;
  // costPence is a coalesced sum of nonnegative run costs, so `roiMultiple` is
  // non-null in every branch reachable past the costPence === 0 guard above.
  let note: string;
  if (minutesSaved === 0 && costPence === 0) {
    note = "No measured time saved or run cost in this window.";
  } else if (costPence === 0) {
    note = `${gbp(timeValuePence)} of time saved at no measured run cost.`;
  } else {
    note = `${gbp(timeValuePence)} of time saved vs ${gbp(costPence)} run cost — ${roiMultiple}× return.`;
  }
  return { minutesSaved, timeValuePence, costPence, roiMultiple, note };
}

export async function getProjectAgents(
  orgId: string,
  projectId: string,
  query: AgentsQuery,
): Promise<AgentsResponse> {
  const [project] = await db
    .select({ hourlyRatePence: projects.hourlyRatePence })
    .from(projects)
    .where(and(eq(projects.orgId, orgId), eq(projects.id, projectId)))
    .limit(1);
  const hourlyRatePence = project?.hourlyRatePence ?? DEFAULT_HOURLY_RATE_PENCE;

  const from = query.from ?? null;
  const to = query.to ?? null;

  // One query: resolve the London-day window to UTC instants, then aggregate
  // heartbeats (registry + status), completed runs, and escalations per agent.
  const rows = (await db.execute(sql`
    with bounds as (
      select
        coalesce(${from}::date, (now() at time zone 'Europe/London')::date - interval '29 days')::date as from_d,
        coalesce(${to}::date, (now() at time zone 'Europe/London')::date)::date as to_d
    ),
    win as (
      select
        (from_d::timestamp at time zone 'Europe/London') as w_start,
        ((to_d + 1)::timestamp at time zone 'Europe/London') as w_end,
        to_char(from_d, 'YYYY-MM-DD') as from_s,
        to_char(to_d, 'YYYY-MM-DD') as to_s
      from bounds
    ),
    ev as (
      select e.type, e.data, e.occurred_at
      from events e, win
      where e.org_id = ${orgId}::uuid
        and e.project_id = ${projectId}::uuid
        and e.type in ('agent.heartbeat', 'agent.run.completed', 'agent.escalated_to_human')
        and e.occurred_at >= win.w_start
        and e.occurred_at < win.w_end
    ),
    hb as (
      select distinct on (data->>'agent_id')
        data->>'agent_id' as agent_id,
        data->>'name' as name,
        data->>'version' as version,
        coalesce(data->>'status', 'ok') as status,
        occurred_at as last_heartbeat
      from ev
      where type = 'agent.heartbeat'
        and coalesce(data->>'agent_id', '') <> ''
      order by data->>'agent_id', occurred_at desc
    ),
    runs as (
      select
        data->>'agent_id' as agent_id,
        count(*)::int as runs,
        count(*) filter (where data->>'success' = 'true')::int as successes,
        round(avg((data->>'duration_ms')::float8) filter (where (data->>'duration_ms') is not null))::int as avg_duration_ms,
        (coalesce(sum((data->>'tokens_in')::float8), 0) + coalesce(sum((data->>'tokens_out')::float8), 0))::float8 as tokens_total,
        coalesce(sum((data->>'cost_pence')::float8), 0)::float8 as cost_pence,
        coalesce(sum((data->>'minutes_saved')::float8), 0)::float8 as minutes_saved
      from ev
      where type = 'agent.run.completed'
        and coalesce(data->>'agent_id', '') <> ''
      group by data->>'agent_id'
    ),
    esc as (
      select data->>'agent_id' as agent_id, count(*)::int as escalations
      from ev
      where type = 'agent.escalated_to_human'
        and coalesce(data->>'agent_id', '') <> ''
      group by data->>'agent_id'
    )
    select
      hb.agent_id as agent_id,
      hb.name as name,
      hb.version as version,
      hb.status as status,
      to_char(hb.last_heartbeat at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as last_heartbeat_at,
      coalesce(runs.runs, 0) as runs,
      coalesce(runs.successes, 0) as successes,
      runs.avg_duration_ms as avg_duration_ms,
      coalesce(runs.tokens_total, 0) as tokens_total,
      coalesce(runs.cost_pence, 0) as cost_pence,
      coalesce(runs.minutes_saved, 0) as minutes_saved,
      coalesce(esc.escalations, 0) as escalations,
      (select from_s from win) as from_s,
      (select to_s from win) as to_s
    from hb
    left join runs on runs.agent_id = hb.agent_id
    left join esc on esc.agent_id = hb.agent_id
    order by coalesce(runs.runs, 0) desc, hb.name nulls last, hb.agent_id
  `)) as unknown as AgentRow[];

  // The window strings come back on every row; derive them once with a fallback
  // (an empty result still needs the resolved window echoed to the client).
  let fromS = from ?? "";
  let toS = to ?? "";
  if (rows[0]) {
    fromS = rows[0].from_s;
    toS = rows[0].to_s;
  } else {
    const [w] = (await db.execute(sql`
      select
        to_char(coalesce(${from}::date, (now() at time zone 'Europe/London')::date - interval '29 days'), 'YYYY-MM-DD') as from_s,
        to_char(coalesce(${to}::date, (now() at time zone 'Europe/London')::date), 'YYYY-MM-DD') as to_s
    `)) as unknown as { from_s: string; to_s: string }[];
    if (w) {
      fromS = w.from_s;
      toS = w.to_s;
    }
  }

  const agents: AgentSummary[] = rows.map((r) => {
    const runs = num(r.runs);
    const successes = num(r.successes);
    const costPence = Math.round(num(r.cost_pence));
    const minutesSaved = Math.round(num(r.minutes_saved));
    return {
      agentId: r.agent_id,
      name: r.name,
      version: r.version,
      status: r.status,
      lastHeartbeatAt: r.last_heartbeat_at,
      runs,
      successRate: runs > 0 ? round2(successes / runs) : null,
      avgDurationMs: r.avg_duration_ms === null ? null : Math.round(num(r.avg_duration_ms)),
      tokensTotal: Math.round(num(r.tokens_total)),
      costPence,
      minutesSaved,
      escalations: num(r.escalations),
      perAgentRoi: roiFor(minutesSaved, costPence, hourlyRatePence),
    };
  });

  return { from: fromS, to: toS, hourlyRatePence, agents };
}
