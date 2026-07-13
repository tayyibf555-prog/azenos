import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agentRuns, db, organizations, projects } from "@azen/db";
import { eq } from "drizzle-orm";
import {
  cleanupIntakeHarness,
  createIntakeHarness,
  insertAgentRun,
  type IntakeHarness,
} from "./helpers";

const h = vi.hoisted(() => ({ orgId: { value: "" } }));

vi.mock("../../lib/server/org", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/server/org")>();
  return { ...actual, requireOrgId: async () => h.orgId.value };
});

import { POST as attributePOST } from "../../app/api/projects/intake/attribute/route";

let harness: IntakeHarness;
let otherOrgId: string;
let project2Id: string;

beforeAll(async () => {
  harness = await createIntakeHarness();
  h.orgId.value = harness.orgId;

  // A second throwaway org proves the org scoping (never the demo org).
  otherOrgId = randomUUID();
  await db.insert(organizations).values({
    id: otherOrgId,
    name: `Attr Other ${otherOrgId.slice(0, 8)}`,
  });

  // A second project in the harness org for "already attributed" rows.
  project2Id = randomUUID();
  await db.insert(projects).values({
    id: project2Id,
    orgId: harness.orgId,
    clientId: harness.clientId,
    name: "Second Project",
    slug: `intake-test-${randomUUID()}`,
    type: "automation",
    stack: "custom_code",
  });
});

afterAll(async () => {
  await db.delete(agentRuns).where(eq(agentRuns.orgId, otherOrgId));
  await db.delete(organizations).where(eq(organizations.id, otherOrgId));
  await cleanupIntakeHarness(harness); // also removes project2 + harness runs
});

function attributeReq(body: unknown): Request {
  return new Request("http://test.local/api/projects/intake/attribute", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function getRun(id: string) {
  const [row] = await db.select().from(agentRuns).where(eq(agentRuns.id, id));
  return row;
}

describe("POST /api/projects/intake/attribute", () => {
  it("attributes un-attributed intake runs to the project and its client", async () => {
    const a = await insertAgentRun(harness.orgId);
    const b = await insertAgentRun(harness.orgId);

    const res = await attributePOST(
      attributeReq({ runIds: [a, b], projectId: harness.projectId }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ updated: 2 });

    for (const id of [a, b]) {
      const row = await getRun(id);
      expect(row!.projectId).toBe(harness.projectId);
      expect(row!.clientId).toBe(harness.clientId);
    }
  });

  it("leaves wrong-kind, already-attributed and cross-org rows untouched", async () => {
    const wrongKind = await insertAgentRun(harness.orgId, { agent: "daily_brief" });
    const already = await insertAgentRun(harness.orgId, {
      projectId: project2Id,
      clientId: harness.clientId,
    });
    const crossOrg = await insertAgentRun(otherOrgId);

    const res = await attributePOST(
      attributeReq({
        runIds: [wrongKind, already, crossOrg],
        projectId: harness.projectId,
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ updated: 0 });

    expect((await getRun(wrongKind))!.projectId).toBeNull();
    expect((await getRun(already))!.projectId).toBe(project2Id);
    const cross = await getRun(crossOrg);
    expect(cross!.projectId).toBeNull();
    expect(cross!.clientId).toBeNull();
  });

  it("404s a project that is not in the org", async () => {
    const runId = await insertAgentRun(harness.orgId);
    const res = await attributePOST(
      attributeReq({ runIds: [runId], projectId: randomUUID() }),
    );
    expect(res.status).toBe(404);
    expect((await getRun(runId))!.projectId).toBeNull();
  });

  it("400s invalid bodies", async () => {
    const empty = await attributePOST(
      attributeReq({ runIds: [], projectId: harness.projectId }),
    );
    expect(empty.status).toBe(400);

    const notUuid = await attributePOST(
      attributeReq({ runIds: ["not-a-uuid"], projectId: harness.projectId }),
    );
    expect(notUuid.status).toBe(400);
  });
});
