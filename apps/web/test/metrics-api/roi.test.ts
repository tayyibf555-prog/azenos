import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeDb, db, runRollups } from "@azen/db";
import {
  cleanupOrg,
  createClient,
  createOrg,
  createProject,
  currentMonth,
  insertDef,
  insertEvent,
  noonOnMonthStart,
} from "./helpers";

const TEST_ORG_ID = vi.hoisted(() => crypto.randomUUID());

vi.mock("../../lib/server/org", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../lib/server/org")>();
  return { ...mod, requireOrgId: async () => TEST_ORG_ID };
});

import { GET } from "../../app/api/projects/[projectId]/roi/route";

let earningProject: string;
let flatProject: string;

beforeAll(async () => {
  await createOrg(TEST_ORG_ID);
  const clientId = await createClient(TEST_ORG_ID);

  // £500 retainer, £60/h time-value rate
  earningProject = await createProject(TEST_ORG_ID, clientId, {
    retainerPenceMonthly: 50_000,
    hourlyRatePence: 6_000,
  });
  // no retainer, no rate override, no run cost → zero denominator
  flatProject = await createProject(TEST_ORG_ID, clientId, {
    retainerPenceMonthly: 0,
  });

  await insertDef(TEST_ORG_ID, earningProject, {
    key: "revenue_attributed",
    aggregation: "sum",
    eventType: "*",
    valuePath: "$.value_pence",
    unit: "pence",
    sort: 50,
  });
  await insertDef(TEST_ORG_ID, earningProject, {
    key: "minutes_saved",
    aggregation: "sum",
    eventType: "*",
    valuePath: "$.minutes_saved",
    unit: "minutes",
    sort: 60,
  });
  await insertDef(TEST_ORG_ID, earningProject, {
    key: "tokens_cost_pence",
    aggregation: "sum",
    eventType: "agent.run.completed",
    valuePath: "$.data.cost_pence",
    unit: "pence",
    goodDirection: "down",
    sort: 75,
  });

  const at = noonOnMonthStart();
  // revenue 20000 + 10000 = 30000; minutes 30 + 30 = 60
  await insertEvent(TEST_ORG_ID, earningProject, { type: "custom.win", occurredAt: at, valuePence: 20_000, minutesSaved: 30 });
  await insertEvent(TEST_ORG_ID, earningProject, { type: "custom.win", occurredAt: at, valuePence: 10_000, minutesSaved: 30 });
  // run cost 5000 (value_pence null → not revenue)
  await insertEvent(TEST_ORG_ID, earningProject, { type: "agent.run.completed", occurredAt: at, data: { cost_pence: 5_000 } });

  // flatProject: revenue only, no retainer, no cost
  await insertEvent(TEST_ORG_ID, flatProject, { type: "custom.win", occurredAt: at, valuePence: 10_000 });

  await runRollups(db, { orgId: TEST_ORG_ID, projectId: earningProject, force: true, forceWindowDays: 45 });
  await runRollups(db, { orgId: TEST_ORG_ID, projectId: flatProject, force: true, forceWindowDays: 45 });
});

afterAll(async () => {
  await cleanupOrg(TEST_ORG_ID);
  await closeDb();
});

function call(projectId: string, url: string) {
  return GET(new Request(url), { params: Promise.resolve({ projectId }) });
}

describe("GET /api/projects/[projectId]/roi", () => {
  it("computes §10 ROI exactly", async () => {
    const res = await call(earningProject, `http://t/api?month=${currentMonth()}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, number | null | object>;

    // (revenue 30000 + timeValue 6000) / (retainer 50000 + runCost 5000)
    //  = 36000 / 55000 = 0.654545… → 0.65
    expect(body.revenueAttributedPence).toBe(30_000);
    expect(body.minutesSaved).toBe(60);
    expect(body.hourlyRatePence).toBe(6_000);
    expect(body.timeValuePence).toBe(6_000); // 60/60 * 6000
    expect(body.retainerPence).toBe(50_000);
    expect(body.runCostPence).toBe(5_000);
    expect(body.roiMultiple).toBe(0.65);
    expect(body.breakdown).toMatchObject({
      numeratorPence: 36_000,
      denominatorPence: 55_000,
    });
  });

  it("returns roiMultiple null when the denominator is zero", async () => {
    const res = await call(flatProject, `http://t/api?month=${currentMonth()}`);
    const body = (await res.json()) as Record<string, number | null>;
    expect(body.revenueAttributedPence).toBe(10_000);
    expect(body.retainerPence).toBe(0);
    expect(body.runCostPence).toBe(0);
    expect(body.roiMultiple).toBeNull();
  });

  it("404s for a project outside the org", async () => {
    const res = await call(crypto.randomUUID(), "http://t/api");
    expect(res.status).toBe(404);
  });
});
