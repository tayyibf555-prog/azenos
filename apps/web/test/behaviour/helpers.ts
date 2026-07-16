import { randomUUID } from "node:crypto";
import { db, events } from "@azen/db";

/**
 * Throwaway-org fixtures for the P9-PACK2 "behaviour depth" additive-block
 * tests (docs/phase9/CONTRACTS.md — engagement retention/channel-shift,
 * funnel stage percentiles/drop-off intents, conversations FCR/escalation
 * clusters/sentiment-by-topic). Thin wrapper around a direct `events` insert
 * so a caller can set `subject` (id-bearing, for cross-stage / cohort
 * matching) independently of the metrics-api helpers' `insertEvent` (which
 * never sets `subject`). Org/client/project creation + cleanup reuse
 * test/metrics-api/helpers.ts — nothing here touches the demo org.
 */
export async function insertBehaviourEvent(
  orgId: string,
  projectId: string,
  input: {
    type: string;
    occurredAt: Date;
    subjectId?: string;
    data?: Record<string, unknown>;
  },
): Promise<string> {
  const id = randomUUID();
  await db.insert(events).values({
    id,
    orgId,
    projectId,
    type: input.type,
    source: "sdk",
    idempotencyKey: `test:behaviour:${id}`,
    occurredAt: input.occurredAt,
    subject: input.subjectId ? { kind: "customer", id: input.subjectId } : undefined,
    data: input.data ?? {},
    raw: {},
  });
  return id;
}

/** Add whole hours to a Date (used to build sub-day, real per-entity deltas). */
export function addHours(date: Date, hours: number): Date {
  return new Date(date.getTime() + hours * 3600 * 1000);
}
