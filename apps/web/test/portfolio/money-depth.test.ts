import { describe, expect, it } from "vitest";
import {
  buildLtvCurve,
  computePaybackMonths,
  computeRevenueConcentration,
} from "../../lib/server/analytics/money-depth";

describe("computePaybackMonths", () => {
  it("build fee ÷ monthly attributed value", () => {
    expect(computePaybackMonths(600_000, 200_000)).toBe(3);
    expect(computePaybackMonths(500_000, 200_000)).toBe(2.5);
  });

  it("null when there is no build fee", () => {
    expect(computePaybackMonths(0, 200_000)).toBeNull();
    expect(computePaybackMonths(-100, 200_000)).toBeNull();
  });

  it("null when there is no monthly value to pay it back with", () => {
    expect(computePaybackMonths(600_000, 0)).toBeNull();
    expect(computePaybackMonths(600_000, -50)).toBeNull();
  });

  it("rounds to 2dp", () => {
    // 100000 / 3000 = 33.333...
    expect(computePaybackMonths(100_000, 3_000)).toBe(33.33);
  });
});

describe("buildLtvCurve", () => {
  it("runs a cumulative total across months, in order", () => {
    const curve = buildLtvCurve([
      { month: "2026-01", pence: 100_000 },
      { month: "2026-02", pence: 50_000 },
      { month: "2026-03", pence: 0 },
      { month: "2026-04", pence: 200_000 },
    ]);
    expect(curve).toEqual([
      { month: "2026-01", pence: 100_000, cumulativePence: 100_000 },
      { month: "2026-02", pence: 50_000, cumulativePence: 150_000 },
      { month: "2026-03", pence: 0, cumulativePence: 150_000 },
      { month: "2026-04", pence: 200_000, cumulativePence: 350_000 },
    ]);
  });

  it("empty input → empty curve", () => {
    expect(buildLtvCurve([])).toEqual([]);
  });
});

describe("computeRevenueConcentration", () => {
  it("high tone strictly above 50%", () => {
    const r = computeRevenueConcentration(510_000, 1_000_000);
    expect(r.pct).toBe(51);
    expect(r.tone).toBe("high");
  });

  it("exactly 50% is moderate, not high", () => {
    const r = computeRevenueConcentration(500_000, 1_000_000);
    expect(r.pct).toBe(50);
    expect(r.tone).toBe("moderate");
  });

  it("moderate band is [25, 50]", () => {
    expect(computeRevenueConcentration(250_000, 1_000_000).tone).toBe("moderate");
    expect(computeRevenueConcentration(499_999, 1_000_000).tone).toBe("moderate");
  });

  it("low/diversified below 25%", () => {
    const r = computeRevenueConcentration(100_000, 1_000_000);
    expect(r.pct).toBe(10);
    expect(r.tone).toBe("low");
  });

  it("zero org total → 0% and low, never divides by zero", () => {
    const r = computeRevenueConcentration(0, 0);
    expect(r.pct).toBe(0);
    expect(r.tone).toBe("low");
  });
});
