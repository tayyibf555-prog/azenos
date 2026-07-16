import { sql } from "drizzle-orm";
import { db } from "@azen/db";
import { DEFAULT_HOURLY_RATE_PENCE } from "@azen/config";

/**
 * Portfolio screen (P9-PACK3 — docs/phase9/CONTRACTS.md, new app/portfolio/
 * page.tsx). READ-ONLY composition over projects/clients/agent_runs/events,
 * scoped to the current London calendar month-to-date. Mirrors the money/
 * api-cost analytics routes' conventions (pence integers, London-day math in
 * SQL, graceful empty degrade) but rolled up ACROSS every live project rather
 * than scoped to one.
 *
 * Cost   = OS agent-run cost (agent_runs.cost_estimate_pence) + client-emitted
 *          cost (events type agent.run.completed, data.cost_pence) — the same
 *          two-stream merge as the API Cost section, MTD.
 * Value  = net attributed revenue (Σ value_pence on revenue events − refunds)
 *          + time-saved value (minutes_saved ÷ 60 × hourly rate) — the same
 *          "value returned" convention as the Money section, MTD.
 */

const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const round2 = (n: number): number => Math.round(n * 100) / 100;

export interface PortfolioProjectRow {
  projectId: string;
  projectName: string;
  clientId: string;
  clientName: string;
  status: string;
  /** objective health badge (projects.health) — drives the quadrant dot colour. */
  health: "green" | "amber" | "red";
  osCostPence: number;
  emittedCostPence: number;
  /** os + emitted, MTD. */
  costPence: number;
  netRevenuePence: number;
  timeValuePence: number;
  /** net revenue + time value, MTD — the quadrant's y-axis. */
  valuePence: number;
  eventsMtd: number;
  /** value ÷ cost; null when cost is 0 (undefined ratio). */
  roiMultiple: number | null;
}

/** Pure: derive a project's cost/value/ROI from its raw MTD aggregates. */
export function deriveProjectFinancials(input: {
  osCostPence: number;
  emittedCostPence: number;
  grossRevenuePence: number;
  refundsPence: number;
  minutesSaved: number;
  hourlyRatePence: number;
  eventsMtd: number;
}): Pick<
  PortfolioProjectRow,
  "costPence" | "netRevenuePence" | "timeValuePence" | "valuePence" | "roiMultiple"
> {
  const costPence = input.osCostPence + input.emittedCostPence;
  const netRevenuePence = input.grossRevenuePence - input.refundsPence;
  const timeValuePence = Math.round((input.minutesSaved / 60) * input.hourlyRatePence);
  const valuePence = netRevenuePence + timeValuePence;
  const roiMultiple = costPence > 0 ? round2(valuePence / costPence) : null;
  return { costPence, netRevenuePence, timeValuePence, valuePence, roiMultiple };
}

/** Pure: rank rows by ROI descending — projects with no cost (null ROI) sort last. */
export function rankByRoi(rows: readonly PortfolioProjectRow[]): PortfolioProjectRow[] {
  return [...rows].sort((a, b) => {
    if (a.roiMultiple === null && b.roiMultiple === null) return b.valuePence - a.valuePence;
    if (a.roiMultiple === null) return 1;
    if (b.roiMultiple === null) return -1;
    return b.roiMultiple - a.roiMultiple;
  });
}

export interface PortfolioConcentration {
  topClientId: string | null;
  topClientName: string | null;
  topClientValuePence: number;
  totalValuePence: number;
  /** topClientValuePence ÷ totalValuePence × 100, rounded to 1dp; 0 when total is 0. */
  pct: number;
}

/**
 * Pure: which client this month's org-wide attributed VALUE (not cost) is
 * most concentrated on — the portfolio's "don't lose this one client" hero.
 * Groups rows by clientId itself rather than trusting a pre-grouped input.
 */
export function computeConcentration(
  rows: readonly PortfolioProjectRow[],
): PortfolioConcentration {
  const byClient = new Map<string, { name: string; pence: number }>();
  let totalValuePence = 0;
  for (const r of rows) {
    totalValuePence += r.valuePence;
    const entry = byClient.get(r.clientId);
    if (entry) entry.pence += r.valuePence;
    else byClient.set(r.clientId, { name: r.clientName, pence: r.valuePence });
  }
  let topClientId: string | null = null;
  let topClientName: string | null = null;
  let topClientValuePence = 0;
  for (const [clientId, entry] of byClient) {
    if (entry.pence > topClientValuePence) {
      topClientId = clientId;
      topClientName = entry.name;
      topClientValuePence = entry.pence;
    }
  }
  const pct =
    totalValuePence > 0 ? Math.round((topClientValuePence / totalValuePence) * 1000) / 10 : 0;
  return { topClientId, topClientName, topClientValuePence, totalValuePence, pct };
}

export interface PortfolioResult {
  month: string;
  rows: PortfolioProjectRow[];
  totals: { costPence: number; valuePence: number };
  concentration: PortfolioConcentration;
}

interface PortfolioSqlRow {
  project_id: string;
  project_name: string;
  client_id: string;
  client_name: string;
  status: string;
  health: string;
  os_cost: number | string;
  emitted_cost: number | string;
  gross_revenue: number | string;
  refunds: number | string;
  minutes_saved: number | string;
  events_mtd: number | string;
  hourly_rate: number | string | null;
}

/**
 * Compute the portfolio payload for every LIVE project in the org, for the
 * current London calendar month-to-date. Deterministic in (orgId, now).
 * Never throws on an org with no live projects — rows: [], totals/
 * concentration all zero.
 */
export async function getPortfolio(orgId: string): Promise<PortfolioResult> {
  const win = sql`
    win as (
      select
        date_trunc('month', now() at time zone 'Europe/London')::date as m_start_day
    ),
    win2 as (
      select
        (m_start_day::timestamp at time zone 'Europe/London') as w_start,
        ((m_start_day + interval '1 month')::timestamp at time zone 'Europe/London') as w_end
      from win
    )`;

  const rows = (await db.execute(sql`
    with ${win},
    live_projects as (
      select p.id, p.name, p.health, p.status, p.hourly_rate_pence,
             c.id as client_id, c.name as client_name
      from projects p
      join clients c on c.id = p.client_id
      where p.org_id = ${orgId}::uuid and p.status = 'live'
    ),
    os_cost as (
      select r.project_id, coalesce(sum(r.cost_estimate_pence), 0)::bigint as pence
      from agent_runs r, win2
      where r.org_id = ${orgId}::uuid
        and r.project_id is not null
        and r.started_at >= win2.w_start and r.started_at < win2.w_end
      group by r.project_id
    ),
    emitted_cost as (
      select e.project_id, coalesce(sum((e.data->>'cost_pence')::bigint), 0)::bigint as pence
      from events e, win2
      where e.org_id = ${orgId}::uuid
        and e.type = 'agent.run.completed'
        and e.data->>'cost_pence' is not null
        and e.occurred_at >= win2.w_start and e.occurred_at < win2.w_end
      group by e.project_id
    ),
    revenue as (
      select e.project_id,
        coalesce(sum(e.value_pence) filter (
          where e.value_pence is not null and e.value_pence > 0 and e.type <> 'payment.refunded'
        ), 0)::bigint as gross,
        coalesce(sum(e.value_pence) filter (where e.type = 'payment.refunded'), 0)::bigint as refunds,
        coalesce(sum(e.minutes_saved), 0)::numeric as minutes_saved,
        count(*)::int as events_mtd
      from events e, win2
      where e.org_id = ${orgId}::uuid
        and e.occurred_at >= win2.w_start and e.occurred_at < win2.w_end
      group by e.project_id
    )
    select
      lp.id as project_id, lp.name as project_name,
      lp.client_id as client_id, lp.client_name as client_name,
      lp.status as status, lp.health as health,
      coalesce(oc.pence, 0) as os_cost,
      coalesce(ec.pence, 0) as emitted_cost,
      coalesce(rv.gross, 0) as gross_revenue,
      coalesce(rv.refunds, 0) as refunds,
      coalesce(rv.minutes_saved, 0) as minutes_saved,
      coalesce(rv.events_mtd, 0) as events_mtd,
      coalesce(lp.hourly_rate_pence, ${DEFAULT_HOURLY_RATE_PENCE}) as hourly_rate
    from live_projects lp
    left join os_cost oc on oc.project_id = lp.id
    left join emitted_cost ec on ec.project_id = lp.id
    left join revenue rv on rv.project_id = lp.id
    order by lp.name asc
  `)) as unknown as PortfolioSqlRow[];

  const monthRows = (await db.execute(sql`
    select to_char(date_trunc('month', now() at time zone 'Europe/London'), 'YYYY-MM') as month
  `)) as unknown as { month: string }[];
  const month = monthRows[0]?.month ?? "";

  const portfolioRows: PortfolioProjectRow[] = rows.map((row) => {
    const health = (row.health === "amber" || row.health === "red" ? row.health : "green") as
      | "green"
      | "amber"
      | "red";
    const osCostPence = num(row.os_cost);
    const emittedCostPence = num(row.emitted_cost);
    const grossRevenuePence = num(row.gross_revenue);
    const refundsPence = num(row.refunds);
    const minutesSaved = num(row.minutes_saved);
    const eventsMtd = num(row.events_mtd);
    const hourlyRatePence =
      row.hourly_rate === null || row.hourly_rate === undefined
        ? DEFAULT_HOURLY_RATE_PENCE
        : num(row.hourly_rate);

    const derived = deriveProjectFinancials({
      osCostPence,
      emittedCostPence,
      grossRevenuePence,
      refundsPence,
      minutesSaved,
      hourlyRatePence,
      eventsMtd,
    });

    return {
      projectId: row.project_id,
      projectName: row.project_name,
      clientId: row.client_id,
      clientName: row.client_name,
      status: row.status,
      health,
      osCostPence,
      emittedCostPence,
      eventsMtd,
      ...derived,
    };
  });

  const ranked = rankByRoi(portfolioRows);
  const totals = ranked.reduce(
    (acc, r) => ({
      costPence: acc.costPence + r.costPence,
      valuePence: acc.valuePence + r.valuePence,
    }),
    { costPence: 0, valuePence: 0 },
  );
  const concentration = computeConcentration(ranked);

  return { month, rows: ranked, totals, concentration };
}
