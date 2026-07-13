import { db, runRollups } from "@azen/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupHarness,
  createHarness,
  insertDef,
  insertEvent,
  readRollups,
  type RollupHarness,
} from "./helpers";

/**
 * Aggregation grammar: `*` vs exact eventType, whereEquals filters, and the
 * value grammar (count/sum/avg/p95/last over $.value_pence / $.minutes_saved /
 * $.data.<key> with the non-numeric guard). All events land in one London day,
 * so each metric has a single day rollup to assert against.
 */

const DAY = "2026-07-05T10"; // BST; London day starts 2026-07-04T23:00Z

let h: RollupHarness;

beforeEach(async () => {
  h = await createHarness();
});

afterEach(async () => {
  await cleanupHarness(h);
});

async function dayRow(metricKey: string) {
  const rows = await readRollups(h, "day");
  return rows.find((r) => r.metricKey === metricKey);
}

it("`*` eventType counts everything; exact eventType filters", async () => {
  await insertDef(h, { key: "all_events", aggregation: "count", eventType: "*" });
  await insertDef(h, { key: "calls", aggregation: "count", eventType: "call.completed" });

  await insertEvent(h, { type: "call.completed", occurredAt: `${DAY}:00:00Z` });
  await insertEvent(h, { type: "call.completed", occurredAt: `${DAY}:05:00Z` });
  await insertEvent(h, { type: "form.submitted", occurredAt: `${DAY}:10:00Z` });
  await runRollups(db, { projectId: h.projectId });

  expect((await dayRow("all_events"))?.value).toBe(3);
  expect((await dayRow("all_events"))?.sampleCount).toBe(3);
  expect((await dayRow("calls"))?.value).toBe(2);
});

it("whereEquals filters by a data field (booleans stringify)", async () => {
  await insertDef(h, {
    key: "runs_ok",
    aggregation: "count",
    eventType: "agent.run.completed",
    whereEquals: { "$.data.success": true },
  });
  await insertDef(h, { key: "runs_all", aggregation: "count", eventType: "agent.run.completed" });

  await insertEvent(h, { type: "agent.run.completed", occurredAt: `${DAY}:00:00Z`, data: { success: true } });
  await insertEvent(h, { type: "agent.run.completed", occurredAt: `${DAY}:01:00Z`, data: { success: true } });
  await insertEvent(h, { type: "agent.run.completed", occurredAt: `${DAY}:02:00Z`, data: { success: false } });
  await runRollups(db, { projectId: h.projectId });

  expect((await dayRow("runs_ok"))?.value).toBe(2);
  expect((await dayRow("runs_all"))?.value).toBe(3);
});

it("avg over $.data.<key> ignores non-numeric / missing values", async () => {
  await insertDef(h, {
    key: "avg_amt",
    aggregation: "avg",
    eventType: "payment.captured",
    valuePath: "$.data.amount_pence",
    unit: "pence",
  });

  await insertEvent(h, { type: "payment.captured", occurredAt: `${DAY}:00:00Z`, data: { amount_pence: 100 } });
  await insertEvent(h, { type: "payment.captured", occurredAt: `${DAY}:01:00Z`, data: { amount_pence: 200 } });
  await insertEvent(h, { type: "payment.captured", occurredAt: `${DAY}:02:00Z`, data: { amount_pence: 300 } });
  // excluded: non-numeric string and a missing key contribute nothing
  await insertEvent(h, { type: "payment.captured", occurredAt: `${DAY}:03:00Z`, data: { amount_pence: "oops" } });
  await insertEvent(h, { type: "payment.captured", occurredAt: `${DAY}:04:00Z`, data: {} });
  await runRollups(db, { projectId: h.projectId });

  const row = await dayRow("avg_amt");
  expect(row?.value).toBe(200); // (100+200+300)/3
  expect(row?.sampleCount).toBe(3); // only the numeric rows count
});

it("p95 uses percentile_cont(0.95)", async () => {
  await insertDef(h, {
    key: "p95_val",
    aggregation: "p95",
    eventType: "custom.metric",
    valuePath: "$.data.value",
  });

  for (const [i, v] of [10, 20, 30, 40].entries()) {
    await insertEvent(h, { type: "custom.metric", occurredAt: `${DAY}:0${i}:00Z`, data: { value: v } });
  }
  await runRollups(db, { projectId: h.projectId });

  const row = await dayRow("p95_val");
  expect(row?.value).toBeCloseTo(38.5, 5); // 30 + 0.85*(40-30)
  expect(row?.sampleCount).toBe(4);
});

it("last returns the value at the max occurred_at in the bucket", async () => {
  await insertDef(h, {
    key: "last_val",
    aggregation: "last",
    eventType: "custom.metric",
    valuePath: "$.data.value",
  });

  await insertEvent(h, { type: "custom.metric", occurredAt: `${DAY}:00:00Z`, data: { value: 5 } });
  await insertEvent(h, { type: "custom.metric", occurredAt: `${DAY}:30:00Z`, data: { value: 99 } });
  await insertEvent(h, { type: "custom.metric", occurredAt: `${DAY}:20:00Z`, data: { value: 7 } });
  await runRollups(db, { projectId: h.projectId });

  expect((await dayRow("last_val"))?.value).toBe(99); // latest occurred_at wins
});

it("sum over envelope value_pence and minutes_saved", async () => {
  await insertDef(h, { key: "rev", aggregation: "sum", eventType: "*", valuePath: "$.value_pence", unit: "pence" });
  await insertDef(h, { key: "mins", aggregation: "sum", eventType: "*", valuePath: "$.minutes_saved", unit: "minutes" });

  await insertEvent(h, { type: "booking.created", occurredAt: `${DAY}:00:00Z`, valuePence: 1000, minutesSaved: 5 });
  await insertEvent(h, { type: "booking.created", occurredAt: `${DAY}:01:00Z`, valuePence: 2000, minutesSaved: 10 });
  await runRollups(db, { projectId: h.projectId });

  expect((await dayRow("rev"))?.value).toBe(3000);
  expect((await dayRow("mins"))?.value).toBe(15);
});
