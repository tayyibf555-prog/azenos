import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb } from "@azen/db";
import { coveragePlan, getTrackingPlan } from "../../lib/tracking-presets";
import { listEventTypesSeen } from "../../lib/server/queries";
import {
  cleanupOrg,
  createOrg,
  createTestClient,
  createTestProject,
  insertTestEvent,
} from "../api/helpers";

/**
 * coveragePlan() driven by the REAL "distinct event types seen for a
 * project" query (listEventTypesSeen — a group-by over `events` that is a
 * superset of `select distinct type from events where project_id=…`)
 * against hand-built events in a throwaway org. Never touches DEMO_ORG_ID.
 */

const TEST_ORG_ID = crypto.randomUUID();
let projectId: string;
let otherProjectId: string;

beforeAll(async () => {
  await createOrg(TEST_ORG_ID);
  const clientId = await createTestClient(TEST_ORG_ID);
  projectId = await createTestProject(TEST_ORG_ID, clientId, {
    name: "Tracking plan coverage project",
  });
  otherProjectId = await createTestProject(TEST_ORG_ID, clientId, {
    name: "Sibling project (must not leak into coverage)",
  });

  const now = new Date();
  // crm_setup required: lead.created, lead.stage_changed, lead.converted,
  // form.submitted — send only 2 of the 4, plus a recommended type, and a
  // duplicate of one required type (coverage is presence, not count).
  await insertTestEvent(TEST_ORG_ID, projectId, {
    type: "lead.created",
    occurredAt: now,
  });
  await insertTestEvent(TEST_ORG_ID, projectId, {
    type: "lead.created",
    occurredAt: now,
  });
  await insertTestEvent(TEST_ORG_ID, projectId, {
    type: "form.submitted",
    occurredAt: now,
  });
  await insertTestEvent(TEST_ORG_ID, projectId, {
    type: "email.sent",
    occurredAt: now,
  });
  // Planted on the sibling project only — must not count toward `projectId`.
  await insertTestEvent(TEST_ORG_ID, otherProjectId, {
    type: "lead.converted",
    occurredAt: now,
  });
});

afterAll(async () => {
  await cleanupOrg(TEST_ORG_ID);
  await closeDb();
});

describe("coveragePlan against real events (throwaway org)", () => {
  it("reflects exactly the types seen for this project, scoped by project_id", async () => {
    const seen = await listEventTypesSeen(TEST_ORG_ID, projectId);
    const presentTypes = new Set(seen.map((r) => r.type));
    expect(presentTypes).toEqual(
      new Set(["lead.created", "form.submitted", "email.sent"]),
    );

    const plan = getTrackingPlan("crm_setup");
    const result = coveragePlan(plan, presentTypes);

    expect(result.requiredTotal).toBe(4);
    expect(result.requiredPresent).toBe(2); // lead.created + form.submitted

    const byType = new Map(result.items.map((i) => [i.type, i]));
    expect(byType.get("lead.created")?.present).toBe(true);
    expect(byType.get("form.submitted")?.present).toBe(true);
    expect(byType.get("lead.stage_changed")?.present).toBe(false);
    expect(byType.get("lead.converted")?.present).toBe(false); // only on sibling
    expect(byType.get("email.sent")?.present).toBe(true); // recommended, present
    expect(byType.get("email.sent")?.required).toBe(false);
  });

  it("zero events on a project yields zero coverage (graceful, no crash)", async () => {
    const seen = await listEventTypesSeen(TEST_ORG_ID, otherProjectId);
    const relevantSeen = seen.filter((r) => r.type !== "lead.converted");
    const plan = getTrackingPlan("website");
    const result = coveragePlan(
      plan,
      new Set(relevantSeen.map((r) => r.type)),
    );
    expect(result.requiredTotal).toBe(2);
    expect(result.requiredPresent).toBe(0);
    expect(result.items.every((i) => !i.present)).toBe(true);
  });
});
