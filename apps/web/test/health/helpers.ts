import { randomUUID } from "node:crypto";
import {
  alertInstances,
  clients,
  db,
  events,
  feedbackItems,
  organizations,
  projects,
  subscriptions,
  users,
} from "@azen/db";
import { eq } from "drizzle-orm";

/**
 * Throwaway-org fixtures for the P8-HEALTH evaluator + alerts API tests
 * (docs/phase8/CONTRACTS.md). Every row hangs off a caller-supplied random org
 * id — never the demo org. Events are written straight to the spine (the
 * evaluator reads occurred_at), with feedback / subscriptions for the feedback
 * + retainer columns.
 */

export interface HealthOrg {
  orgId: string;
  userId: string;
  clientId: string;
}

export async function createHealthOrg(): Promise<HealthOrg> {
  const orgId = randomUUID();
  const userId = randomUUID();
  const clientId = randomUUID();
  await db.insert(organizations).values({ id: orgId, name: `Health ${orgId.slice(0, 8)}` });
  await db.insert(users).values({
    id: userId,
    orgId,
    name: "Owner",
    email: `owner+${orgId.slice(0, 8)}@test.example`,
    role: "owner",
  });
  await db.insert(clients).values({
    id: clientId,
    orgId,
    name: `Client ${orgId.slice(0, 6)}`,
    status: "active",
  });
  return { orgId, userId, clientId };
}

export interface ProjectSlo {
  error_rate_pct?: number;
  p95_ms?: number;
  heartbeat_gap_minutes?: number;
}

export async function createLiveProject(
  org: HealthOrg,
  opts: { name?: string; slo?: ProjectSlo | null } = {},
): Promise<string> {
  const id = randomUUID();
  await db.insert(projects).values({
    id,
    orgId: org.orgId,
    clientId: org.clientId,
    name: opts.name ?? `Project ${id.slice(0, 6)}`,
    slug: `health-${id}`,
    type: "ai_agent",
    stack: "custom_code",
    status: "live",
    slo: opts.slo ?? null,
  });
  return id;
}

let eventSeq = 0;

export async function insertEvent(
  org: HealthOrg,
  projectId: string,
  type: string,
  occurredAt: Date,
  data: Record<string, unknown> = {},
): Promise<void> {
  const id = randomUUID();
  eventSeq += 1;
  await db.insert(events).values({
    id,
    orgId: org.orgId,
    projectId,
    type,
    source: "sdk",
    idempotencyKey: `health-test:${id}:${eventSeq}`,
    occurredAt,
    receivedAt: occurredAt,
    data,
    raw: {},
  });
}

/** Bulk helper: N events of one type spread just before `before`. */
export async function insertEvents(
  org: HealthOrg,
  projectId: string,
  type: string,
  count: number,
  before: Date,
  data: Record<string, unknown> = {},
): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    const at = new Date(before.getTime() - (i + 1) * 60_000);
    await insertEvent(org, projectId, type, at, data);
  }
}

export async function insertNegativeFeedback(
  org: HealthOrg,
  projectId: string,
  count: number,
  before: Date,
): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    const eventId = randomUUID();
    const at = new Date(before.getTime() - (i + 1) * 60_000);
    await db.insert(events).values({
      id: eventId,
      orgId: org.orgId,
      projectId,
      type: "feedback.submitted",
      source: "feedback",
      idempotencyKey: `health-test:fb:${eventId}`,
      occurredAt: at,
      receivedAt: at,
      data: { kind: "bug", message: "broken" },
      raw: {},
    });
    await db.insert(feedbackItems).values({
      id: randomUUID(),
      orgId: org.orgId,
      projectId,
      eventId,
      kind: "bug",
      message: "broken",
      status: "new",
      createdAt: at,
    });
  }
}

export async function insertPastDueRetainer(
  org: HealthOrg,
  projectId: string | null,
): Promise<void> {
  await db.insert(subscriptions).values({
    id: randomUUID(),
    orgId: org.orgId,
    clientId: org.clientId,
    projectId,
    amountPenceMonthly: 50_000,
    status: "past_due",
    startedAt: "2026-01-01",
  });
}

export async function cleanupHealthOrg(org: HealthOrg): Promise<void> {
  await db.delete(alertInstances).where(eq(alertInstances.orgId, org.orgId));
  await db.delete(feedbackItems).where(eq(feedbackItems.orgId, org.orgId));
  await db.delete(subscriptions).where(eq(subscriptions.orgId, org.orgId));
  await db.delete(events).where(eq(events.orgId, org.orgId));
  await db.delete(projects).where(eq(projects.orgId, org.orgId));
  await db.delete(clients).where(eq(clients.orgId, org.orgId));
  await db.delete(users).where(eq(users.orgId, org.orgId));
  await db.delete(organizations).where(eq(organizations.id, org.orgId));
}
