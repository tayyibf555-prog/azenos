import { randomUUID } from "node:crypto";
import {
  agentRuns,
  clients,
  db,
  events,
  organizations,
  payments,
  projectKeys,
  projects,
  users,
  webhookDeliveries,
} from "@azen/db";
import { eq } from "drizzle-orm";

/**
 * Throwaway-org harness for the P9-PACK3 tests (money depth, data quality,
 * portfolio). Every row is created under a fresh random org id and torn
 * down in afterAll — the DEMO_ORG_ID is never touched.
 */
export interface PortfolioHarness {
  orgId: string;
  userId: string;
}

export async function createPortfolioHarness(): Promise<PortfolioHarness> {
  const orgId = randomUUID();
  const userId = randomUUID();
  await db.insert(organizations).values({ id: orgId, name: `Portfolio Org ${orgId.slice(0, 8)}` });
  await db.insert(users).values({
    id: userId,
    orgId,
    name: "Portfolio Owner",
    email: `owner+${orgId.slice(0, 8)}@portfolio.example`,
  });
  return { orgId, userId };
}

export async function cleanupPortfolioHarness(h: PortfolioHarness): Promise<void> {
  await db.delete(events).where(eq(events.orgId, h.orgId));
  await db.delete(agentRuns).where(eq(agentRuns.orgId, h.orgId));
  await db.delete(webhookDeliveries).where(eq(webhookDeliveries.orgId, h.orgId));
  await db.delete(payments).where(eq(payments.orgId, h.orgId));
  await db.delete(projectKeys).where(eq(projectKeys.orgId, h.orgId));
  await db.delete(projects).where(eq(projects.orgId, h.orgId));
  await db.delete(clients).where(eq(clients.orgId, h.orgId));
  await db.delete(users).where(eq(users.orgId, h.orgId));
  await db.delete(organizations).where(eq(organizations.id, h.orgId));
}

export async function insertClient(orgId: string, name: string): Promise<string> {
  const clientId = randomUUID();
  await db.insert(clients).values({ id: clientId, orgId, name, status: "active" });
  return clientId;
}

export interface InsertProjectOpts {
  orgId: string;
  clientId: string;
  name?: string;
  type?: (typeof projects.$inferInsert)["type"];
  status?: (typeof projects.$inferInsert)["status"];
  health?: (typeof projects.$inferInsert)["health"];
  buildFeePence?: number;
  hourlyRatePence?: number | null;
}

export async function insertProject(o: InsertProjectOpts): Promise<string> {
  const projectId = randomUUID();
  await db.insert(projects).values({
    id: projectId,
    orgId: o.orgId,
    clientId: o.clientId,
    name: o.name ?? `Project ${projectId.slice(0, 8)}`,
    slug: `portfolio-${randomUUID()}`,
    type: o.type ?? "ai_agent",
    status: o.status ?? "live",
    health: o.health ?? "green",
    buildFeePence: o.buildFeePence ?? 0,
    hourlyRatePence: o.hourlyRatePence ?? null,
  });
  return projectId;
}

/** Minimal project_keys row — enough to satisfy webhook_deliveries' FK. */
export async function insertProjectKey(orgId: string, projectId: string): Promise<string> {
  const keyId = randomUUID();
  await db.insert(projectKeys).values({
    id: keyId,
    orgId,
    projectId,
    publicKey: `azn_pk_test_${randomUUID()}`,
    secretHash: "test-hash",
  });
  return keyId;
}

export interface InsertEventOpts {
  orgId: string;
  projectId: string;
  type: string;
  occurredAt: Date;
  data?: Record<string, unknown>;
  valuePence?: number | null;
  minutesSaved?: number | null;
}

export async function insertEvent(o: InsertEventOpts): Promise<void> {
  await db.insert(events).values({
    orgId: o.orgId,
    projectId: o.projectId,
    type: o.type,
    idempotencyKey: randomUUID(),
    occurredAt: o.occurredAt,
    data: o.data ?? {},
    valuePence: o.valuePence ?? null,
    minutesSaved: o.minutesSaved ?? null,
    raw: {},
  });
}

export interface InsertAgentRunOpts {
  orgId: string;
  clientId: string;
  projectId: string;
  costEstimatePence: number;
  startedAt: Date;
  agent?: (typeof agentRuns.$inferInsert)["agent"];
}

export async function insertAgentRun(o: InsertAgentRunOpts): Promise<void> {
  await db.insert(agentRuns).values({
    orgId: o.orgId,
    clientId: o.clientId,
    projectId: o.projectId,
    agent: o.agent ?? "daily_brief",
    startedAt: o.startedAt,
    status: "succeeded",
    costEstimatePence: o.costEstimatePence,
  });
}

export async function insertDelivery(o: {
  orgId: string;
  projectKeyId: string;
  status: (typeof webhookDeliveries.$inferInsert)["status"];
  receivedAt: Date;
}): Promise<void> {
  await db.insert(webhookDeliveries).values({
    orgId: o.orgId,
    projectKeyId: o.projectKeyId,
    status: o.status,
    httpStatus: o.status === "accepted" || o.status === "duplicate" ? 200 : 400,
    receivedAt: o.receivedAt,
  });
}

export async function insertPayment(o: {
  orgId: string;
  clientId: string;
  amountPence: number;
  paidAt: Date;
  status?: (typeof payments.$inferInsert)["status"];
}): Promise<void> {
  await db.insert(payments).values({
    orgId: o.orgId,
    clientId: o.clientId,
    source: "other",
    kind: "build_fee",
    amountPence: o.amountPence,
    status: o.status ?? "paid",
    paidAt: o.paidAt,
  });
}
