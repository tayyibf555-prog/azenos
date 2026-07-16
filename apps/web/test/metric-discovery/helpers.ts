import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  clients,
  db,
  events,
  metricDefinitions,
  metricRollups,
  organizations,
  projects,
  rollupWatermarks,
} from "@azen/db";
import type { ProjectTypeKey } from "../../lib/tracking-presets";

/**
 * Throwaway-org fixtures for §P9-W0B metric-discovery tests. Mirrors
 * test/metrics-api/helpers.ts but lets the caller pick the project `type`,
 * since discovery's "core"/"missing" resolution is keyed off it.
 */

export async function createOrg(orgId: string): Promise<void> {
  await db.insert(organizations).values({ id: orgId, name: `W0B Test ${orgId.slice(0, 8)}` });
}

export async function createClient(orgId: string): Promise<string> {
  const id = randomUUID();
  await db.insert(clients).values({ id, orgId, name: `Client ${id.slice(0, 8)}`, status: "active" });
  return id;
}

export async function createProject(
  orgId: string,
  clientId: string,
  opts: { type?: ProjectTypeKey } = {},
): Promise<string> {
  const id = randomUUID();
  await db.insert(projects).values({
    id,
    orgId,
    clientId,
    name: `Project ${id.slice(0, 8)}`,
    slug: `w0b-${randomUUID()}`,
    type: opts.type ?? "ai_agent",
    stack: "custom_code",
    status: "live",
    health: "green",
  });
  return id;
}

export async function insertEvent(
  orgId: string,
  projectId: string,
  ev: {
    type: string;
    data?: Record<string, unknown>;
    valuePence?: number | null;
    minutesSaved?: number | null;
    occurredAt?: Date;
  },
): Promise<void> {
  await db.insert(events).values({
    orgId,
    projectId,
    type: ev.type,
    source: "sdk",
    idempotencyKey: `w0b:${randomUUID()}`,
    occurredAt: ev.occurredAt ?? new Date(),
    data: ev.data ?? {},
    valuePence: ev.valuePence ?? null,
    minutesSaved: ev.minutesSaved ?? null,
    raw: ev.data ?? {},
  });
}

export async function cleanupOrg(orgId: string): Promise<void> {
  await db.delete(events).where(eq(events.orgId, orgId));
  await db.delete(metricRollups).where(eq(metricRollups.orgId, orgId));
  await db.delete(rollupWatermarks).where(eq(rollupWatermarks.orgId, orgId));
  await db.delete(metricDefinitions).where(eq(metricDefinitions.orgId, orgId));
  await db.delete(projects).where(eq(projects.orgId, orgId));
  await db.delete(clients).where(eq(clients.orgId, orgId));
  await db.delete(organizations).where(eq(organizations.id, orgId));
}
