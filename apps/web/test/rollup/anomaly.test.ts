import { db, detectAnomaliesForProject, insights } from "@azen/db";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupHarness,
  countAnomalies,
  createHarness,
  insertDef,
  insertRollupRow,
  londonDayStartsUTC,
  type RollupHarness,
} from "./helpers";

/**
 * §8.4 anomaly detection. We build the day rollups directly (28 near-flat
 * trailing days + a spike yesterday) and run the detector, so the test isolates
 * the z-score + dedup logic from the aggregation engine.
 */

let h: RollupHarness;

beforeEach(async () => {
  h = await createHarness("Anomaly Co");
});

afterEach(async () => {
  await cleanupHarness(h);
});

describe("anomaly detector", () => {
  it("writes one insight for a spike and never duplicates it", async () => {
    await insertDef(h, {
      key: "test_kpi",
      name: "Test KPI",
      aggregation: "count",
      eventType: "custom.metric",
      isKpi: true,
    });

    // index 0 = yesterday (spike), indices 1..28 = the trailing 28 days (flat)
    const days = await londonDayStartsUTC(29);
    await insertRollupRow(h, {
      metricKey: "test_kpi",
      period: "day",
      periodStartIso: days[0]!,
      value: 50,
      sampleCount: 50,
    });
    for (let i = 1; i <= 28; i++) {
      const v = 10 + (i % 3); // 10..12 → non-zero σ, mean ≈ 11
      await insertRollupRow(h, {
        metricKey: "test_kpi",
        period: "day",
        periodStartIso: days[i]!,
        value: v,
        sampleCount: v,
      });
    }

    const created = await detectAnomaliesForProject(db, h.orgId, h.projectId);
    expect(created).toBe(1);
    expect(await countAnomalies(h)).toBe(1);

    const [row] = await db
      .select({
        title: insights.title,
        evidence: insights.evidence,
        confidence: insights.confidence,
        status: insights.status,
        createdBy: insights.createdBy,
      })
      .from(insights)
      .where(and(eq(insights.orgId, h.orgId), eq(insights.kind, "anomaly")));

    expect(row?.title).toContain("Test KPI up vs 28-day normal");
    expect(row?.title).toContain("Anomaly Co");
    expect(row?.confidence).toBe("med");
    expect(row?.status).toBe("new");
    expect(row?.createdBy).toBe("agent");
    expect(row?.evidence.metric_key).toBe("test_kpi");
    expect(row?.evidence.value).toBe(50);
    expect(row?.evidence.period_start).toBe(days[0]);

    // second run must not duplicate the open anomaly
    const again = await detectAnomaliesForProject(db, h.orgId, h.projectId);
    expect(again).toBe(0);
    expect(await countAnomalies(h)).toBe(1);
  });
});
