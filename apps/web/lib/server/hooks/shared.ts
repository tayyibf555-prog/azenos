import {
  DEMO_ORG_ID,
  clients,
  db,
  projectIntegrations,
  projects,
  webhookDeliveries,
} from "@azen/db";
import { and, eq } from "drizzle-orm";

/**
 * Shared plumbing for the agency Stripe + Calendly hooks (§P4-HOOKS).
 *
 * These hooks are the ORG-LEVEL agency accounts — a single agency (Azen)
 * owns one Stripe account and one Calendly. The org is therefore a config
 * value, not something derived from the (attacker-controllable) payload:
 * `AZEN_AGENCY_ORG_ID` when set, else the seeded demo org. Tests point it at
 * a throwaway org so they never touch the demo data.
 */
export function resolveAgencyOrgId(): string {
  return process.env.AZEN_AGENCY_ORG_ID || DEMO_ORG_ID;
}

export interface ClientRoute {
  orgId: string;
  clientId: string;
  projectId: string | null;
}

export interface RouteHints {
  /** Stripe customer id (cus_…) → project_integrations lookup. */
  customerId?: string | null;
  /** metadata.azen_client_id — a clients.id in the agency org. */
  clientId?: string | null;
  /** metadata.azen_project_id — a projects.id in the agency org. */
  projectId?: string | null;
}

/**
 * Resolve the agency client an incoming agency payment/subscription belongs
 * to, strictly within `orgId`. Precedence: explicit project id → explicit
 * client id → the `project_integrations` mapping for the Stripe customer.
 * Returns null when nothing matches (caller skips + logs — payments.client_id
 * is NOT NULL, so an org-level orphan cannot be written; §P4-HOOKS).
 */
export async function resolveClientRoute(
  orgId: string,
  hints: RouteHints,
): Promise<ClientRoute | null> {
  if (hints.projectId) {
    const [row] = await db
      .select({ clientId: projects.clientId, id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, hints.projectId), eq(projects.orgId, orgId)));
    if (row) return { orgId, clientId: row.clientId, projectId: row.id };
  }
  if (hints.clientId) {
    const [row] = await db
      .select({ id: clients.id })
      .from(clients)
      .where(and(eq(clients.id, hints.clientId), eq(clients.orgId, orgId)));
    if (row) return { orgId, clientId: row.id, projectId: null };
  }
  if (hints.customerId) {
    const [row] = await db
      .select({ clientId: projects.clientId, projectId: projects.id })
      .from(projectIntegrations)
      .innerJoin(projects, eq(projectIntegrations.projectId, projects.id))
      .where(
        and(
          eq(projectIntegrations.orgId, orgId),
          eq(projectIntegrations.provider, "stripe"),
          eq(projectIntegrations.externalId, hints.customerId),
        ),
      );
    if (row) {
      return { orgId, clientId: row.clientId, projectId: row.projectId };
    }
  }
  return null;
}

export interface HookDeliveryRecord {
  orgId: string;
  status: "accepted" | "rejected";
  httpStatus: number;
  startedAt: number;
  error?: string | null;
  /** Persisted only when status is `rejected` (dead-letter). */
  raw?: unknown;
}

/**
 * One `webhook_deliveries` row per hook request — same table/shape as the
 * Phase 1 ingest delivery log. projectKeyId/eventId stay null (hook traffic
 * isn't project-key scoped and creates no `events` row). Best-effort: a log
 * failure must never fail the request.
 */
export async function recordHookDelivery(
  record: HookDeliveryRecord,
): Promise<void> {
  try {
    await db.insert(webhookDeliveries).values({
      orgId: record.orgId,
      projectKeyId: null,
      status: record.status,
      httpStatus: record.httpStatus,
      latencyMs: Math.max(0, Math.round(performance.now() - record.startedAt)),
      error: record.error ? record.error.slice(0, 500) : null,
      eventId: null,
      raw: record.status === "rejected" ? (record.raw ?? null) : null,
    });
  } catch (err) {
    console.error("[hooks] delivery log write failed:", err);
  }
}
