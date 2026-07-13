import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeDb, db, runRollups } from "@azen/db";
import {
  cleanupOrg,
  createClient,
  createOrg,
  createProject,
  insertDef,
  insertEvent,
  londonDateStr,
  noonOnDaysAgo,
} from "./helpers";

const TEST_ORG_ID = vi.hoisted(() => crypto.randomUUID());

vi.mock("../../lib/server/org", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../lib/server/org")>();
  return { ...mod, requireOrgId: async () => TEST_ORG_ID };
});

import { GET } from "../../app/api/projects/[projectId]/metrics/series/route";

let projectId: string;

beforeAll(async () => {
  await createOrg(TEST_ORG_ID);
  const clientId = await createClient(TEST_ORG_ID);
  projectId = await createProject(TEST_ORG_ID, clientId);

  // org-level defs (project_id null)
  await insertDef(TEST_ORG_ID, projectId, {
    key: "conversations",
    name: "Conversations",
    aggregation: "count",
    eventType: "llm.conversation",
    isKpi: true,
    sort: 10,
  });
  await insertDef(TEST_ORG_ID, projectId, {
    key: "agent_runs",
    aggregation: "count",
    eventType: "agent.run.completed",
    sort: 70,
  });
  await insertDef(TEST_ORG_ID, projectId, {
    key: "agent_runs_succeeded",
    aggregation: "count",
    eventType: "agent.run.completed",
    whereEquals: { "$.data.success": true },
    sort: 71,
  });

  // MAIN window = [d2, d1]. d2: 3 conversations, 2 succeeded + 1 failed run.
  for (let i = 0; i < 3; i++)
    await insertEvent(TEST_ORG_ID, projectId, { type: "llm.conversation", occurredAt: noonOnDaysAgo(2) });
  for (let i = 0; i < 2; i++)
    await insertEvent(TEST_ORG_ID, projectId, { type: "agent.run.completed", occurredAt: noonOnDaysAgo(2), data: { success: true } });
  await insertEvent(TEST_ORG_ID, projectId, { type: "agent.run.completed", occurredAt: noonOnDaysAgo(2), data: { success: false } });
  // d1: 5 conversations, 4 succeeded runs (4 runs total)
  for (let i = 0; i < 5; i++)
    await insertEvent(TEST_ORG_ID, projectId, { type: "llm.conversation", occurredAt: noonOnDaysAgo(1) });
  for (let i = 0; i < 4; i++)
    await insertEvent(TEST_ORG_ID, projectId, { type: "agent.run.completed", occurredAt: noonOnDaysAgo(1), data: { success: true } });

  // COMPARE window = [d4, d3]: conversations only (1 then 2).
  await insertEvent(TEST_ORG_ID, projectId, { type: "llm.conversation", occurredAt: noonOnDaysAgo(4) });
  for (let i = 0; i < 2; i++)
    await insertEvent(TEST_ORG_ID, projectId, { type: "llm.conversation", occurredAt: noonOnDaysAgo(3) });

  await runRollups(db, { orgId: TEST_ORG_ID, projectId, force: true, forceWindowDays: 40 });
});

afterAll(async () => {
  await cleanupOrg(TEST_ORG_ID);
  await closeDb();
});

function call(url: string) {
  return GET(new Request(url), { params: Promise.resolve({ projectId }) });
}

describe("GET /api/projects/[projectId]/metrics/series", () => {
  it("returns real + derived-ratio series with compare window and meta", async () => {
    const from = londonDateStr(2);
    const to = londonDateStr(1);
    const res = await call(
      `http://t/api?keys=conversations,agent_success_rate&period=day&from=${from}&to=${to}&compare=previous`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      series: Record<string, { periodStart: string; value: number | null }[]>;
      compare: Record<string, { periodStart: string; value: number | null }[]>;
      meta: Record<string, { name: string; unit: string; goodDirection: string; aggregation: string }>;
    };

    // conversations: 3 on d2 then 5 on d1 (ascending period_start)
    expect(body.series.conversations?.map((p) => p.value)).toEqual([3, 5]);
    // agent_success_rate = succeeded/runs*100: d2 = 2/3 = 66.67, d1 = 4/4 = 100
    expect(body.series.agent_success_rate?.map((p) => p.value)).toEqual([66.67, 100]);

    // compare (previous 2-day window d4,d3): conversations 1 then 2; derived empty (no runs)
    expect(body.compare.conversations?.map((p) => p.value)).toEqual([1, 2]);
    expect(body.compare.agent_success_rate).toEqual([]);

    // period_start strictly ascending
    const ps = body.series.conversations!.map((p) => p.periodStart);
    expect([...ps].sort()).toEqual(ps);

    expect(body.meta.conversations).toEqual({
      name: "Conversations",
      unit: "count",
      goodDirection: "up",
      aggregation: "count",
    });
    expect(body.meta.agent_success_rate).toEqual({
      name: "Agent success rate",
      unit: "percent",
      goodDirection: "up",
      aggregation: "rate",
    });
  });

  it("omits the compare block when compare=none and skips unknown keys", async () => {
    const from = londonDateStr(2);
    const to = londonDateStr(1);
    const res = await call(`http://t/api?keys=conversations,not_a_metric&from=${from}&to=${to}`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.compare).toBeUndefined();
    expect(Object.keys(body.series as object)).toEqual(["conversations"]);
    expect((body.meta as Record<string, unknown>).not_a_metric).toBeUndefined();
  });

  it("400s when no keys are provided", async () => {
    const res = await call("http://t/api?period=day");
    expect(res.status).toBe(400);
  });
});
