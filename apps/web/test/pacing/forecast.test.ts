import { describe, expect, it } from "vitest";
import { computeForecastBand } from "../../lib/server/forecast";

/**
 * P9-PACK1 — deterministic forecast bands (docs/phase9/CONTRACTS.md
 * §P9-PACK1). computeForecastBand is pure: a known linear series must yield
 * an exact slope/intercept/band, and a flat or empty series must yield null
 * (no band) without crashing.
 */

function daySeries(values: number[], startIso = "2026-06-01T00:00:00.000Z") {
  const start = new Date(startIso).getTime();
  return values.map((value, i) => ({
    periodStart: new Date(start + i * 86_400_000).toISOString(),
    value,
  }));
}

describe("computeForecastBand", () => {
  it("known perfectly-linear series: exact slope, intercept, and zero-width band", () => {
    // value = 10*i + 10 for i=0..27 (28 points: 10, 20, 30 ... 280)
    const values = Array.from({ length: 28 }, (_, i) => 10 * i + 10);
    const series = daySeries(values);

    const result = computeForecastBand(series);
    expect(result).not.toBeNull();
    expect(result!.slope).toBe(10);
    expect(result!.intercept).toBe(10);
    expect(result!.residualStdDev).toBe(0); // perfect fit — no residual spread
    expect(result!.points).toHaveLength(7);

    // x continues at index 28..34 (0-based, following the 28-point window):
    // mid = 10*x + 10 → 290, 300, ... 360; band collapses to the line itself.
    const mids = result!.points.map((p) => p.mid);
    expect(mids).toEqual([290, 300, 310, 320, 330, 340, 350]);
    for (const p of result!.points) {
      expect(p.low).toBe(p.mid);
      expect(p.high).toBe(p.mid);
    }

    // the projection continues one calendar day at a time from the series'
    // last point (2026-06-01 + 27 days = 2026-06-28, so h=1 is 2026-06-29).
    expect(result!.points[0]!.periodStart).toBe("2026-06-29T00:00:00.000Z");
    expect(result!.points[6]!.periodStart).toBe("2026-07-05T00:00:00.000Z");
  });

  it("known series with real residual spread: hand-computed OLS slope/intercept and exact band", () => {
    // x=[0,1,2,3], y=[0,4,4,8]. By hand: xMean=1.5, yMean=4,
    // Sxy=6+0+0+6=12, Sxx=2.25+0.25+0.25+2.25=5 → slope=12/5=2.4,
    // intercept=4-2.4*1.5=0.4. Residuals [-0.4,+1.2,-1.2,+0.4] → population
    // variance=(0.16+1.44+1.44+0.16)/4=0.8 → stddev=sqrt(0.8)=0.8944271910.
    const series = daySeries([0, 4, 4, 8]);
    const result = computeForecastBand(series, { windowDays: 4, horizonDays: 2 });
    expect(result).not.toBeNull();
    expect(result!.slope).toBe(2.4);
    expect(result!.intercept).toBe(0.4);
    // residualStdDev is rounded to 4dp (round4) before it's returned.
    expect(result!.residualStdDev).toBeCloseTo(Math.sqrt(0.8), 4);

    // h=1 → x=4 → mid=2.4*4+0.4=10.0; h=2 → x=5 → mid=2.4*5+0.4=12.4
    expect(result!.points).toEqual([
      { periodStart: "2026-06-05T00:00:00.000Z", mid: 10, low: 9.11, high: 10.89 },
      { periodStart: "2026-06-06T00:00:00.000Z", mid: 12.4, low: 11.51, high: 13.29 },
    ]);
  });

  it("flat series (every value identical): no band, no crash", () => {
    const series = daySeries(Array.from({ length: 28 }, () => 50));
    expect(computeForecastBand(series)).toBeNull();
  });

  it("empty series: no band, no crash", () => {
    expect(computeForecastBand([])).toBeNull();
  });

  it("all-null series: no band, no crash", () => {
    const series = Array.from({ length: 10 }, (_, i) => ({
      periodStart: new Date(Date.now() + i * 86_400_000).toISOString(),
      value: null,
    }));
    expect(computeForecastBand(series)).toBeNull();
  });

  it("a single real point: not enough signal, no band, no crash", () => {
    const series = daySeries([42]);
    expect(computeForecastBand(series)).toBeNull();
  });

  it("only uses the trailing windowDays points, but continues the x-axis from the FULL tail length", () => {
    // 35 points: first 7 are a wildly different level (should be excluded
    // from the fit by windowDays=28), last 28 are the same clean line as the
    // first test above, so the fit must reproduce those exact coefficients
    // AND the horizon must continue from index 34 (35-1), not 27.
    const noise = Array.from({ length: 7 }, () => 9999);
    const clean = Array.from({ length: 28 }, (_, i) => 10 * i + 10);
    const series = daySeries([...noise, ...clean]);

    const result = computeForecastBand(series, { windowDays: 28 });
    expect(result).not.toBeNull();
    expect(result!.slope).toBe(10);
    expect(result!.intercept).toBe(10);
    // last tail index is 27 (0-based within the 28-point tail) → x=28 for h=1
    expect(result!.points[0]!.mid).toBe(290);
  });
});
