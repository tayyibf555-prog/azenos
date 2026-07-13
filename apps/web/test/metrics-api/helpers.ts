import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  agentRuns,
  clients,
  db,
  events,
  insights,
  londonMonthStartUTC,
  londonTodayUTC,
  metricDefinitions,
  metricRollups,
  organizations,
  projects,
  rollupWatermarks,
} from "@azen/db";

/**
 * Throwaway-org fixtures for the M2 metrics-API tests (docs/phase1 §Ground
 * rules). Every row hangs off a caller-supplied random org id and is removed in
 * cleanupOrg(); the demo org is never read or mutated. Events are placed at NOON
 * UTC of a given London calendar date so the London day bucket is unambiguous in
 * both GMT and BST — the tests hand-compute every expected number.
 */

export async function createOrg(orgId: string): Promise<void> {
  await db.insert(organizations).values({ id: orgId, name: `M2 Test ${orgId.slice(0, 8)}` });
}

export async function createClient(
  orgId: string,
  opts: { id?: string; name?: string } = {},
): Promise<string> {
  const id = opts.id ?? randomUUID();
  await db.insert(clients).values({
    id,
    orgId,
    name: opts.name ?? `Client ${id.slice(0, 8)}`,
    status: "active",
  });
  return id;
}

export async function createProject(
  orgId: string,
  clientId: string,
  opts: {
    id?: string;
    name?: string;
    status?: "scoping" | "building" | "testing" | "live" | "paused";
    health?: "green" | "amber" | "red";
    retainerPenceMonthly?: number;
    hourlyRatePence?: number | null;
  } = {},
): Promise<string> {
  const id = opts.id ?? randomUUID();
  await db.insert(projects).values({
    id,
    orgId,
    clientId,
    name: opts.name ?? `Project ${id.slice(0, 8)}`,
    slug: `m2-${randomUUID()}`,
    type: "ai_agent",
    stack: "custom_code",
    status: opts.status ?? "live",
    health: opts.health ?? "green",
    retainerPenceMonthly: opts.retainerPenceMonthly,
    hourlyRatePence: opts.hourlyRatePence ?? null,
  });
  return id;
}

export interface DefInput {
  key: string;
  name?: string;
  aggregation: "count" | "sum" | "avg" | "p95" | "last" | "rate";
  eventType: string;
  unit?: "count" | "pence" | "minutes" | "percent" | "ms";
  valuePath?: string | null;
  whereEquals?: Record<string, string | number | boolean> | null;
  isKpi?: boolean;
  goodDirection?: "up" | "down";
  sort?: number;
  /** true = project-scoped custom def; default false = org-level global */
  projectScoped?: boolean;
}

export async function insertDef(
  orgId: string,
  projectId: string,
  def: DefInput,
): Promise<void> {
  await db.insert(metricDefinitions).values({
    orgId,
    projectId: def.projectScoped ? projectId : null,
    key: def.key,
    name: def.name ?? def.key,
    aggregation: def.aggregation,
    eventType: def.eventType,
    unit: def.unit ?? "count",
    valuePath: def.valuePath ?? null,
    whereEquals: def.whereEquals ?? null,
    isKpi: def.isKpi ?? false,
    goodDirection: def.goodDirection ?? "up",
    sort: def.sort ?? 0,
  });
}

export async function insertEvent(
  orgId: string,
  projectId: string,
  ev: {
    type: string;
    occurredAt: Date;
    receivedAt?: Date;
    data?: Record<string, unknown>;
    valuePence?: number | null;
    minutesSaved?: number | null;
  },
): Promise<string> {
  const id = randomUUID();
  await db.insert(events).values({
    id,
    orgId,
    projectId,
    type: ev.type,
    source: "sdk",
    idempotencyKey: `test:${randomUUID()}`,
    occurredAt: ev.occurredAt,
    ...(ev.receivedAt ? { receivedAt: ev.receivedAt } : {}),
    data: ev.data ?? {},
    valuePence: ev.valuePence ?? null,
    minutesSaved: ev.minutesSaved ?? null,
    raw: ev.data ?? {},
  });
  return id;
}

export async function insertAgentRun(
  orgId: string,
  opts: {
    projectId?: string | null;
    clientId?: string | null;
    costEstimatePence: number;
    startedAt: Date;
    agent?:
      | "daily_brief"
      | "weekly_synth"
      | "monthly_strategist"
      | "opportunity_scout"
      | "industry_learner"
      | "upsell_engine"
      | "project_intake";
  },
): Promise<void> {
  await db.insert(agentRuns).values({
    orgId,
    agent: opts.agent ?? "project_intake",
    projectId: opts.projectId ?? null,
    clientId: opts.clientId ?? null,
    startedAt: opts.startedAt,
    finishedAt: opts.startedAt,
    status: "succeeded",
    costEstimatePence: opts.costEstimatePence,
  });
}

export async function insertInsight(
  orgId: string,
  projectId: string,
  opts: {
    kind?: "anomaly" | "risk" | "win" | "automation_opportunity";
    title?: string;
    bodyMd?: string;
    status?: "new" | "reviewed" | "dismissed";
    confidence?: "low" | "med" | "high";
    evidence?: Record<string, unknown>;
  } = {},
): Promise<string> {
  const id = randomUUID();
  await db.insert(insights).values({
    id,
    orgId,
    projectId,
    kind: opts.kind ?? "anomaly",
    title: opts.title ?? "Test insight",
    bodyMd: opts.bodyMd ?? "body",
    status: opts.status ?? "new",
    confidence: opts.confidence ?? "med",
    createdBy: "agent",
    evidence: opts.evidence ?? {},
  });
  return id;
}

export async function cleanupOrg(orgId: string): Promise<void> {
  await db.delete(agentRuns).where(eq(agentRuns.orgId, orgId));
  await db.delete(events).where(eq(events.orgId, orgId));
  await db.delete(insights).where(eq(insights.orgId, orgId));
  await db.delete(metricRollups).where(eq(metricRollups.orgId, orgId));
  await db.delete(rollupWatermarks).where(eq(rollupWatermarks.orgId, orgId));
  await db.delete(metricDefinitions).where(eq(metricDefinitions.orgId, orgId));
  await db.delete(projects).where(eq(projects.orgId, orgId));
  await db.delete(clients).where(eq(clients.orgId, orgId));
  await db.delete(organizations).where(eq(organizations.id, orgId));
}

// ── London-date helpers (tests place events at noon UTC of a London date) ─────

/** YYYY-MM-DD of the London calendar date `daysAgo` before today. */
export function londonDateStr(daysAgo: number): string {
  const d = londonTodayUTC();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

/** Noon-UTC instant on the London date `daysAgo` before today (bucket-safe). */
export function noonOnDaysAgo(daysAgo: number): Date {
  return new Date(`${londonDateStr(daysAgo)}T12:00:00Z`);
}

/** Current London month as 'YYYY-MM'. */
export function currentMonth(): string {
  return londonMonthStartUTC(0).toISOString().slice(0, 7);
}

/** Noon-UTC on the 1st of the current London month (always in-month). */
export function noonOnMonthStart(): Date {
  const d = londonMonthStartUTC(0);
  d.setUTCHours(12);
  return d;
}
