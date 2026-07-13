import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeDb, db, runRollups } from "@azen/db";
import {
  cleanupOrg,
  createClient,
  createOrg,
  createProject,
  currentMonth,
  insertAgentRun,
  insertDef,
  insertEvent,
  noonOnMonthStart,
} from "./helpers";

const TEST_ORG_ID = vi.hoisted(() => crypto.randomUUID());

vi.mock("../../lib/server/org", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../lib/server/org")>();
  return { ...mod, requireOrgId: async () => TEST_ORG_ID };
});

import { GET as COSTS } from "../../app/api/costs/route";
import { GET as PROJECT_COSTS } from "../../app/api/projects/[projectId]/costs/route";

let clientA: string;
let clientB: string;
let projA: string;
let projB: string;

beforeAll(async () => {
  await createOrg(TEST_ORG_ID);
  clientA = await createClient(TEST_ORG_ID, { name: "Alpha" });
  clientB = await createClient(TEST_ORG_ID, { name: "Beta" });
  projA = await createProject(TEST_ORG_ID, clientA, { name: "A1" });
  projB = await createProject(TEST_ORG_ID, clientB, { name: "B1" });

  for (const p of [projA, projB]) {
    await insertDef(TEST_ORG_ID, p, {
      key: "tokens_cost_pence",
      aggregation: "sum",
      eventType: "agent.run.completed",
      valuePath: "$.data.cost_pence",
      unit: "pence",
      goodDirection: "down",
      sort: 75,
    });
  }

  const at = noonOnMonthStart();
  // client-system AI spend (events → tokens_cost_pence rollup): A=2000, B=3000
  await insertEvent(TEST_ORG_ID, projA, { type: "agent.run.completed", occurredAt: at, data: { cost_pence: 1500 } });
  await insertEvent(TEST_ORG_ID, projA, { type: "agent.run.completed", occurredAt: at, data: { cost_pence: 500 } });
  await insertEvent(TEST_ORG_ID, projB, { type: "agent.run.completed", occurredAt: at, data: { cost_pence: 3000 } });

  await runRollups(db, { orgId: TEST_ORG_ID, projectId: projA, force: true, forceWindowDays: 45 });
  await runRollups(db, { orgId: TEST_ORG_ID, projectId: projB, force: true, forceWindowDays: 45 });

  // OS-side agent spend: A=800, B=1200, org overhead (null project)=400
  await insertAgentRun(TEST_ORG_ID, { projectId: projA, clientId: clientA, costEstimatePence: 800, startedAt: at });
  await insertAgentRun(TEST_ORG_ID, { projectId: projB, clientId: clientB, costEstimatePence: 1200, startedAt: at });
  await insertAgentRun(TEST_ORG_ID, { projectId: null, clientId: null, costEstimatePence: 400, startedAt: at });
});

afterAll(async () => {
  await cleanupOrg(TEST_ORG_ID);
  await closeDb();
});

interface CostsBody {
  clients: {
    clientId: string;
    clientName: string;
    projects: { projectId: string; name: string; clientSystemAiPence: number; osAgentPence: number; totalPence: number }[];
    totals: { clientSystemAiPence: number; osAgentPence: number; totalPence: number };
  }[];
  orgOverheadPence: number;
}

describe("GET /api/costs", () => {
  it("groups both cost streams by client/project with org overhead", async () => {
    const res = await COSTS(new Request(`http://t/api?month=${currentMonth()}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as CostsBody;

    expect(body.orgOverheadPence).toBe(400);
    // sorted by client name: Alpha then Beta
    expect(body.clients.map((c) => c.clientName)).toEqual(["Alpha", "Beta"]);

    const alpha = body.clients.find((c) => c.clientId === clientA)!;
    expect(alpha.projects).toHaveLength(1);
    expect(alpha.projects[0]).toMatchObject({
      projectId: projA,
      clientSystemAiPence: 2000,
      osAgentPence: 800,
      totalPence: 2800,
    });
    expect(alpha.totals).toEqual({ clientSystemAiPence: 2000, osAgentPence: 800, totalPence: 2800 });

    const beta = body.clients.find((c) => c.clientId === clientB)!;
    expect(beta.projects[0]).toMatchObject({
      clientSystemAiPence: 3000,
      osAgentPence: 1200,
      totalPence: 4200,
    });
  });
});

describe("GET /api/projects/[projectId]/costs", () => {
  it("returns the single-project cost breakdown", async () => {
    const res = await PROJECT_COSTS(new Request(`http://t/api?month=${currentMonth()}`), {
      params: Promise.resolve({ projectId: projA }),
    });
    const body = (await res.json()) as Record<string, number | string>;
    expect(body).toMatchObject({
      projectId: projA,
      clientSystemAiPence: 2000,
      osAgentPence: 800,
      totalPence: 2800,
    });
  });

  it("404s for a project outside the org", async () => {
    const res = await PROJECT_COSTS(new Request("http://t/api"), {
      params: Promise.resolve({ projectId: crypto.randomUUID() }),
    });
    expect(res.status).toBe(404);
  });
});
