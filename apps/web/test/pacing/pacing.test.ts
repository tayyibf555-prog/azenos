import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, db, metricRollups } from "@azen/db";
import {
  computeGoalPacing,
  computeProjectGoalPacing,
  londonPeriodBounds,
} from "../../lib/server/pacing";
import { cleanupHarness, createHarness, type RollupHarness } from "../rollup/helpers";

/**
 * P9-PACK1 — goal pacing (docs/phase9/CONTRACTS.md §P9-PACK1).
 *
 * Two layers, matching the module's own split:
 *  - londonPeriodBounds / computeGoalPacing are PURE — no DB, hand-built
 *    actual-to-date numbers, exact expected values (including two month
 *    boundaries: a 28-day Feb and a week spanning Jan→Feb).
 *  - computeProjectGoalPacing is the DB-reading orchestrator — exercised
 *    against hand-built metric_rollups rows in a throwaway org, proving the
 *    range-match read finds the right bucket and ignores a decoy row from a
 *    different period.
 */

describe("londonPeriodBounds (pure, deterministic)", () => {
  it("day: BST instant — bounds are the DST-correct London midnight..midnight", () => {
    const now = new Date("2026-07-16T15:00:00.000Z");
    const bounds = londonPeriodBounds("day", now);
    expect(bounds.start.toISOString()).toBe("2026-07-15T23:00:00.000Z");
    expect(bounds.end.toISOString()).toBe("2026-07-16T23:00:00.000Z");
  });

  it("month: non-leap Feb 2026 is a 28-day window", () => {
    const now = new Date("2026-02-15T12:00:00.000Z");
    const bounds = londonPeriodBounds("month", now);
    expect(bounds.start.toISOString()).toBe("2026-02-01T00:00:00.000Z");
    expect(bounds.end.toISOString()).toBe("2026-03-01T00:00:00.000Z");
    const days = (bounds.end.getTime() - bounds.start.getTime()) / 86_400_000;
    expect(days).toBe(28);
  });

  it("month: leap Feb 2028 is a 29-day window (same day-of-month, different length)", () => {
    const now = new Date("2028-02-15T12:00:00.000Z");
    const bounds = londonPeriodBounds("month", now);
    expect(bounds.start.toISOString()).toBe("2028-02-01T00:00:00.000Z");
    expect(bounds.end.toISOString()).toBe("2028-03-01T00:00:00.000Z");
    const days = (bounds.end.getTime() - bounds.start.getTime()) / 86_400_000;
    expect(days).toBe(29);
  });

  it("week: Monday-start window spanning a Jan→Feb month boundary", () => {
    // 2026-01-29 is a Thursday; its Mon-start week is 26 Jan – 1 Feb.
    const now = new Date("2026-01-29T12:00:00.000Z");
    const bounds = londonPeriodBounds("week", now);
    expect(bounds.start.toISOString()).toBe("2026-01-26T00:00:00.000Z");
    expect(bounds.end.toISOString()).toBe("2026-02-02T00:00:00.000Z");
  });
});

describe("computeGoalPacing (pure, hand-built actual-to-date)", () => {
  it("day goal at 2/3 elapsed: exact expected-to-date and behind-pace flag", () => {
    const now = new Date("2026-07-16T15:00:00.000Z"); // 16h into a 24h London day
    const result = computeGoalPacing(
      { metric: "bookings_created", target: 90, period: "day" },
      50,
      now,
    );
    expect(result.elapsedFraction).toBeCloseTo(2 / 3, 4);
    expect(result.expectedToDate).toBe(60);
    expect(result.actualToDate).toBe(50);
    expect(result.pacePct).toBeCloseTo(83.33, 1);
    expect(result.onPace).toBe(false);
  });

  it("month goal, non-leap Feb, mid-month: exact fraction from real (28-day) month length", () => {
    const now = new Date("2026-02-15T12:00:00.000Z"); // 14.5 / 28 days elapsed
    const result = computeGoalPacing(
      { metric: "revenue", target: 280, period: "month" },
      145,
      now,
    );
    expect(result.elapsedFraction).toBeCloseTo(14.5 / 28, 4);
    expect(result.expectedToDate).toBe(145);
    expect(result.pacePct).toBe(100);
    expect(result.onPace).toBe(true);
  });

  it("month goal, leap Feb, same day-of-month: DIFFERENT fraction from the 29-day length", () => {
    const now = new Date("2028-02-15T12:00:00.000Z"); // 14.5 / 29 days elapsed = exactly 0.5
    const result = computeGoalPacing(
      { metric: "revenue", target: 200, period: "month" },
      100,
      now,
    );
    expect(result.elapsedFraction).toBe(0.5);
    expect(result.expectedToDate).toBe(100);
    expect(result.pacePct).toBe(100);
    expect(result.onPace).toBe(true);
  });

  it("week goal spanning a month boundary: exact half-elapsed, behind pace", () => {
    const now = new Date("2026-01-29T12:00:00.000Z"); // 3.5 / 7 days = exactly half
    const result = computeGoalPacing(
      { metric: "bookings_created", target: 140, period: "week" },
      50,
      now,
    );
    expect(result.elapsedFraction).toBe(0.5);
    expect(result.expectedToDate).toBe(70);
    expect(result.pacePct).toBeCloseTo(71.43, 1);
    expect(result.onPace).toBe(false);
  });

  it("zero elapsed (now === period start): nothing expected yet, always on pace, pacePct null", () => {
    const bounds = londonPeriodBounds("day", new Date("2026-07-16T15:00:00.000Z"));
    const result = computeGoalPacing(
      { metric: "bookings_created", target: 50, period: "day" },
      0,
      bounds.start,
    );
    expect(result.elapsedFraction).toBe(0);
    expect(result.expectedToDate).toBe(0);
    expect(result.pacePct).toBeNull();
    expect(result.onPace).toBe(true);
  });

  it("exactly on pace at the boundary (actual === expected) counts as on-pace", () => {
    const now = new Date("2026-07-16T15:00:00.000Z");
    const result = computeGoalPacing(
      { metric: "bookings_created", target: 90, period: "day" },
      60,
      now,
    );
    expect(result.pacePct).toBe(100);
    expect(result.onPace).toBe(true);
  });
});

describe("computeProjectGoalPacing (DB-reading orchestrator, throwaway org)", () => {
  let h: RollupHarness;

  beforeAll(async () => {
    h = await createHarness("Pacing test project");
  });

  afterEach(async () => {
    await db.delete(metricRollups).where(eq(metricRollups.orgId, h.orgId));
  });

  afterAll(async () => {
    await cleanupHarness(h);
    await closeDb();
  });

  it("reads the current month's live-to-date rollup and ignores a decoy from the prior month", async () => {
    const now = new Date("2026-02-15T12:00:00.000Z");
    const monthBounds = londonPeriodBounds("month", now);
    const priorMonthStart = londonPeriodBounds(
      "month",
      new Date("2026-01-15T12:00:00.000Z"),
    ).start;

    await db.insert(metricRollups).values([
      {
        orgId: h.orgId,
        projectId: h.projectId,
        metricKey: "bookings_created",
        period: "month",
        periodStart: monthBounds.start,
        value: 65,
        sampleCount: 65,
      },
      {
        // decoy: same metric/project, PRIOR month — must never be summed in.
        orgId: h.orgId,
        projectId: h.projectId,
        metricKey: "bookings_created",
        period: "month",
        periodStart: priorMonthStart,
        value: 999,
        sampleCount: 999,
      },
    ]);

    const [result] = await computeProjectGoalPacing(
      h.orgId,
      h.projectId,
      [{ metric: "bookings_created", target: 280, period: "month" }],
      now,
    );

    expect(result!.actualToDate).toBe(65);
    expect(result!.expectedToDate).toBe(145);
    expect(result!.onPace).toBe(false);
  });

  it("a goal with no rollup row yet degrades gracefully to actualToDate=0", async () => {
    const now = new Date("2026-02-15T12:00:00.000Z");
    const [result] = await computeProjectGoalPacing(
      h.orgId,
      h.projectId,
      [{ metric: "never_seen_metric", target: 10, period: "week" }],
      now,
    );
    expect(result!.actualToDate).toBe(0);
    expect(result!.onPace).toBe(false);
  });

  it("batches two goals on the same period into one query and preserves declared goal order", async () => {
    const now = new Date("2026-01-29T12:00:00.000Z");
    const weekBounds = londonPeriodBounds("week", now);
    await db.insert(metricRollups).values([
      {
        orgId: h.orgId,
        projectId: h.projectId,
        metricKey: "bookings_created",
        period: "week",
        periodStart: weekBounds.start,
        value: 50,
        sampleCount: 50,
      },
      {
        orgId: h.orgId,
        projectId: h.projectId,
        metricKey: "escalations",
        period: "week",
        periodStart: weekBounds.start,
        value: 3,
        sampleCount: 3,
      },
    ]);

    const results = await computeProjectGoalPacing(
      h.orgId,
      h.projectId,
      [
        { metric: "bookings_created", target: 140, period: "week" },
        { metric: "escalations", target: 10, period: "week" },
      ],
      now,
    );

    expect(results.map((r) => r.metric)).toEqual(["bookings_created", "escalations"]);
    expect(results[0]!.actualToDate).toBe(50);
    expect(results[1]!.actualToDate).toBe(3);
  });
});
