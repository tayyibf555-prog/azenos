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
 * §13 London day boundary + the mandated DST transition tests. periodStart is
 * always the UTC instant of the Europe/London local midnight; the assertions
 * below are the exact instants Postgres produces (verified against the live
 * DB), so they pin DST-correctness.
 */

const HOUR = 3_600_000;
const dayStarts = (rows: { period: string; periodStart: string }[]): string[] =>
  rows.filter((r) => r.period === "day").map((r) => r.periodStart).sort();

let h: RollupHarness;

beforeEach(async () => {
  h = await createHarness();
  // a plain "count every event" definition — one day rollup per London day
  await insertDef(h, { key: "evt", aggregation: "count", eventType: "*" });
});

afterEach(async () => {
  await cleanupHarness(h);
});

describe("London day bucketing", () => {
  it("splits BST events across the 23:00Z day boundary", async () => {
    await insertEvent(h, { type: "x", occurredAt: "2026-07-11T22:30:00Z" });
    await insertEvent(h, { type: "x", occurredAt: "2026-07-11T23:30:00Z" });
    await runRollups(db, { projectId: h.projectId });

    const days = dayStarts(await readRollups(h, "day"));
    // 22:30Z → London day 2026-07-11 (starts 2026-07-10T23:00Z, BST);
    // 23:30Z → London day 2026-07-12 (starts 2026-07-11T23:00Z).
    expect(days).toEqual([
      "2026-07-10T23:00:00.000Z",
      "2026-07-11T23:00:00.000Z",
    ]);
  });
});

describe("DST spring forward (2026-03-29, 23-hour day)", () => {
  it("day periodStart is 2026-03-29T00:00Z and the day is 23h long", async () => {
    await insertEvent(h, { type: "x", occurredAt: "2026-03-29T00:00:00Z" });
    // 22:30Z is still inside the 23h London day (Postgres-correct: the day
    // spans [00:00Z, 23:00Z)). The contract's parenthetical "next day" is
    // inconsistent with its own "23h / starts 00:00Z" statement, which wins.
    await insertEvent(h, { type: "x", occurredAt: "2026-03-29T22:30:00Z" });
    // 23:00Z == 2026-03-30 00:00 London → the NEXT day.
    await insertEvent(h, { type: "x", occurredAt: "2026-03-29T23:00:00Z" });
    await runRollups(db, { projectId: h.projectId });

    const rows = (await readRollups(h, "day")).filter((r) => r.metricKey === "evt");
    const byStart = new Map(rows.map((r) => [r.periodStart, r.value]));

    expect(byStart.get("2026-03-29T00:00:00.000Z")).toBe(2); // 00:00Z + 22:30Z
    expect(byStart.get("2026-03-29T23:00:00.000Z")).toBe(1); // 23:00Z → next day
    // consecutive London day starts are exactly 23 hours apart
    const start = new Date("2026-03-29T00:00:00.000Z").getTime();
    const next = new Date("2026-03-29T23:00:00.000Z").getTime();
    expect(next - start).toBe(23 * HOUR);
  });
});

describe("DST fall back (2026-10-25, 25-hour day)", () => {
  it("day periodStart is 2026-10-24T23:00Z and the day is 25h long", async () => {
    await insertEvent(h, { type: "x", occurredAt: "2026-10-25T12:00:00Z" });
    // 23:30Z is still 2026-10-25 London (contract-correct).
    await insertEvent(h, { type: "x", occurredAt: "2026-10-25T23:30:00Z" });
    // 2026-10-26T00:00Z → the NEXT London day.
    await insertEvent(h, { type: "x", occurredAt: "2026-10-26T00:00:00Z" });
    await runRollups(db, { projectId: h.projectId });

    const rows = (await readRollups(h, "day")).filter((r) => r.metricKey === "evt");
    const byStart = new Map(rows.map((r) => [r.periodStart, r.value]));

    expect(byStart.get("2026-10-24T23:00:00.000Z")).toBe(2); // 12:00Z + 23:30Z
    expect(byStart.get("2026-10-26T00:00:00.000Z")).toBe(1); // next day
    const start = new Date("2026-10-24T23:00:00.000Z").getTime();
    const next = new Date("2026-10-26T00:00:00.000Z").getTime();
    expect(next - start).toBe(25 * HOUR);
  });
});
