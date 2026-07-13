import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  agentRuns,
  bookings,
  clients,
  db,
  events,
  insights,
  metricDefinitions,
  metricRollups,
  organizations,
  payments,
  projects,
  subscriptions,
  upsellProposals,
} from "@azen/db";

/**
 * Throwaway-org fixtures for the P4-BOOKINGS query tests. Every row hangs off a
 * caller-supplied random org id and is removed in cleanup(); the demo org is
 * never read or mutated (docs/ORCHESTRATION.md ground rules). Bookings are
 * placed at absolute instants the tests pass as an explicit [from,to] window,
 * so the numbers are deterministic regardless of the London wall clock.
 */

export async function createOrg(orgId: string): Promise<void> {
  await db.insert(organizations).values({ id: orgId, name: `P4B ${orgId.slice(0, 8)}` });
}

export async function createClientRow(
  orgId: string,
  opts: {
    id?: string;
    name?: string;
    status?: "lead" | "discovery" | "proposal" | "active" | "paused" | "churned";
    emails?: string[];
  } = {},
): Promise<string> {
  const id = opts.id ?? randomUUID();
  await db.insert(clients).values({
    id,
    orgId,
    name: opts.name ?? `Client ${id.slice(0, 8)}`,
    status: opts.status ?? "active",
    emails: opts.emails ?? [],
  });
  return id;
}

export async function createProjectRow(
  orgId: string,
  clientId: string,
  opts: {
    id?: string;
    name?: string;
    status?: "scoping" | "building" | "testing" | "live" | "paused";
    retainerPenceMonthly?: number;
    retainerActive?: boolean;
  } = {},
): Promise<string> {
  const id = opts.id ?? randomUUID();
  await db.insert(projects).values({
    id,
    orgId,
    clientId,
    name: opts.name ?? `Project ${id.slice(0, 8)}`,
    slug: `p4b-${randomUUID()}`,
    type: "ai_agent",
    stack: "custom_code",
    status: opts.status ?? "live",
    retainerPenceMonthly: opts.retainerPenceMonthly ?? 0,
    retainerActive: opts.retainerActive ?? false,
  });
  return id;
}

export async function insertBooking(
  orgId: string,
  opts: {
    clientId?: string | null;
    projectId?: string | null;
    source?: "calendly" | "client_system" | "manual";
    kind: "discovery" | "kickoff" | "review" | "client_end_customer";
    status?: "scheduled" | "completed" | "cancelled" | "no_show";
    startsAt: Date;
    inviteeEmail?: string | null;
  },
): Promise<string> {
  const id = randomUUID();
  await db.insert(bookings).values({
    id,
    orgId,
    clientId: opts.clientId ?? null,
    projectId: opts.projectId ?? null,
    source: opts.source ?? (opts.kind === "client_end_customer" ? "client_system" : "calendly"),
    kind: opts.kind,
    status: opts.status ?? "scheduled",
    startsAt: opts.startsAt,
    endsAt: new Date(opts.startsAt.getTime() + 30 * 60_000),
    invitee: opts.inviteeEmail ? { email: opts.inviteeEmail, name: "Test Invitee" } : null,
    raw: {},
  });
  return id;
}

export async function insertPayment(
  orgId: string,
  clientId: string,
  opts: {
    projectId?: string | null;
    kind?: "build_fee" | "retainer" | "deposit" | "other";
    source?: "stripe" | "bank_transfer" | "other";
    status?: "pending" | "paid" | "failed" | "refunded";
    amountPence: number;
    paidAt?: Date | null;
  },
): Promise<void> {
  await db.insert(payments).values({
    orgId,
    clientId,
    projectId: opts.projectId ?? null,
    kind: opts.kind ?? "retainer",
    source: opts.source ?? "bank_transfer",
    status: opts.status ?? "paid",
    amountPence: opts.amountPence,
    paidAt: opts.paidAt ?? new Date(),
  });
}

export async function cleanup(orgId: string): Promise<void> {
  // FK-safe order: child rows referencing clients/projects first.
  await db.delete(bookings).where(eq(bookings.orgId, orgId));
  await db.delete(payments).where(eq(payments.orgId, orgId));
  await db.delete(subscriptions).where(eq(subscriptions.orgId, orgId));
  await db.delete(upsellProposals).where(eq(upsellProposals.orgId, orgId));
  await db.delete(agentRuns).where(eq(agentRuns.orgId, orgId));
  await db.delete(events).where(eq(events.orgId, orgId));
  await db.delete(insights).where(eq(insights.orgId, orgId));
  await db.delete(metricRollups).where(eq(metricRollups.orgId, orgId));
  await db.delete(metricDefinitions).where(eq(metricDefinitions.orgId, orgId));
  await db.delete(projects).where(eq(projects.orgId, orgId));
  await db.delete(clients).where(eq(clients.orgId, orgId));
  await db.delete(organizations).where(eq(organizations.id, orgId));
}

/** An absolute instant `n` days before now — deterministic window placement. */
export function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 86_400_000);
}
