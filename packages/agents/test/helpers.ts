import { randomUUID } from "node:crypto";
import {
  agentRuns,
  bookings,
  clients,
  db,
  events,
  feedbackItems,
  insights,
  metricDefinitions,
  metricRollups,
  organizations,
  projects,
  subscriptions,
} from "@azen/db";

// NOTE: drizzle-orm is NOT a dependency of @azen/agents (no new deps), so the
// `eq`/`sql` operators are unavailable here. Inserts use drizzle's
// `.insert().values()` (no operators needed); every conditional delete/select
// goes through the postgres-js client (`db.$client`) with bound params.

/**
 * Throwaway-org test hygiene (docs/phase1 Ground rules). Every P3-RUNNER test
 * builds its own org/client/project(s) with random ids and tears it ALL down in
 * afterEach/afterAll. These tests NEVER read or mutate the demo org
 * (DEMO_ORG_ID), and they hand-build every rollup/event/insight so they don't
 * depend on seed values.
 */

export interface AgentsHarness {
  orgId: string;
  clientId: string;
  clientName: string;
  /** primary project (live, green) */
  projectId: string;
  projectName: string;
}

export async function createHarness(
  label = `Agents Test ${randomUUID().slice(0, 8)}`,
): Promise<AgentsHarness> {
  const orgId = randomUUID();
  const clientId = randomUUID();
  const projectId = randomUUID();
  const clientName = "Acme Client";
  const projectName = "Alpha Project";

  await db.insert(organizations).values({ id: orgId, name: label });
  await db.insert(clients).values({
    id: clientId,
    orgId,
    name: clientName,
    status: "active",
  });
  await db.insert(projects).values({
    id: projectId,
    orgId,
    clientId,
    name: projectName,
    slug: `agents-test-${randomUUID()}`,
    type: "ai_agent",
    stack: "custom_code",
    status: "live",
    health: "green",
  });

  return { orgId, clientId, clientName, projectId, projectName };
}

export async function cleanupHarness(h: AgentsHarness): Promise<void> {
  const c = db.$client;
  // FK-safe order: children first, then projects/clients, then the org.
  await c`delete from agent_runs where org_id = ${h.orgId}::uuid`;
  await c`delete from feedback_items where org_id = ${h.orgId}::uuid`;
  await c`delete from events where org_id = ${h.orgId}::uuid`;
  await c`delete from insights where org_id = ${h.orgId}::uuid`;
  await c`delete from metric_rollups where org_id = ${h.orgId}::uuid`;
  await c`delete from metric_definitions where org_id = ${h.orgId}::uuid`;
  await c`delete from bookings where org_id = ${h.orgId}::uuid`;
  await c`delete from subscriptions where org_id = ${h.orgId}::uuid`;
  await c`delete from projects where org_id = ${h.orgId}::uuid`;
  await c`delete from clients where org_id = ${h.orgId}::uuid`;
  await c`delete from organizations where id = ${h.orgId}::uuid`;
}

export async function clearAgentRuns(orgId: string): Promise<void> {
  await db.$client`delete from agent_runs where org_id = ${orgId}::uuid`;
}

/** Read agent_runs rows for an org (newest first) via the raw client. */
export interface AgentRunRow {
  id: string;
  agent: string;
  status: string;
  model: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_estimate_pence: number | null;
  error: string | null;
  project_id: string | null;
  client_id: string | null;
  finished_at: string | null;
  output_refs: Record<string, unknown>;
}

export async function readAgentRuns(orgId: string): Promise<AgentRunRow[]> {
  return (await db.$client`
    select id::text as id, agent::text as agent, status::text as status, model,
      tokens_in, tokens_out, cost_estimate_pence, error,
      project_id::text as project_id, client_id::text as client_id,
      to_char(finished_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as finished_at,
      output_refs
    from agent_runs where org_id = ${orgId}::uuid
    order by started_at desc
  `) as unknown as AgentRunRow[];
}

/** Insert a bare succeeded agent_runs row with a fixed cost (budget tests). */
export async function insertAgentRunCost(
  orgId: string,
  costEstimatePence: number,
): Promise<string> {
  const id = randomUUID();
  await db.insert(agentRuns).values({
    id,
    orgId,
    agent: "daily_brief",
    status: "succeeded",
    startedAt: new Date(),
    finishedAt: new Date(),
    model: "test-model",
    tokensIn: 1000,
    tokensOut: 1000,
    costEstimatePence,
  });
  return id;
}

/**
 * London day-start UTC instants for `count` complete days ending yesterday,
 * computed by Postgres so they match the rollup/anomaly boundaries exactly.
 * Index 0 = yesterday, index 1 = the day before, …
 */
export async function londonDayStartsUTC(count: number): Promise<string[]> {
  const client = db.$client;
  const rows = (await client`
    select to_char(
      (date_trunc('day', now() at time zone 'Europe/London') - make_interval(days => g)) at time zone 'Europe/London' at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS"Z"'
    ) as iso
    from generate_series(1, ${count}) g order by g
  `) as unknown as { iso: string }[];
  return rows.map((r) => r.iso);
}

export interface AddProjectInput {
  orgId: string;
  clientId: string;
  name: string;
  health?: "green" | "amber" | "red";
  status?:
    | "scoping"
    | "building"
    | "testing"
    | "live"
    | "paused"
    | "completed"
    | "cancelled";
}

export async function addProject(input: AddProjectInput): Promise<string> {
  const id = randomUUID();
  await db.insert(projects).values({
    id,
    orgId: input.orgId,
    clientId: input.clientId,
    name: input.name,
    slug: `agents-test-${randomUUID()}`,
    type: "automation",
    stack: "custom_code",
    status: input.status ?? "live",
    health: input.health ?? "green",
  });
  return id;
}

export async function insertKpiDef(
  orgId: string,
  def: {
    key: string;
    name: string;
    unit?: "count" | "pence" | "minutes" | "percent" | "ms";
    goodDirection?: "up" | "down";
    /** null = global (applies to every project); else project-scoped */
    projectId?: string | null;
    sort?: number;
  },
): Promise<void> {
  await db.insert(metricDefinitions).values({
    orgId,
    projectId: def.projectId ?? null,
    key: def.key,
    name: def.name,
    unit: def.unit ?? "count",
    aggregation: "count",
    eventType: "custom.metric",
    goodDirection: def.goodDirection ?? "up",
    isKpi: true,
    sort: def.sort ?? 0,
  });
}

export async function insertDayRollup(
  orgId: string,
  projectId: string,
  metricKey: string,
  periodStartIso: string,
  value: number,
): Promise<void> {
  await db.insert(metricRollups).values({
    orgId,
    projectId,
    metricKey,
    period: "day",
    periodStart: new Date(periodStartIso),
    value,
    sampleCount: Math.round(value),
  });
}

export async function insertEvent(
  orgId: string,
  projectId: string,
  ev: {
    type: string;
    occurredAt: Date;
    valuePence?: number | null;
    minutesSaved?: number | null;
  },
): Promise<void> {
  await db.insert(events).values({
    orgId,
    projectId,
    type: ev.type,
    source: "sdk",
    idempotencyKey: `test:${randomUUID()}`,
    occurredAt: ev.occurredAt,
    receivedAt: ev.occurredAt,
    data: {},
    valuePence: ev.valuePence ?? null,
    minutesSaved: ev.minutesSaved ?? null,
    raw: {},
  });
}

export async function insertInsight(
  orgId: string,
  projectId: string,
  ins: {
    kind:
      | "automation_opportunity"
      | "upsell"
      | "risk"
      | "win"
      | "anomaly"
      | "faq_cluster";
    title: string;
    confidence?: "low" | "med" | "high";
    metricKey?: string;
  },
): Promise<void> {
  await db.insert(insights).values({
    orgId,
    projectId,
    kind: ins.kind,
    title: ins.title,
    bodyMd: ins.title,
    evidence: ins.metricKey ? { metric_key: ins.metricKey } : {},
    confidence: ins.confidence ?? "med",
    status: "new",
    createdBy: "agent",
  });
}

export async function insertActiveSubscription(
  orgId: string,
  clientId: string,
  amountPenceMonthly: number,
): Promise<void> {
  await db.insert(subscriptions).values({
    orgId,
    clientId,
    amountPenceMonthly,
    status: "active",
    startedAt: "2026-01-01",
  });
}

/**
 * Hand-build a feedback_items row (Phase 7 §B3) plus its backing
 * feedback.submitted event (event_id is NOT NULL / FK'd), mirroring how the
 * public feedback webhook writes both in one transaction. createdAt controls
 * the day/window the pack query buckets it into.
 */
export async function insertFeedbackItem(
  orgId: string,
  projectId: string,
  fb: {
    kind: "bug" | "feature" | "question" | "praise" | "other";
    message: string;
    severity?: number | null;
    createdAt: Date;
  },
): Promise<void> {
  const eventId = randomUUID();
  await db.insert(events).values({
    id: eventId,
    orgId,
    projectId,
    type: "feedback.submitted",
    source: "feedback",
    idempotencyKey: `test:${randomUUID()}`,
    occurredAt: fb.createdAt,
    receivedAt: fb.createdAt,
    data: {},
    valuePence: null,
    minutesSaved: null,
    raw: {},
  });
  await db.insert(feedbackItems).values({
    orgId,
    projectId,
    eventId,
    kind: fb.kind,
    message: fb.message,
    severity: fb.severity ?? null,
    status: "new",
    createdAt: fb.createdAt,
  });
}

export async function insertClientBooking(
  orgId: string,
  clientId: string,
  projectId: string,
  startsAt: Date,
): Promise<void> {
  await db.insert(bookings).values({
    orgId,
    clientId,
    projectId,
    source: "client_system",
    kind: "client_end_customer",
    startsAt,
    status: "scheduled",
  });
}
