import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, and } from "drizzle-orm";
import { closeDb, db, metricRollups } from "@azen/db";
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

import { GET, POST } from "../../app/api/projects/[projectId]/metrics/route";
import { DELETE } from "../../app/api/projects/[projectId]/metrics/[key]/route";
import { GET as SERIES } from "../../app/api/projects/[projectId]/metrics/series/route";

let projectId: string;

beforeAll(async () => {
  await createOrg(TEST_ORG_ID);
  const clientId = await createClient(TEST_ORG_ID);
  projectId = await createProject(TEST_ORG_ID, clientId);
  // one org-level global so isCustom=false is exercised
  await insertDef(TEST_ORG_ID, projectId, {
    key: "conversations",
    name: "Conversations",
    aggregation: "count",
    eventType: "llm.conversation",
    isKpi: true,
    sort: 10,
  });
  // events the custom metric will roll up when created
  for (let i = 0; i < 3; i++)
    await insertEvent(TEST_ORG_ID, projectId, { type: "call.completed", occurredAt: noonOnDaysAgo(1) });
});

afterAll(async () => {
  await cleanupOrg(TEST_ORG_ID);
  await closeDb();
});

const ctx = () => ({ params: Promise.resolve({ projectId }) });
const keyCtx = (key: string) => ({ params: Promise.resolve({ projectId, key }) });
const postJson = (body: unknown) =>
  POST(new Request("http://t/api", { method: "POST", body: JSON.stringify(body) }), ctx());

interface DefView {
  key: string;
  isCustom: boolean;
  isDerived: boolean;
}

describe("metrics CRUD", () => {
  it("GET lists effective defs plus the three derived virtual keys", async () => {
    const res = await GET(new Request("http://t/api"), ctx());
    const body = (await res.json()) as { definitions: DefView[] };
    const byKey = new Map(body.definitions.map((d) => [d.key, d]));

    expect(byKey.get("conversations")).toMatchObject({ isCustom: false, isDerived: false });
    for (const dk of ["agent_success_rate", "escalation_rate", "no_show_rate"]) {
      expect(byKey.get(dk)).toMatchObject({ isDerived: true, isCustom: false });
    }
  });

  it("POST creates a custom metric and recompute populates its rollups", async () => {
    const res = await postJson({
      key: "vip_calls",
      name: "VIP calls",
      unit: "count",
      aggregation: "count",
      eventType: "call.completed",
      isKpi: true,
    });
    expect(res.status).toBe(201);
    const { definition } = (await res.json()) as { definition: DefView };
    expect(definition).toMatchObject({ key: "vip_calls", isCustom: true, isDerived: false });

    // the create-time recompute rolled up the 3 call.completed events
    const day = londonDateStr(1);
    const sres = await SERIES(
      new Request(`http://t/api?keys=vip_calls&from=${day}&to=${day}`),
      ctx(),
    );
    const sbody = (await sres.json()) as {
      series: Record<string, { value: number }[]>;
    };
    expect(sbody.series.vip_calls?.map((p) => p.value)).toEqual([3]);
  });

  it("POST a duplicate project key → 409", async () => {
    const res = await postJson({
      key: "vip_calls",
      name: "Dupe",
      unit: "count",
      aggregation: "count",
      eventType: "call.completed",
    });
    expect(res.status).toBe(409);
  });

  it("POST an ungrammatical definition → 400", async () => {
    const res = await postJson({
      key: "bad_sum",
      name: "Bad",
      unit: "count",
      aggregation: "sum",
      eventType: "call.completed",
    });
    expect(res.status).toBe(400);
  });

  it("DELETE removes a custom def and its rollups", async () => {
    const res = await DELETE(new Request("http://t/api", { method: "DELETE" }), keyCtx("vip_calls"));
    expect(res.status).toBe(200);
    const rows = await db
      .select({ k: metricRollups.metricKey })
      .from(metricRollups)
      .where(and(eq(metricRollups.projectId, projectId), eq(metricRollups.metricKey, "vip_calls")));
    expect(rows).toHaveLength(0);
  });

  it("DELETE a global (project_id null) or unknown key → 404", async () => {
    const globalRes = await DELETE(new Request("http://t/api", { method: "DELETE" }), keyCtx("conversations"));
    expect(globalRes.status).toBe(404);
    const missingRes = await DELETE(new Request("http://t/api", { method: "DELETE" }), keyCtx("nope_nope"));
    expect(missingRes.status).toBe(404);
  });
});
