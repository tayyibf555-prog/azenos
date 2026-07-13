import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeDb, db, events, insights } from "@azen/db";
import {
  cleanupOrg,
  createClient,
  createOrg,
  createProject,
} from "../metrics-api/helpers";

/**
 * Insights-tab evidence drill-down (§P6-SCOUT). The insights GET route is
 * extended to resolve an automation_opportunity's cited evidence.event_ids into
 * lightweight, org/project-scoped event rows (id, type, occurredAt) so the tab
 * can expand an opportunity to the events that justify it. We assert: cited ids
 * hydrate to the right events, foreign ids are dropped (org/project scoping),
 * and metric-only insights keep their prior shape (no evidenceEvents key).
 */

const TEST_ORG_ID = vi.hoisted(() => crypto.randomUUID());

vi.mock("../../lib/server/org", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../lib/server/org")>();
  return { ...mod, requireOrgId: async () => TEST_ORG_ID };
});

import { GET } from "../../app/api/projects/[projectId]/insights/route";

let projectId: string;
let evidenceIds: string[] = [];

async function insertEvent(
  orgId: string,
  pid: string,
  type: string,
): Promise<string> {
  const id = randomUUID();
  await db.insert(events).values({
    id,
    orgId,
    projectId: pid,
    type,
    source: "sdk",
    idempotencyKey: `test:${id}`,
    occurredAt: new Date(),
    receivedAt: new Date(),
    data: {},
    raw: {},
  });
  return id;
}

beforeAll(async () => {
  await createOrg(TEST_ORG_ID);
  const clientId = await createClient(TEST_ORG_ID);
  projectId = await createProject(TEST_ORG_ID, clientId);

  evidenceIds = [
    await insertEvent(TEST_ORG_ID, projectId, "agent.escalated_to_human"),
    await insertEvent(TEST_ORG_ID, projectId, "llm.conversation"),
  ];

  // Opportunity citing two real ids + one foreign (never-inserted) id.
  await db.insert(insights).values({
    orgId: TEST_ORG_ID,
    projectId,
    kind: "automation_opportunity",
    title: "Deflect pricing questions",
    bodyMd: "Automate quotes.",
    evidence: { event_ids: [...evidenceIds, randomUUID()], aggregates: {} },
    fingerprint: `scout:${projectId}:pricing-deflection`,
    confidence: "high",
    status: "new",
    createdBy: "agent",
  });

  // A metric-only insight that cites NO events (keeps its prior shape).
  await db.insert(insights).values({
    orgId: TEST_ORG_ID,
    projectId,
    kind: "anomaly",
    title: "Spike",
    bodyMd: "z-score spike.",
    evidence: { metric_key: "conversations" },
    confidence: "med",
    status: "new",
    createdBy: "agent",
  });
});

afterAll(async () => {
  await cleanupOrg(TEST_ORG_ID);
  await closeDb();
});

const ctx = () => ({ params: Promise.resolve({ projectId }) });

interface EvidenceEvent {
  id: string;
  type: string;
  occurredAt: string;
}
interface ListBody {
  insights: {
    kind: string;
    evidence: Record<string, unknown>;
    evidenceEvents?: EvidenceEvent[];
  }[];
}

describe("insights evidence drill-down", () => {
  it("resolves cited event ids to events and drops foreign ids", async () => {
    const res = await GET(new Request("http://t/api?status=new"), ctx());
    const body = (await res.json()) as ListBody;

    const opp = body.insights.find((i) => i.kind === "automation_opportunity")!;
    expect(opp.evidenceEvents).toBeDefined();
    // 3 ids cited, but only the 2 real org/project events hydrate.
    expect(opp.evidenceEvents!.map((e) => e.id).sort()).toEqual(
      [...evidenceIds].sort(),
    );
    const types = opp.evidenceEvents!.map((e) => e.type).sort();
    expect(types).toEqual(["agent.escalated_to_human", "llm.conversation"]);
  });

  it("does not attach evidenceEvents to metric-only insights", async () => {
    const res = await GET(new Request("http://t/api?status=new"), ctx());
    const body = (await res.json()) as ListBody;
    const anomaly = body.insights.find((i) => i.kind === "anomaly")!;
    expect(anomaly.evidenceEvents).toBeUndefined();
    expect("evidenceEvents" in anomaly).toBe(false);
  });
});
