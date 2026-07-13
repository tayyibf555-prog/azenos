import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeDb } from "@azen/db";
import {
  cleanupOrg,
  createOrg,
  createTestClient,
  createTestKey,
  createTestProject,
  insertTestEvent,
} from "./helpers";

const TEST_ORG_ID = vi.hoisted(() => crypto.randomUUID());

vi.mock("../../lib/server/org", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../lib/server/org")>();
  return { ...mod, requireOrgId: async () => TEST_ORG_ID };
});

import { GET } from "../../app/api/projects/route";

let clientId: string;
let projectId: string;
let publicKey: string;
const lastEventAt = new Date();
const olderEventAt = new Date(Date.now() - 3 * 86_400_000);

beforeAll(async () => {
  await createOrg(TEST_ORG_ID);
  clientId = await createTestClient(TEST_ORG_ID, { name: "List Client" });
  projectId = await createTestProject(TEST_ORG_ID, clientId, {
    name: "List Project",
    status: "live",
  });
  ({ publicKey } = await createTestKey(TEST_ORG_ID, projectId));
  await insertTestEvent(TEST_ORG_ID, projectId, { occurredAt: olderEventAt });
  await insertTestEvent(TEST_ORG_ID, projectId, { occurredAt: lastEventAt });
});

afterAll(async () => {
  await cleanupOrg(TEST_ORG_ID);
  await closeDb();
});

describe("GET /api/projects", () => {
  it("returns the contracted shape with correct lastEventAt and eventsToday", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      projects: Record<string, unknown>[];
    };

    // org scoping: only the throwaway org's single project, never demo rows
    expect(body.projects).toHaveLength(1);
    const row = body.projects[0];
    if (!row) throw new Error("project row missing");

    expect(Object.keys(row).sort()).toEqual([
      "client",
      "eventsToday",
      "health",
      "id",
      "lastEventAt",
      "name",
      "publicKey",
      "retainerPenceMonthly",
      "slug",
      "stack",
      "status",
      "type",
    ]);
    expect(row).toMatchObject({
      id: projectId,
      name: "List Project",
      status: "live",
      health: "green",
      type: "automation",
      stack: "custom_code",
      retainerPenceMonthly: 0,
      client: { id: clientId, name: "List Client" },
      publicKey,
      // max(occurred_at) of the two events — the recent one, ISO-serialized
      lastEventAt: lastEventAt.toISOString(),
      // only the event occurred today (London) counts; the 3-day-old one not
      eventsToday: 1,
    });
  });

  it("never leaks key secret material", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain("secretHash");
    expect(text).not.toContain("secretCiphertext");
    expect(text).not.toContain("azn_sk_");
  });
});
