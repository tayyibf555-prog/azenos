import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, events, feedbackItems } from "@azen/db";

/**
 * Throwaway-org fixtures for the Feedback analytics tests (docs/phase7/PLAN.md
 * §B2). A `feedback_items` row requires a real `events` row (the FK the mirror
 * relationship is built on, same shape the public webhook writes in production
 * — see apps/web/lib/server/feedback/intake.ts), so `insertFeedbackItem` writes
 * both, always hung off a caller-supplied random org id. Never touches the
 * demo org.
 */

export interface FeedbackItemInput {
  id?: string;
  kind: "bug" | "feature" | "question" | "praise" | "other";
  message?: string;
  severity?: number | null;
  status?: "new" | "seen" | "planned" | "done";
  submitterName?: string | null;
  submitterEmail?: string | null;
  pageUrl?: string | null;
  createdAt: Date;
}

export async function insertFeedbackItem(
  orgId: string,
  projectId: string,
  input: FeedbackItemInput,
): Promise<string> {
  const id = input.id ?? randomUUID();
  const eventId = randomUUID();
  await db.insert(events).values({
    id: eventId,
    orgId,
    projectId,
    type: "feedback.submitted",
    source: "feedback",
    idempotencyKey: `test:feedback:${eventId}`,
    occurredAt: input.createdAt,
    receivedAt: input.createdAt,
    data: { kind: input.kind, message: input.message ?? "test feedback" },
    raw: {},
  });
  await db.insert(feedbackItems).values({
    id,
    orgId,
    projectId,
    eventId,
    kind: input.kind,
    message: input.message ?? "test feedback",
    severity: input.severity ?? null,
    status: input.status ?? "new",
    submitterName: input.submitterName ?? null,
    submitterEmail: input.submitterEmail ?? null,
    pageUrl: input.pageUrl ?? null,
    createdAt: input.createdAt,
  });
  return id;
}

export async function cleanupFeedbackAnalytics(orgId: string): Promise<void> {
  await db.delete(feedbackItems).where(eq(feedbackItems.orgId, orgId));
  await db.delete(events).where(eq(events.orgId, orgId));
}
