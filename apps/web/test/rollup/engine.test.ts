import { db, metricRollups, runIncrementalRollupForProject, runRollups } from "@azen/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupHarness,
  createHarness,
  insertDef,
  insertEvent,
  readRollups,
  readWatermark,
  type RollupHarness,
} from "./helpers";

const DAY = "2026-07-05T10"; // London day starts 2026-07-04T23:00Z

let h: RollupHarness;

beforeEach(async () => {
  h = await createHarness();
});

afterEach(async () => {
  await cleanupHarness(h);
});

describe("idempotency", () => {
  it("running twice produces byte-identical rollup rows", async () => {
    await insertDef(h, { key: "evt", aggregation: "count", eventType: "*" });
    await insertDef(h, { key: "rev", aggregation: "sum", eventType: "*", valuePath: "$.value_pence" });
    await insertDef(h, { key: "avg_amt", aggregation: "avg", eventType: "payment.captured", valuePath: "$.data.amount_pence" });

    await insertEvent(h, { type: "booking.created", occurredAt: `${DAY}:00:00Z`, valuePence: 5000 });
    await insertEvent(h, { type: "payment.captured", occurredAt: `${DAY}:05:00Z`, data: { amount_pence: 250 } });
    await insertEvent(h, { type: "payment.captured", occurredAt: `${DAY}:10:00Z`, data: { amount_pence: 750 } });

    await runRollups(db, { projectId: h.projectId });
    const first = await readRollups(h);
    await runRollups(db, { projectId: h.projectId });
    const second = await readRollups(h);

    expect(second).toEqual(first);
    // sanity: the run actually wrote rows across all four periods
    expect(new Set(first.map((r) => r.period))).toEqual(
      new Set(["hour", "day", "week", "month"]),
    );
  });
});

describe("late-event self-heal", () => {
  it("recomputes an old bucket when a late event arrives", async () => {
    await insertDef(h, { key: "bookings", aggregation: "count", eventType: "booking.created" });

    await insertEvent(h, { type: "booking.created", occurredAt: `${DAY}:00:00Z` });
    await insertEvent(h, { type: "booking.created", occurredAt: `${DAY}:01:00Z` });
    await insertEvent(h, { type: "booking.created", occurredAt: `${DAY}:02:00Z` });
    await runRollups(db, { projectId: h.projectId });

    const before = (await readRollups(h, "day")).find((r) => r.metricKey === "bookings");
    expect(before?.value).toBe(3);

    // a late event with an OLD occurred_at but a fresh received_at (now)
    await insertEvent(h, {
      type: "booking.created",
      occurredAt: `${DAY}:03:00Z`,
      receivedAt: new Date(),
    });
    await runRollups(db, { projectId: h.projectId });

    const after = (await readRollups(h, "day")).find((r) => r.metricKey === "bookings");
    expect(after?.value).toBe(4);
  });
});

describe("watermark", () => {
  it("advances to ~now after an incremental run", async () => {
    await insertDef(h, { key: "evt", aggregation: "count", eventType: "*" });
    await insertEvent(h, { type: "x", occurredAt: `${DAY}:00:00Z` });

    expect(await readWatermark(h)).toBeNull();
    await runIncrementalRollupForProject(db, h.orgId, h.projectId);

    const wm = await readWatermark(h);
    expect(wm).not.toBeNull();
    const age = Date.now() - wm!.getTime();
    expect(age).toBeGreaterThanOrEqual(0);
    expect(age).toBeLessThan(60_000);
  });
});

describe("force recompute", () => {
  it("ignores the watermark and rebuilds rollups", async () => {
    await insertDef(h, { key: "evt", aggregation: "count", eventType: "*" });
    await insertEvent(h, { type: "x", occurredAt: `${DAY}:00:00Z` });
    await insertEvent(h, { type: "x", occurredAt: `${DAY}:05:00Z` });

    await runRollups(db, { projectId: h.projectId });
    expect((await readRollups(h)).length).toBeGreaterThan(0);

    // wipe rollups; incremental must NOT rebuild them (watermark is current)
    await db.delete(metricRollups).where(eq(metricRollups.projectId, h.projectId));
    await runRollups(db, { projectId: h.projectId });
    expect(await readRollups(h)).toHaveLength(0);

    // force ignores the watermark and rebuilds from raw events
    await runRollups(db, { projectId: h.projectId, force: true });
    const rebuilt = await readRollups(h, "day");
    expect(rebuilt.find((r) => r.metricKey === "evt")?.value).toBe(2);
  });
});
