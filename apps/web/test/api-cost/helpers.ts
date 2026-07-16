import { randomUUID } from "node:crypto";
import {
  agentRuns,
  alertInstances,
  db,
  events,
  metricRollups,
  subscriptions,
} from "@azen/db";
import { eq } from "drizzle-orm";

type OsAgentKind = (typeof agentRuns.$inferInsert)["agent"];

/**
 * Shared inserters for the P9-COST tests. All rows are created under the
 * throwaway org id the money harness (test/money/helpers.ts) mints, and torn
 * down alongside it — the DEMO_ORG_ID is never touched.
 */

export interface InsertEventOpts {
  orgId: string;
  projectId: string;
  type: string;
  occurredAt: Date;
  data?: Record<string, unknown>;
  valuePence?: number | null;
  subject?: { kind: string; id?: string } | null;
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
    subject: o.subject ?? null,
    raw: {},
  });
}

export interface InsertAgentRunOpts {
  orgId: string;
  clientId: string;
  projectId: string | null;
  agent: OsAgentKind;
  startedAt: Date;
  costEstimatePence: number;
  tokensIn?: number;
  tokensOut?: number;
}

export async function insertAgentRun(o: InsertAgentRunOpts): Promise<void> {
  await db.insert(agentRuns).values({
    orgId: o.orgId,
    clientId: o.clientId,
    projectId: o.projectId,
    agent: o.agent,
    startedAt: o.startedAt,
    status: "succeeded",
    costEstimatePence: o.costEstimatePence,
    tokensIn: o.tokensIn ?? null,
    tokensOut: o.tokensOut ?? null,
  });
}

/**
 * Insert a client-system AI cost rollup (metric_rollups tokens_cost_pence, day).
 * This is the client-emitted stream that billing v2 bills WITH markup by default
 * (LEAD RULING 2026-07-16). Torn down with the project (onDelete cascade).
 */
export async function insertClientAiRollup(o: {
  orgId: string;
  projectId: string;
  periodStart: Date;
  pence: number;
}): Promise<void> {
  await db.insert(metricRollups).values({
    orgId: o.orgId,
    projectId: o.projectId,
    metricKey: "tokens_cost_pence",
    period: "day",
    periodStart: o.periodStart,
    value: o.pence,
    sampleCount: 1,
  });
}

/** Insert an active subscription (the retainer term of client margin). */
export async function insertSubscription(o: {
  orgId: string;
  clientId: string;
  amountPenceMonthly: number;
  startedAt?: string;
}): Promise<void> {
  await db.insert(subscriptions).values({
    orgId: o.orgId,
    clientId: o.clientId,
    amountPenceMonthly: o.amountPenceMonthly,
    status: "active",
    startedAt: o.startedAt ?? "2025-01-01",
  });
}

/** Remove any alert_instances the evaluator wrote for this org. */
export async function cleanupAlerts(orgId: string): Promise<void> {
  await db.delete(alertInstances).where(eq(alertInstances.orgId, orgId));
}
