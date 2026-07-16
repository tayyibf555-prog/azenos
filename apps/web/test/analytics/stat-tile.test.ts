import { describe, expect, it } from "vitest";
import {
  deltaTone,
  deltaToneColor,
  formatSignedDelta,
} from "../../components/analytics/StatTile";
import { COLORS } from "../../components/ui";

/**
 * P9-W0A — pure delta/direction logic behind every StatTile. Covers the
 * good-direction flip (goodDirection: "up" vs "down"), the neutral/zero
 * fallback, and the signed default label.
 */
describe("StatTile deltaTone", () => {
  it("reads a positive delta as good when up is good", () => {
    expect(deltaTone(5, "up")).toBe("good");
  });

  it("reads a negative delta as bad when up is good", () => {
    expect(deltaTone(-5, "up")).toBe("bad");
  });

  it("flips: a positive delta is bad when down is good (e.g. error rate)", () => {
    expect(deltaTone(5, "down")).toBe("bad");
  });

  it("flips: a negative delta is good when down is good", () => {
    expect(deltaTone(-5, "down")).toBe("good");
  });

  it("is neutral for a zero delta regardless of direction", () => {
    expect(deltaTone(0, "up")).toBe("neutral");
    expect(deltaTone(0, "down")).toBe("neutral");
  });

  it("is neutral for null/undefined (no comparison window yet)", () => {
    expect(deltaTone(null)).toBe("neutral");
    expect(deltaTone(undefined)).toBe("neutral");
  });

  it("is neutral for non-finite input", () => {
    expect(deltaTone(NaN, "up")).toBe("neutral");
    expect(deltaTone(Infinity, "up")).toBe("neutral");
  });

  it("defaults goodDirection to up", () => {
    expect(deltaTone(3)).toBe("good");
    expect(deltaTone(-3)).toBe("bad");
  });
});

describe("StatTile deltaToneColor", () => {
  it("maps good/bad/neutral to the green/red/grey tokens", () => {
    expect(deltaToneColor("good")).toBe(COLORS.green);
    expect(deltaToneColor("bad")).toBe(COLORS.red);
    expect(deltaToneColor("neutral")).toBe(COLORS.grey);
  });
});

describe("StatTile formatSignedDelta", () => {
  it("prefixes a positive delta with +", () => {
    expect(formatSignedDelta(12)).toBe("+12");
  });

  it("prefixes a negative delta with − and drops the sign from the number", () => {
    expect(formatSignedDelta(-7)).toBe("−7");
  });

  it("uses ± for exactly zero", () => {
    expect(formatSignedDelta(0)).toBe("±0");
  });

  it("thousands-separates large deltas", () => {
    expect(formatSignedDelta(12345)).toBe("+12,345");
  });

  it("returns null for null/undefined/non-finite (no delta chip rendered)", () => {
    expect(formatSignedDelta(null)).toBeNull();
    expect(formatSignedDelta(undefined)).toBeNull();
    expect(formatSignedDelta(NaN)).toBeNull();
  });
});
