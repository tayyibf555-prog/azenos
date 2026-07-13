import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeDb } from "@azen/db";
import {
  cleanupOrg,
  createClient,
  createOrg,
  createProject,
  insertInsight,
} from "./helpers";

const TEST_ORG_ID = vi.hoisted(() => crypto.randomUUID());

vi.mock("../../lib/server/org", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../lib/server/org")>();
  return { ...mod, requireOrgId: async () => TEST_ORG_ID };
});

import { GET } from "../../app/api/overview/route";

beforeAll(async () => {
  await createOrg(TEST_ORG_ID);
  const clientId = await createClient(TEST_ORG_ID);
  // live: 2 green, 1 amber, 1 red — plus a building green that must NOT count
  await createProject(TEST_ORG_ID, clientId, { status: "live", health: "green" });
  await createProject(TEST_ORG_ID, clientId, { status: "live", health: "green" });
  await createProject(TEST_ORG_ID, clientId, { status: "live", health: "amber" });
  await createProject(TEST_ORG_ID, clientId, { status: "live", health: "red" });
  const building = await createProject(TEST_ORG_ID, clientId, { status: "building", health: "green" });
  // anomalies: 2 open (status new), 1 reviewed (excluded); 1 non-anomaly new (excluded)
  await insertInsight(TEST_ORG_ID, building, { kind: "anomaly", status: "new" });
  await insertInsight(TEST_ORG_ID, building, { kind: "anomaly", status: "new" });
  await insertInsight(TEST_ORG_ID, building, { kind: "anomaly", status: "reviewed" });
  await insertInsight(TEST_ORG_ID, building, { kind: "risk", status: "new" });
});

afterAll(async () => {
  await cleanupOrg(TEST_ORG_ID);
  await closeDb();
});

describe("GET /api/overview (M2 extension)", () => {
  it("adds healthSummary + openAnomalies alongside the base fields", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      eventsTotal: number;
      healthSummary: { green: number; amber: number; red: number };
      openAnomalies: number;
    };
    expect(body.healthSummary).toEqual({ green: 2, amber: 1, red: 1 });
    expect(body.openAnomalies).toBe(2);
    // base Phase 1 field preserved
    expect(typeof body.eventsTotal).toBe("number");
  });
});
