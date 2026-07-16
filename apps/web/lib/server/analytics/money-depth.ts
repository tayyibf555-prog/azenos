/**
 * Money section depth (P9-PACK3 — docs/phase9/CONTRACTS.md). Pure math only —
 * no I/O — so it can be unit-tested against hand-built numbers; the money
 * analytics route (app/api/projects/[projectId]/analytics/money/route.ts)
 * does the SQL aggregation and calls these helpers to derive the additive
 * fields on `MoneyData`.
 */

/**
 * Payback period, in months: how long the client's project value needs to
 * "earn back" the one-off build fee, at the CURRENT trailing-30-day pace of
 * attributed value (net revenue + time-saved value — the same "value
 * returned" convention as the ROI hero). Deliberately independent of the
 * section's selected range control — payback is a monthly-cadence metric.
 * Null (not Infinity/NaN) when either side is non-positive: no build fee to
 * pay back, or no value yet to pay it back with.
 */
export function computePaybackMonths(
  buildFeePence: number,
  monthlyAttributedValuePence: number,
): number | null {
  if (buildFeePence <= 0 || monthlyAttributedValuePence <= 0) return null;
  return Math.round((buildFeePence / monthlyAttributedValuePence) * 100) / 100;
}

export interface LtvCurvePoint {
  /** 'YYYY-MM' London month label. */
  month: string;
  /** Σ agency payments received THAT month (not cumulative). */
  pence: number;
  /** running total of `pence` up to and including this month. */
  cumulativePence: number;
}

/**
 * Turn per-month agency payment sums (ascending, one row per month that had
 * ANY payment — no zero-filling needed, an LTV curve only cares about months
 * money actually moved) into a cumulative curve. Pure: the SQL side only ever
 * needs a `group by month` sum; the running total is computed here so it is
 * unit-testable without a database.
 */
export function buildLtvCurve(
  monthlyRows: readonly { month: string; pence: number }[],
): LtvCurvePoint[] {
  let running = 0;
  return monthlyRows.map((row) => {
    running += row.pence;
    return { month: row.month, pence: row.pence, cumulativePence: running };
  });
}

export type ConcentrationTone = "high" | "moderate" | "low";

export interface RevenueConcentration {
  clientPence: number;
  orgPence: number;
  /** clientPence ÷ orgPence × 100, rounded to 1dp; 0 when orgPence is 0. */
  pct: number;
  tone: ConcentrationTone;
}

/**
 * How concentrated the agency's OWN revenue is on this project's client —
 * a risk note, not a client-facing figure. Thresholds pinned in code:
 * >50% = high (single-client risk), 25–50% = moderate, <25% = low/diversified.
 */
export function computeRevenueConcentration(
  clientPence: number,
  orgPence: number,
): RevenueConcentration {
  const pct = orgPence > 0 ? Math.round((clientPence / orgPence) * 1000) / 10 : 0;
  const tone: ConcentrationTone = pct > 50 ? "high" : pct >= 25 ? "moderate" : "low";
  return { clientPence, orgPence, pct, tone };
}
