import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { alertInstances, db } from "@azen/db";
import { eq } from "drizzle-orm";
import { mutateAlert } from "../../lib/server/health/alerts";
import { PATCH } from "../../app/api/health/alerts/[id]/route";
import {
  type HealthOrg,
  cleanupHealthOrg,
  createHealthOrg,
  createLiveProject,
} from "./helpers";

let org: HealthOrg | null = null;

afterEach(async () => {
  if (org) await cleanupHealthOrg(org);
  org = null;
});

async function seedAlert(o: HealthOrg, projectId: string): Promise<string> {
  const id = randomUUID();
  await db.insert(alertInstances).values({
    id,
    orgId: o.orgId,
    projectId,
    kind: "event_silence",
    severity: "critical",
    message: "No events",
    evidence: { source: "health", check: "freshness" },
  });
  return id;
}

describe("alert ack / resolve — org-scoped mutations", () => {
  it("acks then resolves an alert in the owning org", async () => {
    org = await createHealthOrg();
    const p = await createLiveProject(org);
    const id = await seedAlert(org, p);

    const acked = await mutateAlert(org.orgId, id, "ack");
    expect(acked?.ackedAt).not.toBeNull();
    expect(acked?.resolvedAt).toBeNull();

    const resolved = await mutateAlert(org.orgId, id, "resolve");
    expect(resolved?.resolvedAt).not.toBeNull();

    const [row] = await db
      .select({ ackedAt: alertInstances.ackedAt, resolvedAt: alertInstances.resolvedAt })
      .from(alertInstances)
      .where(eq(alertInstances.id, id));
    expect(row?.ackedAt).not.toBeNull();
    expect(row?.resolvedAt).not.toBeNull();
  });

  it("refuses a cross-org mutation (returns null → 404)", async () => {
    org = await createHealthOrg();
    const p = await createLiveProject(org);
    const id = await seedAlert(org, p);

    const foreignOrg = randomUUID();
    const res = await mutateAlert(foreignOrg, id, "resolve");
    expect(res).toBeNull();

    // untouched by the failed cross-org attempt
    const [row] = await db
      .select({ resolvedAt: alertInstances.resolvedAt })
      .from(alertInstances)
      .where(eq(alertInstances.id, id));
    expect(row?.resolvedAt).toBeNull();
  });

  it("ack on an already-resolved alert matches nothing", async () => {
    org = await createHealthOrg();
    const p = await createLiveProject(org);
    const id = await seedAlert(org, p);
    await mutateAlert(org.orgId, id, "resolve");

    const res = await mutateAlert(org.orgId, id, "ack");
    expect(res).toBeNull();
  });

  it("route rejects a non-uuid id with 404", async () => {
    const res = await PATCH(
      new Request("http://test.local/api/health/alerts/not-a-uuid", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "ack" }),
      }),
      { params: Promise.resolve({ id: "not-a-uuid" }) },
    );
    expect(res.status).toBe(404);
  });

  it("route rejects an invalid action with 400", async () => {
    const res = await PATCH(
      new Request(`http://test.local/api/health/alerts/${randomUUID()}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "nope" }),
      }),
      { params: Promise.resolve({ id: randomUUID() }) },
    );
    expect(res.status).toBe(400);
  });
});
