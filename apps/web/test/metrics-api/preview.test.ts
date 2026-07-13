import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, db, metricRollups } from "@azen/db";
import {
  cleanupOrg,
  createClient,
  createOrg,
  createProject,
  insertEvent,
  noonOnDaysAgo,
} from "./helpers";

const TEST_ORG_ID = vi.hoisted(() => crypto.randomUUID());

vi.mock("../../lib/server/org", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../lib/server/org")>();
  return { ...mod, requireOrgId: async () => TEST_ORG_ID };
});

import { POST } from "../../app/api/projects/[projectId]/metrics/preview/route";

let projectId: string;

beforeAll(async () => {
  await createOrg(TEST_ORG_ID);
  const clientId = await createClient(TEST_ORG_ID);
  projectId = await createProject(TEST_ORG_ID, clientId);

  // 3 payment.captured events: d2 has 3000; d1 has 1000 (noon) then 2000 (13:00)
  await insertEvent(TEST_ORG_ID, projectId, {
    type: "payment.captured",
    occurredAt: noonOnDaysAgo(2),
    data: { amount_pence: 3000 },
  });
  await insertEvent(TEST_ORG_ID, projectId, {
    type: "payment.captured",
    occurredAt: noonOnDaysAgo(1),
    data: { amount_pence: 1000 },
  });
  await insertEvent(TEST_ORG_ID, projectId, {
    type: "payment.captured",
    occurredAt: new Date(noonOnDaysAgo(1).getTime() + 3_600_000), // +1h
    data: { amount_pence: 2000 },
  });
});

afterAll(async () => {
  await cleanupOrg(TEST_ORG_ID);
  await closeDb();
});

function preview(body: unknown) {
  return POST(new Request("http://t/api", { method: "POST", body: JSON.stringify(body) }), {
    params: Promise.resolve({ projectId }),
  });
}

interface PreviewBody {
  series: { periodStart: string; value: number; sampleCount: number }[];
  total: number;
  sampleEvents: { id: string; occurredAt: string; extracted: number | null }[];
}

describe("POST /api/projects/[projectId]/metrics/preview", () => {
  it("counts matching events per day without writing rollups", async () => {
    const res = await preview({
      key: "payments",
      name: "Payments",
      unit: "count",
      aggregation: "count",
      eventType: "payment.captured",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PreviewBody;

    // d2 = 1, d1 = 2 (ascending)
    expect(body.series.map((p) => p.value)).toEqual([1, 2]);
    expect(body.series.map((p) => p.sampleCount)).toEqual([1, 2]);
    expect(body.total).toBe(3);
    expect(body.sampleEvents).toHaveLength(3);
    // count metric → nothing extracted
    expect(body.sampleEvents.every((s) => s.extracted === null)).toBe(true);

    // CRITICAL: preview is read-only — no rollups were written
    const rows = await db
      .select({ k: metricRollups.metricKey })
      .from(metricRollups)
      .where(eq(metricRollups.projectId, projectId));
    expect(rows).toHaveLength(0);
  });

  it("extracts $.data values for sum, most-recent-first samples", async () => {
    const res = await preview({
      key: "revenue",
      name: "Revenue",
      unit: "pence",
      aggregation: "sum",
      eventType: "payment.captured",
      valuePath: "$.data.amount_pence",
    });
    const body = (await res.json()) as PreviewBody;
    // d2 = 3000; d1 = 1000 + 2000 = 3000
    expect(body.series.map((p) => p.value)).toEqual([3000, 3000]);
    expect(body.total).toBe(6000);
    // most recent first: d1@13:00 (2000), d1@12:00 (1000), d2@12:00 (3000)
    expect(body.sampleEvents.map((s) => s.extracted)).toEqual([2000, 1000, 3000]);
  });

  it("computes weighted avg over the window", async () => {
    const res = await preview({
      key: "avg_ticket",
      name: "Avg ticket",
      unit: "pence",
      aggregation: "avg",
      eventType: "payment.captured",
      valuePath: "$.data.amount_pence",
    });
    const body = (await res.json()) as PreviewBody;
    // d2 avg = 3000; d1 avg = 1500; overall = (3000+1000+2000)/3 = 2000
    expect(body.series.map((p) => p.value)).toEqual([3000, 1500]);
    expect(body.total).toBe(2000);
  });

  it("400s on an ungrammatical definition (sum with no valuePath)", async () => {
    const res = await preview({
      key: "broken",
      name: "Broken",
      unit: "count",
      aggregation: "sum",
      eventType: "payment.captured",
    });
    expect(res.status).toBe(400);
  });
});
