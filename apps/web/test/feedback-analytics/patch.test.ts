import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeDb, db, feedbackItems } from "@azen/db";
import { eq } from "drizzle-orm";
import {
  cleanupOrg,
  createClient,
  createOrg,
  createProject,
  noonOnDaysAgo,
} from "../metrics-api/helpers";
import { cleanupFeedbackAnalytics, insertFeedbackItem } from "./helpers";

/**
 * Triage board status transitions (docs/phase7/PLAN.md §B2): `PATCH { status }`
 * on /api/projects/[projectId]/feedback/[itemId]. Org + project scoped — a
 * cross-org OR cross-project item id must 404 without mutating anything.
 */

const ORG_A = vi.hoisted(() => crypto.randomUUID());
const ORG_B = vi.hoisted(() => crypto.randomUUID());
// requireOrgId is mocked to ORG_A by default; individual tests override via
// the module's mutable `activeOrg` to simulate a request from ORG_B.
const activeOrg = vi.hoisted(() => ({ id: "" }));

vi.mock("../../lib/server/org", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../lib/server/org")>();
  return { ...mod, requireOrgId: async () => activeOrg.id };
});

import { PATCH } from "../../app/api/projects/[projectId]/feedback/[itemId]/route";

let projectA: string;
// A SECOND project in the SAME org as projectA — this is what exercises same-org
// cross-project scoping (projectB below is in ORG_B and only exercises the
// cross-ORG guard).
let projectA2: string;
let projectB: string;
let itemA: string;

beforeAll(async () => {
  await createOrg(ORG_A);
  await createOrg(ORG_B);
  const clientA = await createClient(ORG_A);
  const clientB = await createClient(ORG_B);
  projectA = await createProject(ORG_A, clientA, { name: "Patch A" });
  projectA2 = await createProject(ORG_A, clientA, { name: "Patch A2" });
  projectB = await createProject(ORG_B, clientB, { name: "Patch B" });

  itemA = await insertFeedbackItem(ORG_A, projectA, {
    kind: "bug",
    status: "new",
    createdAt: noonOnDaysAgo(1),
  });
  activeOrg.id = ORG_A;
});

afterAll(async () => {
  await cleanupFeedbackAnalytics(ORG_A);
  await cleanupFeedbackAnalytics(ORG_B);
  await cleanupOrg(ORG_A);
  await cleanupOrg(ORG_B);
  await closeDb();
});

async function patchStatus(
  pid: string,
  itemId: string,
  status: string,
): Promise<Response> {
  return PATCH(
    new Request(`http://t/api`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status }),
    }),
    { params: Promise.resolve({ projectId: pid, itemId }) },
  );
}

async function statusOf(itemId: string): Promise<string> {
  const [row] = await db
    .select({ status: feedbackItems.status })
    .from(feedbackItems)
    .where(eq(feedbackItems.id, itemId));
  return row!.status;
}

describe("PATCH /api/projects/[projectId]/feedback/[itemId]", () => {
  it("walks new → seen → planned → done, persisting each transition", async () => {
    for (const status of ["seen", "planned", "done"] as const) {
      const res = await patchStatus(projectA, itemA, status);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { item: { status: string } };
      expect(body.item.status).toBe(status);
      expect(await statusOf(itemA)).toBe(status);
    }
  });

  it("rejects an invalid status with 400 and leaves the row unchanged", async () => {
    const before = await statusOf(itemA);
    const res = await patchStatus(projectA, itemA, "archived");
    expect(res.status).toBe(400);
    expect(await statusOf(itemA)).toBe(before);
  });

  it("404s an unknown item id", async () => {
    const res = await patchStatus(projectA, randomUUID(), "seen");
    expect(res.status).toBe(404);
  });

  it("404s an item id that belongs to a DIFFERENT project in the same org", async () => {
    // projectA2 is a real ORG_A project, so projectExists(ORG_A, projectA2)
    // PASSES — the 404 must come from the project_id predicate in
    // updateFeedbackItemStatus (itemA belongs to projectA, not projectA2). This
    // is the only test that would catch a dropped project_id scope.
    const before = await statusOf(itemA);
    const res = await patchStatus(projectA2, itemA, "seen");
    expect(res.status).toBe(404);
    expect(await statusOf(itemA)).toBe(before);
  });

  it("404s a request from a DIFFERENT org, even with the correct project+item id", async () => {
    const before = await statusOf(itemA);
    activeOrg.id = ORG_B;
    try {
      const res = await patchStatus(projectA, itemA, "seen");
      expect(res.status).toBe(404);
      expect(await statusOf(itemA)).toBe(before);
    } finally {
      activeOrg.id = ORG_A;
    }
  });
});
