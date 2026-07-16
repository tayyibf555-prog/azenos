import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  clients,
  db,
  industries,
  metricRollups,
  organizations,
  projects,
} from "@azen/db";

/**
 * Throwaway-org fixtures for the §P8-BENCH benchmark tests (docs/phase8). Every
 * row hangs off a caller-supplied random org id and is removed in cleanupOrg;
 * DEMO_ORG_ID is never touched (ground rules). Day rollups are inserted directly
 * so each test hand-computes every expected percentile.
 */

export async function createOrg(orgId: string): Promise<void> {
  await db.insert(organizations).values({ id: orgId, name: `Bench ${orgId.slice(0, 8)}` });
}

export async function createIndustry(
  orgId: string,
  name = "Dental",
): Promise<string> {
  const id = randomUUID();
  await db.insert(industries).values({
    id,
    orgId,
    slug: `bench-${randomUUID()}`,
    name,
  });
  return id;
}

export async function createClient(
  orgId: string,
  opts: { industryId?: string | null; name?: string } = {},
): Promise<string> {
  const id = randomUUID();
  await db.insert(clients).values({
    id,
    orgId,
    name: opts.name ?? `Client ${id.slice(0, 8)}`,
    industryId: opts.industryId ?? null,
    status: "active",
  });
  return id;
}

export async function createLiveProject(
  orgId: string,
  clientId: string,
  opts: { status?: "live" | "paused" | "scoping" } = {},
): Promise<string> {
  const id = randomUUID();
  await db.insert(projects).values({
    id,
    orgId,
    clientId,
    name: `Project ${id.slice(0, 8)}`,
    slug: `bench-${randomUUID()}`,
    type: "ai_agent",
    stack: "custom_code",
    status: opts.status ?? "live",
    health: "green",
  });
  return id;
}

/** Insert a single day rollup bucket (value = the metric's day total). */
export async function insertDayRollup(
  orgId: string,
  projectId: string,
  metricKey: string,
  periodStart: Date,
  value: number,
): Promise<void> {
  await db.insert(metricRollups).values({
    orgId,
    projectId,
    metricKey,
    period: "day",
    periodStart,
    value,
    sampleCount: 1,
  });
}

export async function cleanupOrg(orgId: string): Promise<void> {
  await db.delete(metricRollups).where(eq(metricRollups.orgId, orgId));
  await db.delete(projects).where(eq(projects.orgId, orgId));
  await db.delete(clients).where(eq(clients.orgId, orgId));
  await db.delete(industries).where(eq(industries.orgId, orgId));
  await db.delete(organizations).where(eq(organizations.id, orgId));
}
