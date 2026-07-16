/**
 * P9-PACK1 -- deterministic forecast bands (docs/phase9/CONTRACTS.md
 * §P9-PACK1). Simple ordinary-least-squares linear regression over a
 * trailing window of daily points, projected forward as a dashed +-1 stddev
 * (of the fit's own residuals) band. No randomness, no external service --
 * same input always yields the same slope/intercept/band, which is what
 * makes it directly unit-testable (test/pacing/forecast.test.ts).
 *
 * Deliberately declines to forecast (returns null) rather than render a
 * misleading line when there's nothing to project from:
 *   - fewer than 2 real (non-null) points in the window
 *   - every real value is identical (a flat series has no trend to extend --
 *     an OLS fit would still "succeed" with slope 0 and a zero-width band,
 *     which reads as false confidence rather than useful signal)
 */

const DEFAULT_WINDOW_DAYS = 28;
const DEFAULT_HORIZON_DAYS = 7;

export interface ForecastSeriesPoint {
  /** ISO instant (London-day bucket, as emitted by the daily volume series) */
  periodStart: string;
  value: number | null;
}

export interface ForecastBandPoint {
  /** ISO instant, one further London calendar day past the previous point */
  periodStart: string;
  /** the regression line's own projected value at this point */
  mid: number;
  /** mid - residualStdDev */
  low: number;
  /** mid + residualStdDev */
  high: number;
}

export interface ForecastResult {
  points: ForecastBandPoint[];
  slope: number;
  intercept: number;
  residualStdDev: number;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;

/** Add whole calendar days to an ISO instant (UTC date-part arithmetic --
 * a display-only label continuation, not a bucket-boundary computation, so
 * DST-second precision doesn't matter here the way it does in pacing.ts). */
function addCalendarDays(iso: string, days: number): string {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

/**
 * Deterministic linear regression forecast over the trailing `windowDays`
 * points of `series` (expected to already be daily-bucketed and zero-filled,
 * e.g. Pulse's daily-volume series), projected `horizonDays` beyond the last
 * point. Returns null when there isn't enough signal to project responsibly
 * (see module doc) -- never throws.
 */
export function computeForecastBand(
  series: ForecastSeriesPoint[],
  opts?: { windowDays?: number; horizonDays?: number },
): ForecastResult | null {
  const windowDays = opts?.windowDays ?? DEFAULT_WINDOW_DAYS;
  const horizonDays = opts?.horizonDays ?? DEFAULT_HORIZON_DAYS;
  if (series.length === 0) return null;

  const tail = series.slice(-windowDays);
  const xs: number[] = [];
  const ys: number[] = [];
  tail.forEach((p, i) => {
    if (p.value === null || !Number.isFinite(p.value)) return;
    xs.push(i);
    ys.push(p.value);
  });

  const n = xs.length;
  if (n < 2) return null;

  const allSame = ys.every((y) => y === ys[0]);
  if (allSame) return null; // flat series -- nothing to project (module doc)

  const xMean = xs.reduce((a, b) => a + b, 0) / n;
  const yMean = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - xMean;
    num += dx * (ys[i]! - yMean);
    den += dx * dx;
  }
  if (den === 0) return null; // degenerate (shouldn't happen for n>=2 distinct indices)

  const slope = num / den;
  const intercept = yMean - slope * xMean;

  const residuals = xs.map((x, i) => ys[i]! - (slope * x + intercept));
  const residMean = residuals.reduce((a, b) => a + b, 0) / n;
  const variance = residuals.reduce((a, b) => a + (b - residMean) ** 2, 0) / n;
  const stdDev = Math.sqrt(variance);

  // Project from the end of the FULL tail window (not just the count of
  // non-null points), so gaps in the middle of the window don't compress the
  // x-axis scale used to extrapolate forward.
  const lastIndex = tail.length - 1;
  const lastPeriodStart = tail[tail.length - 1]!.periodStart;

  const points: ForecastBandPoint[] = [];
  for (let h = 1; h <= horizonDays; h++) {
    const x = lastIndex + h;
    const mid = slope * x + intercept;
    points.push({
      periodStart: addCalendarDays(lastPeriodStart, h),
      mid: round2(mid),
      low: round2(mid - stdDev),
      high: round2(mid + stdDev),
    });
  }

  return {
    points,
    slope: round4(slope),
    intercept: round4(intercept),
    residualStdDev: round4(stdDev),
  };
}
