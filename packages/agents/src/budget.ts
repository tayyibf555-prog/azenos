import { AGENT_BUDGET_PENCE_MONTHLY } from "@azen/config";
import { db } from "@azen/db";

/**
 * Fleet + chat budget guard (spec §13, docs/phase3/CONTRACTS.md §P3-RUNNER).
 * Sums BOTH agent_runs.costEstimatePence AND chat_messages.costEstimatePence
 * (Ask Azen, §9.8 — chat counts against the same cap) for the current
 * Europe/London calendar month, compared to AGENT_BUDGET_PENCE_MONTHLY: warn
 * at ≥80%, halt at ≥100%. The runner blocks non-critical runs at `halt`; the
 * daily brief passes critical:true and always runs.
 *
 * The month boundary is computed in Postgres via the shared rollup bucket
 * pattern (`date_trunc('month', now() at time zone 'Europe/London') at time
 * zone 'Europe/London'`) so it is DST-correct — never hand-rolled tz math.
 */

export type BudgetState = "ok" | "warn" | "halt";

export interface BudgetStatus {
  spentPence: number;
  capPence: number;
  remainingPence: number;
  state: BudgetState;
}

const WARN_RATIO = 0.8;

export async function checkBudget(orgId: string): Promise<BudgetStatus> {
  const client = db.$client;
  // London month start (DST-correct, shared rollup pattern).
  const rows = (await client`
    with month_start as (
      select (date_trunc('month', now() at time zone 'Europe/London')) at time zone 'Europe/London' as ts
    )
    select (
      coalesce((select sum(cost_estimate_pence) from agent_runs
                where org_id = ${orgId}::uuid and started_at >= (select ts from month_start)), 0)
      + coalesce((select sum(cost_estimate_pence) from chat_messages
                  where org_id = ${orgId}::uuid and created_at >= (select ts from month_start)), 0)
    )::float8 as spent
  `) as unknown as { spent: number }[];

  const spentPence = Math.round(Number(rows[0]?.spent ?? 0));
  const capPence = AGENT_BUDGET_PENCE_MONTHLY;
  const remainingPence = capPence - spentPence;

  let state: BudgetState = "ok";
  if (capPence > 0) {
    const ratio = spentPence / capPence;
    if (ratio >= 1) state = "halt";
    else if (ratio >= WARN_RATIO) state = "warn";
  } else {
    // A non-positive cap means no budget configured — any spend halts.
    state = spentPence > 0 ? "halt" : "ok";
  }

  return { spentPence, capPence, remainingPence, state };
}
