import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  clients,
  closeDb,
  db,
  events,
  organizations,
  projects,
} from "@azen/db";

/**
 * P5-AGENTS-TAB — the agents API returns correct per-agent aggregates over
 * hand-built agent.heartbeat / agent.run.completed / agent.escalated_to_human
 * events. Every event is placed at a fixed instant inside an explicit
 * [from,to] London-day window so the numbers are deterministic regardless of
 * the wall clock; the demo org is never touched.
 */

const TEST_ORG_ID = vi.hoisted(() => crypto.randomUUID());

vi.mock("../../lib/server/org", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../lib/server/org")>();
  return { ...mod, requireOrgId: async () => TEST_ORG_ID };
});

import { GET as AGENTS } from "../../app/api/projects/[projectId]/agents/route";
import type { AgentsResponse } from "../../app/api/projects/[projectId]/agents/query";

// £60/h so time-value maths are round: round(minutes/60 * 6000).
const HOURLY = 6000;
// Noon UTC on 15 Mar 2026 — unambiguous inside the London day in GMT.
const IN_WINDOW = new Date("2026-03-15T12:00:00Z");
const OUT_OF_WINDOW = new Date("2026-01-01T12:00:00Z");
const FROM = "2026-03-01";
const TO = "2026-03-31";

let projId: string;
const OTHER_PROJ = randomUUID();

async function insertEvent(
  projectId: string,
  type: string,
  data: Record<string, unknown>,
  occurredAt: Date,
): Promise<void> {
  await db.insert(events).values({
    id: randomUUID(),
    orgId: TEST_ORG_ID,
    projectId,
    type,
    source: "sdk",
    idempotencyKey: `test:${randomUUID()}`,
    occurredAt,
    data,
    raw: data,
  });
}

async function hb(
  projectId: string,
  agentId: string,
  data: Record<string, unknown>,
  occurredAt: Date,
): Promise<void> {
  await insertEvent(projectId, "agent.heartbeat", { agent_id: agentId, ...data }, occurredAt);
}
async function run(
  agentId: string,
  data: Record<string, unknown>,
  occurredAt: Date = IN_WINDOW,
): Promise<void> {
  await insertEvent(projId, "agent.run.completed", { agent_id: agentId, ...data }, occurredAt);
}
async function esc(agentId: string, occurredAt: Date = IN_WINDOW): Promise<void> {
  await insertEvent(projId, "agent.escalated_to_human", { agent_id: agentId }, occurredAt);
}

beforeAll(async () => {
  await db.insert(organizations).values({ id: TEST_ORG_ID, name: "P5 Agents" });
  const clientId = randomUUID();
  await db.insert(clients).values({ id: clientId, orgId: TEST_ORG_ID, name: "Client", status: "active" });
  projId = randomUUID();
  await db.insert(projects).values({
    id: projId,
    orgId: TEST_ORG_ID,
    clientId,
    name: "Proj",
    slug: `p5-agents-${randomUUID()}`,
    type: "ai_agent",
    stack: "custom_code",
    status: "live",
    hourlyRatePence: HOURLY,
  });
  await db.insert(projects).values({
    id: OTHER_PROJ,
    orgId: TEST_ORG_ID,
    clientId,
    name: "Other",
    slug: `p5-agents-other-${randomUUID()}`,
    type: "ai_agent",
    stack: "custom_code",
    status: "live",
  });

  // ── agent-a: two heartbeats (latest = degraded, named), 3 runs, 2 escalations
  await hb(projId, "agent-a", { status: "ok" }, new Date("2026-03-15T10:00:00Z"));
  await hb(projId, "agent-a", { status: "degraded", name: "Billing Bot", version: "1.2.0" }, IN_WINDOW);
  await run("agent-a", { success: true, duration_ms: 1000, tokens_in: 100, tokens_out: 200, cost_pence: 50, minutes_saved: 10 });
  await run("agent-a", { success: true, duration_ms: 3000, tokens_in: 150, tokens_out: 250, cost_pence: 30, minutes_saved: 5 });
  await run("agent-a", { success: false, duration_ms: 2000, tokens_in: 50, tokens_out: 100, cost_pence: 20, minutes_saved: 0 });
  await esc("agent-a");
  await esc("agent-a");
  // out-of-window run for agent-a → must be excluded from every aggregate
  await run("agent-a", { success: true, duration_ms: 99, cost_pence: 9999, minutes_saved: 999 }, OUT_OF_WINDOW);

  // ── agent-b: heartbeat with no status (→ default "ok"), 1 run
  await hb(projId, "agent-b", { name: "FAQ Bot" }, IN_WINDOW);
  await run("agent-b", { success: true, duration_ms: 500, tokens_in: 10, tokens_out: 20, cost_pence: 5, minutes_saved: 2 });

  // ── agent-c: heartbeat only, no runs
  await hb(projId, "agent-c", { status: "down", name: "Idle Bot" }, IN_WINDOW);

  // ── noise that MUST be ignored ─────────────────────────────────────────────
  // orphan run + escalation with no heartbeat → agent never registers
  await run("orphan", { success: true, cost_pence: 1, minutes_saved: 1 });
  await esc("orphan");
  // heartbeat entirely outside the window → excluded from a March query
  await hb(projId, "ghost", { status: "ok" }, OUT_OF_WINDOW);
  // a heartbeat on a DIFFERENT project → excluded by project scoping
  await hb(OTHER_PROJ, "cross-proj", { status: "ok" }, IN_WINDOW);
}, 30_000);

afterAll(async () => {
  await db.delete(events).where(eq(events.orgId, TEST_ORG_ID));
  await db.delete(projects).where(eq(projects.orgId, TEST_ORG_ID));
  await db.delete(clients).where(eq(clients.orgId, TEST_ORG_ID));
  await db.delete(organizations).where(eq(organizations.id, TEST_ORG_ID));
  await closeDb();
});

async function fetchAgents(qs = `from=${FROM}&to=${TO}`): Promise<AgentsResponse> {
  const res = await AGENTS(new Request(`http://t/api/projects/${projId}/agents?${qs}`), {
    params: Promise.resolve({ projectId: projId }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as AgentsResponse;
}

describe("GET /api/projects/[projectId]/agents", () => {
  it("registers only agents with an in-window heartbeat on this project", async () => {
    const body = await fetchAgents();
    expect(body.agents.map((a) => a.agentId)).toEqual(["agent-a", "agent-b", "agent-c"]);
    expect(body.from).toBe(FROM);
    expect(body.to).toBe(TO);
    expect(body.hourlyRatePence).toBe(HOURLY);
  });

  it("computes agent-a aggregates from its 3 in-window runs (out-of-window run excluded)", async () => {
    const body = await fetchAgents();
    const a = body.agents.find((x) => x.agentId === "agent-a")!;
    // latest heartbeat wins for identity + status
    expect(a.name).toBe("Billing Bot");
    expect(a.version).toBe("1.2.0");
    expect(a.status).toBe("degraded");
    expect(a.runs).toBe(3);
    // successes 2 / runs 3 = 0.6667 → round2 0.67
    expect(a.successRate).toBe(0.67);
    // avg(1000,3000,2000) = 2000 (the 99ms out-of-window run is excluded)
    expect(a.avgDurationMs).toBe(2000);
    // (100+150+50) + (200+250+100) = 850
    expect(a.tokensTotal).toBe(850);
    // 50+30+20 = 100 (9999 out-of-window excluded)
    expect(a.costPence).toBe(100);
    // 10+5+0 = 15 (999 out-of-window excluded)
    expect(a.minutesSaved).toBe(15);
    expect(a.escalations).toBe(2);
    // timeValue = round(15/60 * 6000) = 1500; roi = 1500/100 = 15
    expect(a.perAgentRoi.timeValuePence).toBe(1500);
    expect(a.perAgentRoi.roiMultiple).toBe(15);
  });

  it("defaults heartbeat status to ok and computes a single-run agent (agent-b)", async () => {
    const body = await fetchAgents();
    const b = body.agents.find((x) => x.agentId === "agent-b")!;
    expect(b.status).toBe("ok");
    expect(b.runs).toBe(1);
    expect(b.successRate).toBe(1);
    expect(b.avgDurationMs).toBe(500);
    expect(b.tokensTotal).toBe(30);
    expect(b.costPence).toBe(5);
    expect(b.minutesSaved).toBe(2);
    expect(b.escalations).toBe(0);
    // timeValue = round(2/60 * 6000) = 200; roi = 200/5 = 40
    expect(b.perAgentRoi.timeValuePence).toBe(200);
    expect(b.perAgentRoi.roiMultiple).toBe(40);
  });

  it("returns null rates and null ROI for a heartbeat-only agent (agent-c)", async () => {
    const body = await fetchAgents();
    const c = body.agents.find((x) => x.agentId === "agent-c")!;
    expect(c.runs).toBe(0);
    expect(c.successRate).toBeNull();
    expect(c.avgDurationMs).toBeNull();
    expect(c.tokensTotal).toBe(0);
    expect(c.costPence).toBe(0);
    expect(c.minutesSaved).toBe(0);
    expect(c.perAgentRoi.roiMultiple).toBeNull();
    expect(c.perAgentRoi.note).toContain("No measured");
  });

  it("orders agents by run count descending", async () => {
    const body = await fetchAgents();
    const runs = body.agents.map((a) => a.runs);
    expect(runs).toEqual([...runs].sort((x, y) => y - x));
  });

  it("404s for a project outside the org", async () => {
    const res = await AGENTS(new Request("http://t/api"), {
      params: Promise.resolve({ projectId: randomUUID() }),
    });
    expect(res.status).toBe(404);
  });

  it("400s on a malformed date param", async () => {
    const res = await AGENTS(new Request(`http://t/api?from=nope`), {
      params: Promise.resolve({ projectId: projId }),
    });
    expect(res.status).toBe(400);
  });
});
