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

import { GET } from "../../app/api/projects/[projectId]/insights/route";
import { PATCH } from "../../app/api/insights/[insightId]/route";

let projectId: string;
let newInsightId: string;

beforeAll(async () => {
  await createOrg(TEST_ORG_ID);
  const clientId = await createClient(TEST_ORG_ID);
  projectId = await createProject(TEST_ORG_ID, clientId);
  newInsightId = await insertInsight(TEST_ORG_ID, projectId, {
    kind: "anomaly",
    title: "Spike",
    status: "new",
    evidence: { metric_key: "conversations" },
  });
  await insertInsight(TEST_ORG_ID, projectId, { kind: "risk", title: "Old one", status: "reviewed" });
});

afterAll(async () => {
  await cleanupOrg(TEST_ORG_ID);
  await closeDb();
});

const listCtx = () => ({ params: Promise.resolve({ projectId }) });

interface ListBody {
  insights: {
    id: string;
    kind: string;
    title: string;
    bodyMd: string;
    confidence: string;
    status: string;
    evidence: Record<string, unknown>;
    createdAt: string;
  }[];
}

describe("insights list + patch", () => {
  it("lists all insights when no status filter is given", async () => {
    const res = await GET(new Request("http://t/api"), listCtx());
    const body = (await res.json()) as ListBody;
    expect(body.insights).toHaveLength(2);
    // shape check
    expect(Object.keys(body.insights[0]!).sort()).toEqual([
      "bodyMd",
      "confidence",
      "createdAt",
      "evidence",
      "id",
      "kind",
      "status",
      "title",
    ]);
  });

  it("filters by status=new", async () => {
    const res = await GET(new Request("http://t/api?status=new"), listCtx());
    const body = (await res.json()) as ListBody;
    expect(body.insights).toHaveLength(1);
    expect(body.insights[0]).toMatchObject({ id: newInsightId, kind: "anomaly", status: "new" });
  });

  it("PATCH updates status and drops it from the new list", async () => {
    const res = await PATCH(
      new Request("http://t/api", { method: "PATCH", body: JSON.stringify({ status: "dismissed" }) }),
      { params: Promise.resolve({ insightId: newInsightId }) },
    );
    expect(res.status).toBe(200);
    const { insight } = (await res.json()) as { insight: { status: string } };
    expect(insight.status).toBe("dismissed");

    const listed = (await (await GET(new Request("http://t/api?status=new"), listCtx())).json()) as ListBody;
    expect(listed.insights).toHaveLength(0);
  });

  it("PATCH 404s for an unknown id and 400s for a bad status", async () => {
    const notFound = await PATCH(
      new Request("http://t/api", { method: "PATCH", body: JSON.stringify({ status: "reviewed" }) }),
      { params: Promise.resolve({ insightId: crypto.randomUUID() }) },
    );
    expect(notFound.status).toBe(404);

    const bad = await PATCH(
      new Request("http://t/api", { method: "PATCH", body: JSON.stringify({ status: "actioned" }) }),
      { params: Promise.resolve({ insightId: newInsightId }) },
    );
    expect(bad.status).toBe(400);
  });
});
