/**
 * Cost-spike health rule (docs/phase9/CONTRACTS.md — P9-COST). ADDITIVE to the
 * Phase-8 evaluator: it lives in its own file and produces `cost_spike` alert
 * signals the evaluator (evaluate.ts) folds into its existing per-project
 * reconciliation loop — same (project, check) dedupe + auto-resolve as every
 * other health check, so a spike fires ONCE and clears itself when spend
 * normalises.
 *
 * Rule (money-correctness — the boundaries are pinned and unit-tested):
 *   a project's combined API spend (OS agent_runs + client-emitted
 *   agent.run.completed) over the last 7 days is a spike when
 *     this7d  >  COST_SPIKE_RATIO × prior7d   (strictly greater)  AND
 *     this7d  >  COST_SPIKE_MIN_ABS_PENCE     (absolute floor — noise guard)
 *   → alert_instances kind `cost_spike`, severity `warn`.
 *
 * A zero prior window has no ratio baseline, so it never fires on its own — a
 * brand-new project's first week of spend is not a "spike". Deterministic in
 * (input); the DB loader is deterministic in (orgId, now).
 */
import { db } from "@azen/db";
import { sql } from "drizzle-orm";

/** this7d must exceed prior7d by strictly more than this factor. */
export const COST_SPIKE_RATIO = 1.4;
/** …and this7d must clear this absolute floor (£5) — below it, never fires. */
export const COST_SPIKE_MIN_ABS_PENCE = 500;

/** Aggregated per-project spend the rule judges. Both figures are pence. */
export interface CostSpikeInput {
  projectId: string;
  clientId: string | null;
  /** OS + client-emitted spend over the last 7 London-rolling days. */
  thisSpendPence: number;
  /** …over the 7 days before that. */
  priorSpendPence: number;
}

/** A cost-spike breach → an alert_instances row (kind/check `cost_spike`). */
export interface CostSpikeSignal {
  projectId: string;
  /** dedupe discriminator, matches the evaluator's (project, check) key */
  check: "cost_spike";
  kind: "cost_spike";
  severity: "warn";
  message: string;
  evidence: Record<string, unknown>;
}

const round = (n: number): number => Math.round(n);

/**
 * Pure spike test. Returns the signal when both conditions hold, else null.
 * Exported for unit tests (the pinned boundaries: 1.39× no, 1.41× yes,
 * sub-£5 never).
 */
export function evaluateCostSpike(input: CostSpikeInput): CostSpikeSignal | null {
  const { thisSpendPence, priorSpendPence } = input;
  // Absolute floor first — sub-£5 spend never spikes, regardless of ratio.
  if (thisSpendPence <= COST_SPIKE_MIN_ABS_PENCE) return null;
  // No prior baseline → no ratio to exceed; a first active week is not a spike.
  if (priorSpendPence <= 0) return null;
  if (thisSpendPence <= COST_SPIKE_RATIO * priorSpendPence) return null;

  const ratio = Math.round((thisSpendPence / priorSpendPence) * 100) / 100;
  return {
    projectId: input.projectId,
    check: "cost_spike",
    kind: "cost_spike",
    severity: "warn",
    message: `API spend spiked ${ratio.toLocaleString("en-GB")}× — £${(
      thisSpendPence / 100
    ).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} in 7d vs £${(
      priorSpendPence / 100
    ).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} prior`,
    evidence: {
      check: "cost_spike",
      this_spend_pence: round(thisSpendPence),
      prior_spend_pence: round(priorSpendPence),
      ratio,
      threshold_ratio: COST_SPIKE_RATIO,
      min_abs_pence: COST_SPIKE_MIN_ABS_PENCE,
    },
  };
}

interface SpendRow {
  project_id: string;
  client_id: string | null;
  this_spend: number | string;
  prior_spend: number | string;
}

/**
 * Read each LIVE project's combined API spend for the two rolling 7-day windows
 * ending at `now`. Merges the two cost streams the API-Cost section reports:
 *   (a) OS costs   — agent_runs.cost_estimate_pence
 *   (b) emitted    — events(type='agent.run.completed').data.cost_pence
 * Only the last 14 days are scanned. Deterministic in (orgId, now).
 */
export async function loadCostSpikeInputs(
  orgId: string,
  now: Date,
): Promise<CostSpikeInput[]> {
  const nowIso = now.toISOString();
  const rows = (await db.execute(sql`
    with w as (
      select
        (${nowIso}::timestamptz - interval '7 days')  as this_start,
        (${nowIso}::timestamptz)                       as this_end,
        (${nowIso}::timestamptz - interval '14 days')  as prior_start,
        (${nowIso}::timestamptz - interval '7 days')   as prior_end
    ),
    spend as (
      select project_id, cost_pence, ts from (
        select r.project_id as project_id,
               coalesce(r.cost_estimate_pence, 0)::numeric as cost_pence,
               r.started_at as ts
        from agent_runs r
        where r.org_id = ${orgId}::uuid and r.project_id is not null
          and r.started_at >= (${nowIso}::timestamptz - interval '14 days')
        union all
        select e.project_id as project_id,
               coalesce((e.data->>'cost_pence')::numeric, 0) as cost_pence,
               e.occurred_at as ts
        from events e
        where e.org_id = ${orgId}::uuid and e.project_id is not null
          and e.type = 'agent.run.completed'
          and (e.data ? 'cost_pence')
          and e.occurred_at >= (${nowIso}::timestamptz - interval '14 days')
      ) s
    )
    select
      p.id as project_id,
      p.client_id as client_id,
      coalesce(sum(spend.cost_pence) filter (
        where spend.ts >= w.this_start and spend.ts < w.this_end), 0)::bigint as this_spend,
      coalesce(sum(spend.cost_pence) filter (
        where spend.ts >= w.prior_start and spend.ts < w.prior_end), 0)::bigint as prior_spend
    from projects p
    cross join w
    left join spend on spend.project_id = p.id
    where p.org_id = ${orgId}::uuid and p.status = 'live'
    group by p.id, p.client_id
  `)) as unknown as SpendRow[];

  return rows.map((r) => ({
    projectId: r.project_id,
    clientId: r.client_id,
    thisSpendPence: Number(r.this_spend) || 0,
    priorSpendPence: Number(r.prior_spend) || 0,
  }));
}

/** Load + evaluate: every live project's cost-spike signal (breaches only). */
export async function costSpikeSignals(
  orgId: string,
  now: Date,
): Promise<CostSpikeSignal[]> {
  const inputs = await loadCostSpikeInputs(orgId, now);
  const out: CostSpikeSignal[] = [];
  for (const input of inputs) {
    const signal = evaluateCostSpike(input);
    if (signal) out.push(signal);
  }
  return out;
}
