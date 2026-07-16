import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeDb } from "@azen/db";
import { discoverMetrics } from "../../lib/server/metric-discovery";
import { cleanupOrg, createClient, createOrg, createProject, insertEvent } from "./helpers";

const TEST_ORG_ID = vi.hoisted(() => crypto.randomUUID());

vi.mock("../../lib/server/org", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../lib/server/org")>();
  return { ...mod, requireOrgId: async () => TEST_ORG_ID };
});

// Imported AFTER the mock so the route picks up the mocked org resolver.
import { GET, POST } from "../../app/api/projects/[projectId]/metrics/route";
import { GET as GET_DISCOVERY } from "../../app/api/projects/[projectId]/metrics/discovery/route";

let projectId: string;

beforeAll(async () => {
  await createOrg(TEST_ORG_ID);
  const clientId = await createClient(TEST_ORG_ID);
  projectId = await createProject(TEST_ORG_ID, clientId, { type: "chatbot" });
  for (let i = 0; i < 10; i++) {
    await insertEvent(TEST_ORG_ID, projectId, {
      type: "feedback.submitted",
      data: { kind: i < 3 ? "bug" : "praise", message: "hi" },
    });
  }
});

afterAll(async () => {
  await cleanupOrg(TEST_ORG_ID);
  await closeDb();
});

const ctx = () => ({ params: Promise.resolve({ projectId }) });

describe("one-click add reuses the EXISTING create API — no new write path", () => {
  it("a discovered template POSTs cleanly to /metrics and becomes enabled", async () => {
    const before = await discoverMetrics(TEST_ORG_ID, projectId);
    const template = before.available.find((m) => m.key === "feedback_volume");
    expect(template).toBeTruthy();

    const res = await POST(
      new Request("http://t/api", {
        method: "POST",
        body: JSON.stringify({
          key: template!.key,
          name: template!.name,
          description: template!.description,
          unit: template!.unit,
          aggregation: template!.aggregation,
          eventType: template!.eventType,
          valuePath: template!.valuePath,
          whereEquals: template!.whereEquals,
          goodDirection: template!.goodDirection,
          isKpi: template!.isKpi,
        }),
      }),
      ctx(),
    );
    expect(res.status).toBe(201);
    const { definition } = (await res.json()) as { definition: { key: string; isCustom: boolean } };
    expect(definition).toMatchObject({ key: "feedback_volume", isCustom: true });

    // GET /metrics now lists it as an ordinary custom definition.
    const listRes = await GET(new Request("http://t/api"), ctx());
    const { definitions } = (await listRes.json()) as { definitions: { key: string }[] };
    expect(definitions.some((d) => d.key === "feedback_volume")).toBe(true);

    // Discovery no longer offers it — it's enabled now (dedup by key).
    const after = await discoverMetrics(TEST_ORG_ID, projectId);
    expect(after.available.some((m) => m.key === "feedback_volume")).toBe(false);
    expect(after.enabled.some((d) => d.key === "feedback_volume")).toBe(true);
  });

  it("the discovery route answers 404 for a foreign/unknown project", async () => {
    const res = await GET_DISCOVERY(new Request("http://t/api"), {
      params: Promise.resolve({ projectId: crypto.randomUUID() }),
    });
    expect(res.status).toBe(404);
  });

  it("the discovery route serves the same shape discoverMetrics() returns", async () => {
    const res = await GET_DISCOVERY(new Request("http://t/api"), ctx());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { core: unknown[]; enabled: unknown[]; available: unknown[]; missing: unknown[] };
    expect(Array.isArray(body.available)).toBe(true);
    expect(Array.isArray(body.core)).toBe(true);
    expect(Array.isArray(body.enabled)).toBe(true);
    expect(Array.isArray(body.missing)).toBe(true);
  });
});
