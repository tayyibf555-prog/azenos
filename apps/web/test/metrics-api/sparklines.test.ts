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

import { GET } from "../../app/api/projects/sparklines/route";

let withData: string;
let empty: string;

beforeAll(async () => {
  await createOrg(TEST_ORG_ID);
  const clientId = await createClient(TEST_ORG_ID);
  withData = await createProject(TEST_ORG_ID, clientId, { name: "Has KPI data" });
  empty = await createProject(TEST_ORG_ID, clientId, { name: "No data" });

  // org-level defs shared by both projects
  await insertDef(TEST_ORG_ID, withData, {
    key: "events_total",
    aggregation: "count",
    eventType: "*",
    isKpi: false,
    sort: 5,
  });
  await insertDef(TEST_ORG_ID, withData, {
    key: "conversations",
    name: "Conversations",
    aggregation: "count",
    eventType: "llm.conversation",
    isKpi: true,
    sort: 10,
  });

  // withData: 1 conversation on d2, 2 on d1
  await insertEvent(TEST_ORG_ID, withData, { type: "llm.conversation", occurredAt: noonOnDaysAgo(2) });
  for (let i = 0; i < 2; i++)
    await insertEvent(TEST_ORG_ID, withData, { type: "llm.conversation", occurredAt: noonOnDaysAgo(1) });

  await runRollups(db, { orgId: TEST_ORG_ID, projectId: withData, force: true, forceWindowDays: 14 });
  // `empty` has no events → no rollups
});

afterAll(async () => {
  await cleanupOrg(TEST_ORG_ID);
  await closeDb();
});

interface SparkBody {
  sparklines: Record<string, { metricKey: string; points: { day: string; value: number }[] }>;
}

describe("GET /api/projects/sparklines", () => {
  it("picks the primary KPI with data, falls back to events_total", async () => {
    const res = await GET(new Request("http://t/api?days=7"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as SparkBody;

    const a = body.sparklines[withData]!;
    expect(a.metricKey).toBe("conversations");
    expect(a.points.map((p) => p.value)).toEqual([1, 2]);
    expect(a.points.map((p) => p.day)).toEqual([londonDateStr(2), londonDateStr(1)]);

    const b = body.sparklines[empty]!;
    expect(b.metricKey).toBe("events_total");
    expect(b.points).toEqual([]);
  });
});
