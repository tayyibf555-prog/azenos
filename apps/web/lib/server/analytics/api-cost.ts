import { sql } from "drizzle-orm";
import { db } from "@azen/db";
import type { ParsedRange } from "./base";

/**
 * API Cost & Usage — the unified per-project cost view (analytics rail #10,
 * docs/phase9/CONTRACTS.md — P9-COST). READ-ONLY over `agent_runs` + `events`,
 * always scoped to (org_id, project_id) and the inclusive London-day window.
 *
 * It merges TWO cost streams, kept clearly labelled and never conflated:
 *   (a) OS costs      — our own agent_runs for this project (cost_estimate_pence,
 *                       tokens_in/out), grouped by os_agent kind. This is what
 *                       the OS spent on the client's behalf.
 *   (b) client-emitted — events(type='agent.run.completed') carrying the
 *                       client's OWN system spend in data.cost_pence /
 *                       data.tokens_in / data.tokens_out, grouped by
 *                       data.provider ('anthropic'|'openai'|'twilio'|
 *                       'higgsfield'|…, else 'other').
 *
 * Efficiency ratios divide TOTAL (os + emitted) spend by an outcome count:
 * cost-per-conversation, cost-per-resolution, and £-per-outcome (payment /
 * booking events — labelled "attributed", honestly). Every figure degrades to
 * 0 / [] / null on an empty project; ratios are null when the denominator is 0.
 */

export interface CostStreamPoint {
  periodStart: string;
  osPence: number;
  emittedPence: number;
}

export interface ProviderCost {
  provider: string;
  label: string;
  pence: number;
  runs: number;
  tokensIn: number;
  tokensOut: number;
}

export interface AgentCost {
  agent: string;
  label: string;
  pence: number;
  runs: number;
  tokensIn: number;
  tokensOut: number;
}

export interface TopCostRun {
  id: string;
  stream: "os" | "client";
  label: string;
  provider: string | null;
  occurredAt: string;
  pence: number;
}

export interface ApiCostData {
  range: ParsedRange["range"];
  from: string;
  to: string;
  /** os + emitted, the combined spend headline. */
  totalPence: number;
  osPence: number;
  emittedPence: number;
  osRuns: number;
  emittedRuns: number;
  osTokensIn: number;
  osTokensOut: number;
  emittedTokensIn: number;
  emittedTokensOut: number;
  /** per-London-day, each point split into the two streams (zero-filled). */
  series: CostStreamPoint[];
  /** client-emitted spend by provider (descending). */
  byProvider: ProviderCost[];
  /** OS spend by agent kind (descending). */
  byAgent: AgentCost[];
  conversations: number;
  costPerConversationPence: number | null;
  resolutions: number;
  costPerResolutionPence: number | null;
  /** payment/booking outcome events (the "attributed" denominator). */
  outcomes: number;
  costPerOutcomePence: number | null;
  topRuns: TopCostRun[];
}

const num = (v: unknown): number =>
  typeof v === "number" ? v : Number(v ?? 0) || 0;

/** Provider display labels; unknown providers title-case their own key. */
const PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  twilio: "Twilio",
  higgsfield: "Higgsfield",
  other: "Other",
};
function providerLabel(p: string): string {
  return PROVIDER_LABELS[p] ?? p.charAt(0).toUpperCase() + p.slice(1);
}

/** Humanise an os_agent kind ("daily_brief" → "Daily brief"). */
function agentLabel(a: string): string {
  const words = a.replace(/[._]/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

interface OsAggRow {
  pence: number | string;
  runs: number | string;
  tokens_in: number | string;
  tokens_out: number | string;
}
interface EmittedAggRow {
  pence: number | string;
  runs: number | string;
  tokens_in: number | string;
  tokens_out: number | string;
}
interface ByAgentRow {
  agent: string;
  pence: number | string;
  runs: number | string;
  tokens_in: number | string;
  tokens_out: number | string;
}
interface ByProviderRow {
  provider: string;
  pence: number | string;
  runs: number | string;
  tokens_in: number | string;
  tokens_out: number | string;
}
interface SeriesRow {
  period_start: string;
  os_pence: number | string;
  emitted_pence: number | string;
}
interface DenomRow {
  conversations: number | string;
  resolutions: number | string;
  outcomes: number | string;
}
interface TopRunRow {
  id: string;
  stream: string;
  provider: string | null;
  occurred_at: string;
  pence: number | string;
  raw_label: string | null;
}

/**
 * Compute the API-cost payload. `project` existence + org-scoping are the
 * caller's job (the route already resolved the project). Deterministic in
 * (orgId, projectId, range).
 */
export async function getApiCostData(
  orgId: string,
  projectId: string,
  r: ParsedRange,
): Promise<ApiCostData> {
  // Inclusive [fromDay … toDay] London calendar days → UTC instants in SQL.
  const win = sql`
    win as (
      select
        (${r.fromDay}::date::timestamp at time zone 'Europe/London') as w_start,
        ((${r.toDay}::date + 1)::timestamp at time zone 'Europe/London') as w_end
    )`;

  // Client-emitted rows: agent.run.completed with a numeric cost_pence.
  const emittedFilter = sql`e.type = 'agent.run.completed' and (e.data ? 'cost_pence')`;
  const providerExpr = sql`coalesce(nullif(lower(e.data->>'provider'), ''), 'other')`;

  // ── OS stream headline (agent_runs) ─────────────────────────────────────────
  const osAgg = (await db.execute(sql`
    with ${win}
    select
      coalesce(sum(r.cost_estimate_pence), 0)::bigint as pence,
      count(*)::int as runs,
      coalesce(sum(r.tokens_in), 0)::bigint as tokens_in,
      coalesce(sum(r.tokens_out), 0)::bigint as tokens_out
    from agent_runs r, win
    where r.org_id = ${orgId}::uuid and r.project_id = ${projectId}::uuid
      and r.started_at >= win.w_start and r.started_at < win.w_end
  `)) as unknown as OsAggRow[];

  // ── client-emitted headline (events) ────────────────────────────────────────
  // cost_pence is schema-valid as a fractional number, so round EACH row to
  // integer pence before summing (round() matches ::bigint's half-away-from-zero).
  // Every stream aggregate below rounds the same per-row base, so the headline,
  // byProvider, and daily series reconcile exactly (integer sums are associative).
  const emittedAgg = (await db.execute(sql`
    with ${win}
    select
      coalesce(sum(round((e.data->>'cost_pence')::numeric)), 0)::bigint as pence,
      count(*)::int as runs,
      coalesce(sum((e.data->>'tokens_in')::numeric), 0)::bigint as tokens_in,
      coalesce(sum((e.data->>'tokens_out')::numeric), 0)::bigint as tokens_out
    from events e, win
    where e.org_id = ${orgId}::uuid and e.project_id = ${projectId}::uuid
      and ${emittedFilter}
      and e.occurred_at >= win.w_start and e.occurred_at < win.w_end
  `)) as unknown as EmittedAggRow[];

  // ── OS by agent ─────────────────────────────────────────────────────────────
  const byAgentRows = (await db.execute(sql`
    with ${win}
    select
      r.agent as agent,
      coalesce(sum(r.cost_estimate_pence), 0)::bigint as pence,
      count(*)::int as runs,
      coalesce(sum(r.tokens_in), 0)::bigint as tokens_in,
      coalesce(sum(r.tokens_out), 0)::bigint as tokens_out
    from agent_runs r, win
    where r.org_id = ${orgId}::uuid and r.project_id = ${projectId}::uuid
      and r.started_at >= win.w_start and r.started_at < win.w_end
    group by r.agent
    order by pence desc
  `)) as unknown as ByAgentRow[];

  // ── emitted by provider ─────────────────────────────────────────────────────
  const byProviderRows = (await db.execute(sql`
    with ${win}
    select
      ${providerExpr} as provider,
      coalesce(sum(round((e.data->>'cost_pence')::numeric)), 0)::bigint as pence,
      count(*)::int as runs,
      coalesce(sum((e.data->>'tokens_in')::numeric), 0)::bigint as tokens_in,
      coalesce(sum((e.data->>'tokens_out')::numeric), 0)::bigint as tokens_out
    from events e, win
    where e.org_id = ${orgId}::uuid and e.project_id = ${projectId}::uuid
      and ${emittedFilter}
      and e.occurred_at >= win.w_start and e.occurred_at < win.w_end
    group by ${providerExpr}
    order by pence desc
  `)) as unknown as ByProviderRow[];

  // ── daily series, both streams, zero-filled across the window ───────────────
  const seriesRows = (await db.execute(sql`
    with ${win},
    days as (
      select generate_series(${r.fromDay}::date, ${r.toDay}::date, interval '1 day')::date as d
    ),
    os as (
      select (r.started_at at time zone 'Europe/London')::date as d,
             coalesce(sum(r.cost_estimate_pence), 0)::bigint as pence
      from agent_runs r, win
      where r.org_id = ${orgId}::uuid and r.project_id = ${projectId}::uuid
        and r.started_at >= win.w_start and r.started_at < win.w_end
      group by 1
    ),
    emitted as (
      select (e.occurred_at at time zone 'Europe/London')::date as d,
             coalesce(sum(round((e.data->>'cost_pence')::numeric)), 0)::bigint as pence
      from events e, win
      where e.org_id = ${orgId}::uuid and e.project_id = ${projectId}::uuid
        and ${emittedFilter}
        and e.occurred_at >= win.w_start and e.occurred_at < win.w_end
      group by 1
    )
    select
      to_char((days.d::timestamp at time zone 'Europe/London') at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS"Z"') as period_start,
      coalesce(os.pence, 0)::bigint as os_pence,
      coalesce(emitted.pence, 0)::bigint as emitted_pence
    from days
    left join os on os.d = days.d
    left join emitted on emitted.d = days.d
    order by days.d
  `)) as unknown as SeriesRow[];

  // ── efficiency denominators (events) ────────────────────────────────────────
  // conversations + resolutions use the same convention as the Conversations &
  // AI section (data->>'resolution' = 'resolved'). Outcomes are the value-
  // bearing payment/booking events ("attributed" — labelled honestly).
  const denomRows = (await db.execute(sql`
    with ${win}
    select
      count(*) filter (where e.type = 'llm.conversation')::int as conversations,
      count(*) filter (
        where e.type = 'llm.conversation' and e.data->>'resolution' = 'resolved'
      )::int as resolutions,
      count(distinct case
        -- LEAD RULING 2026-07-16 (P9-COST punch #1): count each TERMINAL outcome
        -- once. booking.created is the outcome; booking.completed is a later
        -- lifecycle stage of the SAME booking, so it is excluded from the set
        -- (a subject-id dedup alone would still double-count a completed that
        -- arrived without its created, or under a differing subject id).
        when e.type in (
          'payment.captured','invoice.paid','order.created','subscription.started',
          'booking.created'
        )
        -- one outcome per real entity: a sale emitting order→payment shares a
        -- subject id and counts once. No subject id → fall back to the event id
        -- so each event still counts.
        then coalesce(e.subject->>'kind', '') || ':'
          || coalesce(nullif(e.subject->>'id', ''), e.id::text)
      end)::int as outcomes
    from events e, win
    where e.org_id = ${orgId}::uuid and e.project_id = ${projectId}::uuid
      and e.occurred_at >= win.w_start and e.occurred_at < win.w_end
  `)) as unknown as DenomRow[];

  // ── top costly runs (both streams, unioned, ranked) ─────────────────────────
  const topRunRows = (await db.execute(sql`
    with ${win},
    os as (
      select r.id::text as id, 'os' as stream, null::text as provider,
             r.started_at as occurred_at,
             coalesce(r.cost_estimate_pence, 0)::bigint as pence,
             r.agent::text as raw_label
      from agent_runs r, win
      where r.org_id = ${orgId}::uuid and r.project_id = ${projectId}::uuid
        and r.started_at >= win.w_start and r.started_at < win.w_end
        and coalesce(r.cost_estimate_pence, 0) > 0
    ),
    emitted as (
      select e.id::text as id, 'client' as stream, ${providerExpr} as provider,
             e.occurred_at as occurred_at,
             coalesce((e.data->>'cost_pence')::numeric, 0)::bigint as pence,
             coalesce(nullif(e.data->>'model', ''), nullif(e.data->>'agent', '')) as raw_label
      from events e, win
      where e.org_id = ${orgId}::uuid and e.project_id = ${projectId}::uuid
        and ${emittedFilter}
        and e.occurred_at >= win.w_start and e.occurred_at < win.w_end
        and coalesce((e.data->>'cost_pence')::numeric, 0) > 0
    ),
    u as (select * from os union all select * from emitted)
    select id, stream, provider,
      to_char(occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as occurred_at,
      pence, raw_label
    from u
    order by pence desc, occurred_at desc
    limit 8
  `)) as unknown as TopRunRow[];

  // ── derive ──────────────────────────────────────────────────────────────────
  const osPence = num(osAgg[0]?.pence);
  const emittedPence = num(emittedAgg[0]?.pence);
  const totalPence = osPence + emittedPence;
  const conversations = num(denomRows[0]?.conversations);
  const resolutions = num(denomRows[0]?.resolutions);
  const outcomes = num(denomRows[0]?.outcomes);

  const ratio = (denom: number): number | null =>
    denom > 0 ? Math.round(totalPence / denom) : null;

  return {
    range: r.range,
    from: r.fromDay,
    to: r.toDay,
    totalPence,
    osPence,
    emittedPence,
    osRuns: num(osAgg[0]?.runs),
    emittedRuns: num(emittedAgg[0]?.runs),
    osTokensIn: num(osAgg[0]?.tokens_in),
    osTokensOut: num(osAgg[0]?.tokens_out),
    emittedTokensIn: num(emittedAgg[0]?.tokens_in),
    emittedTokensOut: num(emittedAgg[0]?.tokens_out),
    series: seriesRows.map((s) => ({
      periodStart: s.period_start,
      osPence: num(s.os_pence),
      emittedPence: num(s.emitted_pence),
    })),
    byProvider: byProviderRows.map((row) => ({
      provider: row.provider,
      label: providerLabel(row.provider),
      pence: num(row.pence),
      runs: num(row.runs),
      tokensIn: num(row.tokens_in),
      tokensOut: num(row.tokens_out),
    })),
    byAgent: byAgentRows.map((row) => ({
      agent: row.agent,
      label: agentLabel(row.agent),
      pence: num(row.pence),
      runs: num(row.runs),
      tokensIn: num(row.tokens_in),
      tokensOut: num(row.tokens_out),
    })),
    conversations,
    costPerConversationPence: ratio(conversations),
    resolutions,
    costPerResolutionPence: ratio(resolutions),
    outcomes,
    costPerOutcomePence: ratio(outcomes),
    topRuns: topRunRows.map((row) => ({
      id: row.id,
      stream: row.stream === "client" ? "client" : "os",
      label:
        row.raw_label && row.raw_label.length > 0
          ? row.stream === "os"
            ? agentLabel(row.raw_label)
            : row.raw_label
          : row.stream === "os"
            ? "OS run"
            : providerLabel(row.provider ?? "other"),
      provider: row.provider,
      occurredAt: row.occurred_at,
      pence: num(row.pence),
    })),
  };
}
