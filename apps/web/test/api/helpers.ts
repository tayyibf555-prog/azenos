import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import {
  bookings,
  clients,
  contacts,
  db,
  events,
  industries,
  ingestRateCounters,
  insights,
  organizations,
  projectIntegrations,
  projectKeys,
  projects,
  subscriptions,
  users,
  webhookDeliveries,
} from "@azen/db";
import { generateKeyPair } from "@azen/db/keys";

/**
 * Throwaway-org fixtures for the dashboard API tests. Every row is created
 * under a fresh random org id and removed in cleanupOrg() using the Ground
 * Rules delete order — the demo org is never touched.
 */

export async function createOrg(orgId: string): Promise<void> {
  await db
    .insert(organizations)
    .values({ id: orgId, name: `Test Org ${orgId.slice(0, 8)}` });
}

export async function createTestClient(
  orgId: string,
  opts: { name?: string; status?: "lead" | "active" } = {},
): Promise<string> {
  const id = randomUUID();
  await db.insert(clients).values({
    id,
    orgId,
    name: opts.name ?? `Test Client ${id.slice(0, 8)}`,
    status: opts.status ?? "active",
  });
  return id;
}

export async function createTestProject(
  orgId: string,
  clientId: string,
  opts: {
    name?: string;
    status?: "scoping" | "building" | "live" | "paused";
    retainerPenceMonthly?: number;
  } = {},
): Promise<string> {
  const id = randomUUID();
  await db.insert(projects).values({
    id,
    orgId,
    clientId,
    name: opts.name ?? `Test Project ${id.slice(0, 8)}`,
    slug: `test-${randomUUID()}`,
    type: "automation",
    status: opts.status ?? "live",
    retainerPenceMonthly: opts.retainerPenceMonthly,
  });
  return id;
}

export interface TestKey {
  keyId: string;
  publicKey: string;
  secret: string;
  secretHash: string;
  secretCiphertext: string;
}

export async function createTestKey(
  orgId: string,
  projectId: string,
  opts: { authMode?: "hmac" | "token"; rateLimitPer10s?: number } = {},
): Promise<TestKey> {
  const keyId = randomUUID();
  const pair = generateKeyPair();
  await db.insert(projectKeys).values({
    id: keyId,
    orgId,
    projectId,
    publicKey: pair.publicKey,
    secretHash: pair.secretHash,
    secretCiphertext: pair.secretCiphertext,
    authMode: opts.authMode ?? "hmac",
    rateLimitPer10s: opts.rateLimitPer10s,
  });
  return { keyId, ...pair };
}

export async function insertTestEvent(
  orgId: string,
  projectId: string | null,
  opts: {
    type?: string;
    occurredAt: Date;
    receivedAt?: Date;
    subjectName?: string;
    valuePence?: number;
    minutesSaved?: number;
    data?: Record<string, unknown>;
  },
): Promise<string> {
  const id = randomUUID();
  await db.insert(events).values({
    id,
    orgId,
    projectId,
    type: opts.type ?? "custom.test_event",
    idempotencyKey: `test:${randomUUID()}`,
    occurredAt: opts.occurredAt,
    ...(opts.receivedAt ? { receivedAt: opts.receivedAt } : {}),
    subject: opts.subjectName
      ? { kind: "customer", name: opts.subjectName }
      : undefined,
    data: opts.data ?? {},
    valuePence: opts.valuePence,
    minutesSaved: opts.minutesSaved,
    raw: { test: true },
  });
  return id;
}

export async function cleanupOrg(orgId: string): Promise<void> {
  // Ground Rules delete order, plus subscriptions/industries which these
  // fixtures also create (slotted FK-safely: before clients / organizations).
  await db.delete(webhookDeliveries).where(eq(webhookDeliveries.orgId, orgId));
  await db.delete(events).where(eq(events.orgId, orgId));
  await db.delete(bookings).where(eq(bookings.orgId, orgId));
  await db.delete(insights).where(eq(insights.orgId, orgId));
  await db.delete(ingestRateCounters).where(
    inArray(
      ingestRateCounters.projectKeyId,
      db
        .select({ id: projectKeys.id })
        .from(projectKeys)
        .where(eq(projectKeys.orgId, orgId)),
    ),
  );
  await db.delete(projectKeys).where(eq(projectKeys.orgId, orgId));
  await db
    .delete(projectIntegrations)
    .where(eq(projectIntegrations.orgId, orgId));
  await db.delete(subscriptions).where(eq(subscriptions.orgId, orgId));
  await db.delete(projects).where(eq(projects.orgId, orgId));
  await db.delete(contacts).where(eq(contacts.orgId, orgId));
  await db.delete(clients).where(eq(clients.orgId, orgId));
  await db.delete(users).where(eq(users.orgId, orgId));
  await db.delete(industries).where(eq(industries.orgId, orgId));
  await db.delete(organizations).where(eq(organizations.id, orgId));
}
