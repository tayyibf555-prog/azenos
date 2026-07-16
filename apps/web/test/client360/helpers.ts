import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  briefs,
  clients,
  db,
  events,
  feedbackItems,
  organizations,
  projects,
  subscriptions,
} from "@azen/db";

/**
 * Throwaway-org fixtures for the P8-C360 aggregation tests
 * (docs/phase8/CONTRACTS.md). Every row hangs off a caller-supplied random org
 * id and is removed in cleanup(); the demo org is never read or mutated
 * (ground rules). Self-contained (does not import test/bookings/helpers.ts)
 * so this file owns its whole fixture lifecycle independently of the parallel
 * P8 workstreams touching that shared file.
 */

export async function createOrg(orgId: string): Promise<void> {
  await db.insert(organizations).values({ id: orgId, name: `C360 ${orgId.slice(0, 8)}` });
}

export async function createClientRow(
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

export async function createProjectRow(
  orgId: string,
  clientId: string,
  opts: { id?: string; name?: string; retainerPenceMonthly?: number } = {},
): Promise<string> {
  const id = opts.id ?? randomUUID();
  await db.insert(projects).values({
    id,
    orgId,
    clientId,
    name: opts.name ?? `Project ${id.slice(0, 8)}`,
    slug: `c360-${randomUUID()}`,
    type: "ai_agent",
    stack: "custom_code",
    status: "live",
    retainerPenceMonthly: opts.retainerPenceMonthly ?? 0,
    retainerActive: (opts.retainerPenceMonthly ?? 0) > 0,
  });
  return id;
}

export async function createSubscription(
  orgId: string,
  clientId: string,
  opts: {
    projectId?: string | null;
    amountPenceMonthly: number;
    status?: "active" | "cancelled" | "past_due";
  },
): Promise<void> {
  await db.insert(subscriptions).values({
    orgId,
    clientId,
    projectId: opts.projectId ?? null,
    amountPenceMonthly: opts.amountPenceMonthly,
    status: opts.status ?? "active",
    startedAt: new Date().toISOString().slice(0, 10),
  });
}

export async function insertEvent(
  orgId: string,
  projectId: string,
  opts: {
    type: string;
    occurredAt: Date;
    data?: Record<string, unknown>;
  },
): Promise<string> {
  const id = randomUUID();
  await db.insert(events).values({
    id,
    orgId,
    projectId,
    type: opts.type,
    idempotencyKey: `c360-${id}`,
    occurredAt: opts.occurredAt,
    data: opts.data ?? {},
    raw: {},
  });
  return id;
}

/** feedback.submitted event + its feedback_items mirror row, in one call. */
export async function insertFeedbackItem(
  orgId: string,
  projectId: string,
  opts: {
    kind: "bug" | "feature" | "question" | "praise" | "other";
    status?: "new" | "seen" | "planned" | "done";
    message?: string;
  },
): Promise<void> {
  const eventId = await insertEvent(orgId, projectId, {
    type: "feedback.submitted",
    occurredAt: new Date(),
    data: { kind: opts.kind, message: opts.message ?? "test feedback" },
  });
  await db.insert(feedbackItems).values({
    orgId,
    projectId,
    eventId,
    kind: opts.kind,
    message: opts.message ?? "test feedback",
    status: opts.status ?? "new",
  });
}

export async function insertBrief(
  orgId: string,
  opts: {
    projectId: string | null;
    period?: "daily" | "weekly" | "monthly";
    periodStart: Date;
    headline: string;
  },
): Promise<string> {
  const id = randomUUID();
  await db.insert(briefs).values({
    id,
    orgId,
    scope: opts.projectId ? "project" : "agency",
    projectId: opts.projectId,
    period: opts.period ?? "weekly",
    periodStart: opts.periodStart,
    headline: opts.headline,
    bodyMd: opts.headline,
  });
  return id;
}

/** An absolute instant `n` days before now — deterministic window placement. */
export function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 86_400_000);
}

export async function cleanup(orgId: string): Promise<void> {
  // FK-safe order: children before parents.
  await db.delete(feedbackItems).where(eq(feedbackItems.orgId, orgId));
  await db.delete(briefs).where(eq(briefs.orgId, orgId));
  await db.delete(events).where(eq(events.orgId, orgId));
  await db.delete(subscriptions).where(eq(subscriptions.orgId, orgId));
  await db.delete(projects).where(eq(projects.orgId, orgId));
  await db.delete(clients).where(eq(clients.orgId, orgId));
  await db.delete(organizations).where(eq(organizations.id, orgId));
}
