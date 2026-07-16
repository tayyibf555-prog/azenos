import { randomUUID } from "node:crypto";
import {
  clients,
  db,
  industries,
  metricRollups,
  organizations,
  projects,
} from "@azen/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildAgencyMonthlyPack } from "../src/datapack/agency-monthly";
import type { MonthlyClient } from "../src/datapack/agency-monthly";

/**
 * §P8-BENCH — computeMonthlyBenchmarks coverage (docs/phase8/CONTRACTS.md).
 *
 * The datapack hand-duplicates the anonymity floor + linear-interpolation
 * percentile + per-client aggregation of the web lib (apps/web/lib/server/
 * benchmarks.ts) in raw SQL, and the contract says the two are "kept in
 * lock-step". Nothing exercised the datapack copy — monthly.test.ts never sets
 * an industry, so every client.benchmark was silently null and unasserted. This
 * builds a real throwaway org with hand-placed rollups and pins:
 *   - percentile median + per-client value + standing across ≥3 clients,
 *   - the ≥3-distinct-client anonymity floor (a 2-client industry → null),
 *   - the ZERO-SIGNAL GATE, which must match the web lib's `p75 <= 0` rule (a
 *     metric nonzero only for the single top of ≥5 clients has p75 = 0, so the
 *     zero-value peers must NOT see that bar — the bug this test guards was the
 *     datapack gating on max > 0 instead, surfacing a bar the report hid).
 *
 * Throwaway-org hygiene (ground rules): random ids, full teardown, DEMO_ORG_ID
 * never touched.
 */

const ORG_ID = randomUUID();
const DENTAL_ID = randomUUID(); // 5 clients — clears the floor
const CLINIC_ID = randomUUID(); // 2 clients — below the floor

let monthStartUTC: Date;

// Dental clients, ascending revenue (pence). minutesSaved is nonzero for the TOP
// client only, so its p75 = 0 across the 5-client sample — the zero-signal case.
const DENTAL = [
  { rev: 100, min: 0 },
  { rev: 200, min: 0 },
  { rev: 300, min: 0 },
  { rev: 400, min: 0 },
  { rev: 500, min: 600 },
].map((v) => ({ ...v, clientId: randomUUID(), projectId: randomUUID() }));

const CLINIC = [
  { rev: 1000, clientId: randomUUID(), projectId: randomUUID() },
  { rev: 2000, clientId: randomUUID(), projectId: randomUUID() },
];

async function addClientWithProject(
  clientId: string,
  projectId: string,
  industryId: string,
  name: string,
): Promise<void> {
  await db.insert(clients).values({
    id: clientId,
    orgId: ORG_ID,
    name,
    status: "active",
    industryId,
  });
  await db.insert(projects).values({
    id: projectId,
    orgId: ORG_ID,
    clientId,
    name: `${name} project`,
    slug: `bench-test-${randomUUID()}`,
    type: "automation",
    stack: "custom_code",
    status: "live",
    health: "green",
  });
}

async function addRollup(
  projectId: string,
  metricKey: string,
  value: number,
): Promise<void> {
  await db.insert(metricRollups).values({
    orgId: ORG_ID,
    projectId,
    metricKey,
    period: "day",
    periodStart: new Date("2026-05-15T12:00:00Z"),
    value,
    sampleCount: Math.max(1, Math.round(value)),
  });
}

beforeAll(async () => {
  await db.insert(organizations).values({ id: ORG_ID, name: "Bench Test Org" });
  await db.insert(industries).values([
    { id: DENTAL_ID, orgId: ORG_ID, slug: `dental-${randomUUID()}`, name: "Dental" },
    { id: CLINIC_ID, orgId: ORG_ID, slug: `clinic-${randomUUID()}`, name: "Clinic" },
  ]);

  for (const [i, c] of DENTAL.entries()) {
    await addClientWithProject(c.clientId, c.projectId, DENTAL_ID, `Dental ${i + 1}`);
    await addRollup(c.projectId, "revenue_attributed", c.rev);
    if (c.min > 0) await addRollup(c.projectId, "minutes_saved", c.min);
  }
  for (const [i, c] of CLINIC.entries()) {
    await addClientWithProject(c.clientId, c.projectId, CLINIC_ID, `Clinic ${i + 1}`);
    await addRollup(c.projectId, "revenue_attributed", c.rev);
  }

  // The exact UTC instant of London 2026-05-01 (mirrors resolveMonthStartUTC).
  const rows = (await db.$client`
    select to_char(
      ((('2026-05-01'::date)::timestamp at time zone 'Europe/London') at time zone 'UTC'),
      'YYYY-MM-DD"T"HH24:MI:SS"Z"'
    ) as iso
  `) as unknown as { iso: string }[];
  monthStartUTC = new Date(rows[0]!.iso);
});

afterAll(async () => {
  const c = db.$client;
  await c`delete from metric_rollups where org_id = ${ORG_ID}::uuid`;
  await c`delete from projects where org_id = ${ORG_ID}::uuid`;
  await c`delete from clients where org_id = ${ORG_ID}::uuid`;
  await c`delete from industries where org_id = ${ORG_ID}::uuid`;
  await c`delete from organizations where id = ${ORG_ID}::uuid`;
});

function benchmarkFor(pack: { clients: MonthlyClient[] }, clientId: string) {
  return pack.clients.find((c) => c.clientId === clientId)?.benchmark ?? null;
}

describe("computeMonthlyBenchmarks — percentile, floor, zero-signal gate", () => {
  it("surfaces an industry benchmark with the p50 median + per-client standing", async () => {
    const pack = await buildAgencyMonthlyPack(db, ORG_ID, monthStartUTC);

    // Lowest-revenue Dental client (100) vs the 5-client median (300).
    const low = benchmarkFor(pack, DENTAL[0]!.clientId);
    expect(low).not.toBeNull();
    expect(low!.industryName).toBe("Dental");
    expect(low!.sampleClients).toBe(5); // cleared the ≥3 floor
    const lowRev = low!.metrics.find((m) => m.key === "revenue_attributed");
    expect(lowRev).toBeDefined();
    expect(lowRev!.clientValue).toBe(100);
    expect(lowRev!.median).toBe(300); // percentileAt([100..500], 0.5)
    expect(lowRev!.standing).toBe("behind");

    // Top client (500) is ahead of the same median.
    const top = benchmarkFor(pack, DENTAL[4]!.clientId);
    const topRev = top!.metrics.find((m) => m.key === "revenue_attributed");
    expect(topRev!.clientValue).toBe(500);
    expect(topRev!.standing).toBe("ahead");
  });

  it("zero-signal gate matches the web lib: p75<=0 hides the bar for zero peers", async () => {
    const pack = await buildAgencyMonthlyPack(db, ORG_ID, monthStartUTC);

    // minutes_saved is nonzero only for the top client, so p75 = 0 across the
    // 5-client sample. A zero-value peer must NOT get a minutes_saved bar — the
    // OLD max>0 gate would have shown one, diverging from the shared report.
    const lowMetrics = benchmarkFor(pack, DENTAL[0]!.clientId)!.metrics;
    expect(lowMetrics.some((m) => m.key === "minutes_saved")).toBe(false);
    expect(lowMetrics.some((m) => m.key === "revenue_attributed")).toBe(true);

    // The single nonzero (top) client keeps its own minutes_saved bar (600m → 10h).
    const topMetrics = benchmarkFor(pack, DENTAL[4]!.clientId)!.metrics;
    const topMin = topMetrics.find((m) => m.key === "minutes_saved");
    expect(topMin).toBeDefined();
    expect(topMin!.clientValue).toBe(10);
  });

  it("honours the anonymity floor: a 2-client industry gets no benchmark", async () => {
    const pack = await buildAgencyMonthlyPack(db, ORG_ID, monthStartUTC);
    expect(benchmarkFor(pack, CLINIC[0]!.clientId)).toBeNull();
    expect(benchmarkFor(pack, CLINIC[1]!.clientId)).toBeNull();
  });
});
