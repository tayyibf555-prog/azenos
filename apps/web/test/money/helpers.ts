import { randomUUID } from "node:crypto";
import {
  agentRuns,
  clients,
  db,
  events,
  expenses,
  londonMonthStartUTC,
  organizations,
  payments,
  projects,
  subscriptions,
  users,
} from "@azen/db";
import { eq } from "drizzle-orm";

/**
 * Throwaway-org harness for the Money tests (docs/phase4/CONTRACTS.md,
 * P4-MONEY). Every row is created under a fresh random org id and torn down in
 * afterAll — the DEMO_ORG_ID is NEVER touched.
 */
export interface MoneyHarness {
  orgId: string;
  userId: string;
  clientId: string;
  clientName: string;
  projectId: string;
  projectName: string;
}

/** YYYY-MM-DD of the London-month-start `monthsAgo` months back. */
export function monthStartIso(monthsAgo: number): string {
  return londonMonthStartUTC(monthsAgo).toISOString().slice(0, 10);
}

/** 'YYYY-MM' label for the London month `monthsAgo` back. */
export function monthLabel(monthsAgo: number): string {
  return monthStartIso(monthsAgo).slice(0, 7);
}

/** A Date `n` days into the London month `monthsAgo` back (stays in-month). */
export function dayInMonth(monthsAgo: number, dayOffset = 2): Date {
  return new Date(
    londonMonthStartUTC(monthsAgo).getTime() + dayOffset * 86_400_000,
  );
}

export async function createMoneyHarness(): Promise<MoneyHarness> {
  const orgId = randomUUID();
  const userId = randomUUID();
  const clientId = randomUUID();
  const projectId = randomUUID();
  const clientName = `Money Client ${orgId.slice(0, 8)}`;
  const projectName = `Money Project ${orgId.slice(0, 8)}`;

  await db.insert(organizations).values({ id: orgId, name: `Money Org ${orgId.slice(0, 8)}` });
  await db.insert(users).values({
    id: userId,
    orgId,
    name: "Money Owner",
    email: `owner+${orgId.slice(0, 8)}@money.example`,
  });
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
    slug: `money-${randomUUID()}`,
    type: "ai_agent",
    status: "live",
    retainerPenceMonthly: 100_000,
  });

  return { orgId, userId, clientId, clientName, projectId, projectName };
}

export async function cleanupMoneyHarness(h: MoneyHarness): Promise<void> {
  await db.delete(events).where(eq(events.orgId, h.orgId));
  await db.delete(agentRuns).where(eq(agentRuns.orgId, h.orgId));
  await db.delete(payments).where(eq(payments.orgId, h.orgId));
  await db.delete(subscriptions).where(eq(subscriptions.orgId, h.orgId));
  await db.delete(expenses).where(eq(expenses.orgId, h.orgId));
  await db.delete(projects).where(eq(projects.orgId, h.orgId));
  await db.delete(clients).where(eq(clients.orgId, h.orgId));
  await db.delete(users).where(eq(users.orgId, h.orgId));
  await db.delete(organizations).where(eq(organizations.id, h.orgId));
}
