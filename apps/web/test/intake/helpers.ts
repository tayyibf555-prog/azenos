import { randomUUID } from "node:crypto";
import {
  agentRuns,
  clients,
  db,
  industries,
  organizations,
  projects,
  users,
} from "@azen/db";
import { eq } from "drizzle-orm";
import type { ProjectDraft } from "../../lib/server/intake/schema";

/**
 * Throwaway-org test hygiene (docs/phase1 Ground rules). Intake writes only
 * agent_runs, reads clients, and (addendum §B) attributes runs to a project —
 * so the harness carries one project too. NEVER touch the demo org.
 */

export interface IntakeHarness {
  orgId: string;
  userId: string;
  clientId: string;
  clientName: string;
  industryId: string;
  industrySlug: string;
  projectId: string;
  projectName: string;
}

export async function createIntakeHarness(): Promise<IntakeHarness> {
  const orgId = randomUUID();
  const userId = randomUUID();
  const clientId = randomUUID();
  const industryId = randomUUID();
  const projectId = randomUUID();
  const industrySlug = `dental-${orgId.slice(0, 8)}`;
  const clientName = "Bright Smile Dental";
  const projectName = "Reception Voice Agent";

  await db.insert(organizations).values({ id: orgId, name: `Intake Test ${orgId.slice(0, 8)}` });
  await db.insert(users).values({
    id: userId,
    orgId,
    name: "Test Owner",
    email: `owner+${orgId.slice(0, 8)}@test.example`,
  });
  await db.insert(industries).values({
    id: industryId,
    orgId,
    slug: industrySlug,
    name: "Dental",
  });
  await db.insert(clients).values({
    id: clientId,
    orgId,
    name: clientName,
    status: "active",
    industryId,
  });
  await db.insert(projects).values({
    id: projectId,
    orgId,
    clientId,
    name: projectName,
    slug: `intake-test-${randomUUID()}`,
    type: "voice_agent",
    stack: "custom_code",
    status: "building",
  });

  return {
    orgId,
    userId,
    clientId,
    clientName,
    industryId,
    industrySlug,
    projectId,
    projectName,
  };
}

export async function clearAgentRuns(orgId: string): Promise<void> {
  await db.delete(agentRuns).where(eq(agentRuns.orgId, orgId));
}

export async function cleanupIntakeHarness(h: IntakeHarness): Promise<void> {
  await db.delete(agentRuns).where(eq(agentRuns.orgId, h.orgId));
  await db.delete(projects).where(eq(projects.orgId, h.orgId));
  await db.delete(clients).where(eq(clients.orgId, h.orgId));
  await db.delete(industries).where(eq(industries.orgId, h.orgId));
  await db.delete(users).where(eq(users.orgId, h.orgId));
  await db.delete(organizations).where(eq(organizations.id, h.orgId));
}

/** Insert a bare agent_runs row (defaults: un-attributed intake run). */
export async function insertAgentRun(
  orgId: string,
  overrides: Partial<typeof agentRuns.$inferInsert> = {},
): Promise<string> {
  const id = overrides.id ?? randomUUID();
  await db.insert(agentRuns).values({
    orgId,
    agent: "project_intake",
    status: "succeeded",
    finishedAt: new Date(),
    model: "test-model",
    tokensIn: 100,
    tokensOut: 50,
    ...overrides,
    id,
  });
  return id;
}

/** A complete, valid draft for tests; override any field. */
export function makeDraft(overrides: Partial<ProjectDraft> = {}): ProjectDraft {
  const base: ProjectDraft = {
    name: "Reception voice agent",
    client: {
      match: "new",
      clientId: null,
      name: "Bright Smile Dental",
      industrySlug: "dental",
    },
    type: "voice_agent",
    stack: "custom_code",
    description: "An after-hours voice agent that books dental appointments.",
    retainerPenceMonthly: 150_000,
    buildFeePence: 400_000,
    hourlyRatePence: 3_000,
    goals: [{ metric: "bookings_created", target: 20, period: "week" }],
    suggestedEventTypes: ["call.completed", "booking.created"],
    assumptions: ["Assumed £1,500/mo retainer from the call."],
    ...overrides,
  };
  return base;
}
