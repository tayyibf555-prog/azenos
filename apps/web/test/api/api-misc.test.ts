import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  bookings,
  closeDb,
  db,
  industries,
  subscriptions,
  webhookDeliveries,
} from "@azen/db";
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

import { GET as GET_OVERVIEW } from "../../app/api/overview/route";
import { GET as GET_CLIENTS, POST as POST_CLIENTS } from "../../app/api/clients/route";
import { PATCH } from "../../app/api/projects/[projectId]/route";
import { GET as GET_DELIVERIES } from "../../app/api/projects/[projectId]/deliveries/route";

const runTag = TEST_ORG_ID.slice(0, 8);
let clientId: string;
let projectId: string;
let keyId: string;

beforeAll(async () => {
  await createOrg(TEST_ORG_ID);
  clientId = await createTestClient(TEST_ORG_ID, { status: "active" });
  projectId = await createTestProject(TEST_ORG_ID, clientId, {
    status: "live",
  });
  ({ keyId } = await createTestKey(TEST_ORG_ID, projectId));
  const now = Date.now();
  for (let i = 0; i < 3; i++) {
    await insertTestEvent(TEST_ORG_ID, projectId, {
      occurredAt: new Date(now - i * 60_000),
    });
  }
  await db.insert(subscriptions).values({
    orgId: TEST_ORG_ID,
    clientId,
    amountPenceMonthly: 150_000,
    status: "active",
    startedAt: "2026-01-01",
  });
  // counted: client-end booking this month
  await db.insert(bookings).values({
    orgId: TEST_ORG_ID,
    clientId,
    projectId,
    source: "client_system",
    kind: "client_end_customer",
    startsAt: new Date(now),
  });
  // not counted: agency-kind booking, and a client-end one last month
  await db.insert(bookings).values({
    orgId: TEST_ORG_ID,
    clientId,
    source: "calendly",
    kind: "discovery",
    startsAt: new Date(now),
  });
  await db.insert(bookings).values({
    orgId: TEST_ORG_ID,
    clientId,
    projectId,
    source: "client_system",
    kind: "client_end_customer",
    startsAt: new Date(now - 40 * 86_400_000),
  });
});

afterAll(async () => {
  await cleanupOrg(TEST_ORG_ID);
  await closeDb();
});

describe("GET /api/overview", () => {
  it("aggregates MRR, statuses, events, and London-month bookings", async () => {
    const res = await GET_OVERVIEW();
    expect(res.status).toBe(200);
    // Core aggregates only — the Phase 2 healthSummary/openAnomalies extras
    // have dedicated coverage in test/metrics-api/overview.test.ts, so match
    // a subset here rather than couple this test to anomaly/health semantics.
    expect(await res.json()).toMatchObject({
      mrrPence: 150_000,
      activeClients: 1,
      liveProjects: 1,
      eventsTotal: 3,
      clientBookingsThisMonth: 1,
    });
  });
});

describe("/api/clients", () => {
  it("lists clients with industry slug and project counts", async () => {
    const res = await GET_CLIENTS();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { clients: Record<string, unknown>[] };
    expect(body.clients).toHaveLength(1);
    const row = body.clients[0];
    if (!row) throw new Error("client row missing");
    expect(Object.keys(row).sort()).toEqual([
      "createdAt",
      "id",
      "industrySlug",
      "name",
      "projectCount",
      "status",
    ]);
    expect(row).toMatchObject({
      id: clientId,
      status: "active",
      industrySlug: null,
      projectCount: 1,
    });
  });

  it("creates a client, auto-creating then reusing the industry by slug", async () => {
    const slug = `misc-ind-${runTag}`;
    const post = (name: string) =>
      POST_CLIENTS(
        new Request("http://test.local/api/clients", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name, industrySlug: slug, status: "lead" }),
        }),
      );

    const res1 = await post("Misc Client A");
    expect(res1.status).toBe(201);
    const c1 = (await res1.json()) as {
      client: { id: string; industryId: string; status: string };
    };
    expect(c1.client.status).toBe("lead");

    const [industry] = await db
      .select()
      .from(industries)
      .where(eq(industries.slug, slug));
    if (!industry) throw new Error("industry row missing");
    expect(industry.id).toBe(c1.client.industryId);
    expect(industry.name).toBe(
      `Misc Ind ${runTag.charAt(0).toUpperCase()}${runTag.slice(1)}`,
    );

    const res2 = await post("Misc Client B");
    const c2 = (await res2.json()) as { client: { industryId: string } };
    expect(c2.client.industryId).toBe(industry.id);
  });

  it("400s an invalid body with a terse issue summary", async () => {
    const res = await POST_CLIENTS(
      new Request("http://test.local/api/clients", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "active" }),
      }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("name");
  });
});

describe("PATCH /api/projects/[projectId]", () => {
  const patch = (id: string, body: unknown) =>
    PATCH(
      new Request(`http://test.local/api/projects/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ projectId: id }) },
    );

  it("updates the allowed fields and returns the project", async () => {
    const res = await patch(projectId, {
      status: "paused",
      health: "amber",
      retainerPenceMonthly: 99_900,
      retainerActive: true,
      description: "patched",
    });
    expect(res.status).toBe(200);
    const { project } = (await res.json()) as {
      project: Record<string, unknown>;
    };
    expect(project).toMatchObject({
      id: projectId,
      status: "paused",
      health: "amber",
      retainerPenceMonthly: 99_900,
      retainerActive: true,
      description: "patched",
    });
    // restore for other assertions
    await patch(projectId, { status: "live" });
  });

  it("400s an empty patch and 404s a foreign project", async () => {
    expect((await patch(projectId, {})).status).toBe(400);
    expect((await patch(crypto.randomUUID(), { status: "live" })).status).toBe(
      404,
    );
  });
});

describe("GET /api/projects/[projectId]/deliveries", () => {
  it("lists newest-first with hasRaw flag but never the raw payload", async () => {
    const now = Date.now();
    await db.insert(webhookDeliveries).values({
      orgId: TEST_ORG_ID,
      projectKeyId: keyId,
      status: "accepted",
      httpStatus: 200,
      latencyMs: 12,
      receivedAt: new Date(now - 2_000),
    });
    await db.insert(webhookDeliveries).values({
      orgId: TEST_ORG_ID,
      projectKeyId: keyId,
      status: "rejected",
      httpStatus: 400,
      latencyMs: 5,
      error: "invalid_json",
      raw: { leaked: "end-customer-data" },
      receivedAt: new Date(now - 1_000),
    });

    const res = await GET_DELIVERIES(
      new Request(`http://test.local/api/projects/${projectId}/deliveries`),
      { params: Promise.resolve({ projectId }) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      deliveries: Record<string, unknown>[];
    };
    expect(body.deliveries).toHaveLength(2);
    const [rejected, accepted] = body.deliveries;
    if (!rejected || !accepted) throw new Error("delivery rows missing");
    expect(Object.keys(rejected).sort()).toEqual([
      "error",
      "hasRaw",
      "httpStatus",
      "id",
      "latencyMs",
      "receivedAt",
      "status",
    ]);
    expect(rejected).toMatchObject({
      status: "rejected",
      httpStatus: 400,
      error: "invalid_json",
      hasRaw: true,
    });
    expect(accepted).toMatchObject({
      status: "accepted",
      httpStatus: 200,
      latencyMs: 12,
      hasRaw: false,
    });
    expect(JSON.stringify(body)).not.toContain("end-customer-data");
  });

  it("404s a projectId that is not in this org", async () => {
    const res = await GET_DELIVERIES(
      new Request("http://test.local/api/projects/x/deliveries"),
      { params: Promise.resolve({ projectId: crypto.randomUUID() }) },
    );
    expect(res.status).toBe(404);
  });
});
