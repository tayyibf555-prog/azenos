import {
  alertRules,
  db,
  events,
  insights,
  projectKeys,
  runIncrementalRollupForProject,
} from "@azen/db";
import { and, desc, eq, gte, isNull, or, sql } from "drizzle-orm";
import { runAfterResponse } from "../after";
import { cleanupStaleWindows } from "./rate-limit";

/**
 * §6.3 step 6 reactions — everything here runs AFTER the response via
 * runAfterResponse: last_used_at stamp, stale rate-window cleanup, and
 * error_streak alert evaluation. WhatsApp delivery is Phase 3; the insights
 * row IS the Phase 1 artifact.
 */

export interface ReactionInput {
  keyId: string;
  orgId: string;
  projectId: string;
  projectName: string;
  insertedRows: { id: string; type: string }[];
  usedPostgresRateLimit: boolean;
}

export function scheduleIngestReactions(input: ReactionInput): void {
  runAfterResponse(async () => {
    await db
      .update(projectKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(projectKeys.id, input.keyId));
    if (input.usedPostgresRateLimit) await cleanupStaleWindows();
    if (input.insertedRows.some((r) => r.type === "system.error")) {
      await evaluateErrorStreaks(input);
    }
    // Phase 2 (M1): keep metric_rollups current for this project. Insert-only,
    // best-effort — a rollup failure must never break ingest.
    try {
      await runIncrementalRollupForProject(db, input.orgId, input.projectId);
    } catch (err) {
      console.error("[ingest] incremental rollup failed", err);
    }
  });
}

interface ErrorStreakCondition {
  event_type?: unknown;
  count?: unknown;
  window_minutes?: unknown;
}

async function evaluateErrorStreaks(input: ReactionInput): Promise<void> {
  const rules = await db
    .select()
    .from(alertRules)
    .where(
      and(
        eq(alertRules.orgId, input.orgId),
        eq(alertRules.kind, "error_streak"),
        eq(alertRules.enabled, true),
        or(
          eq(alertRules.projectId, input.projectId),
          isNull(alertRules.projectId),
        ),
      ),
    );

  const now = Date.now();
  for (const rule of rules) {
    if (
      rule.lastFiredAt &&
      now - rule.lastFiredAt.getTime() < rule.cooldownMinutes * 60_000
    ) {
      continue;
    }
    const condition = rule.condition as ErrorStreakCondition;
    const eventType =
      typeof condition.event_type === "string"
        ? condition.event_type
        : "system.error";
    const threshold =
      typeof condition.count === "number" ? condition.count : 3;
    const windowMinutes =
      typeof condition.window_minutes === "number"
        ? condition.window_minutes
        : 30;

    const matches = await db
      .select({
        id: events.id,
        message: sql<string | null>`${events.data}->>'message'`,
        total: sql<number>`count(*) over ()`.mapWith(Number),
      })
      .from(events)
      .where(
        and(
          eq(events.orgId, input.orgId),
          eq(events.projectId, input.projectId),
          eq(events.type, eventType),
          gte(events.occurredAt, new Date(now - windowMinutes * 60_000)),
        ),
      )
      .orderBy(desc(events.occurredAt))
      .limit(50);

    const total = matches[0]?.total ?? 0;
    if (total < threshold) continue;

    const latestMessages = matches
      .slice(0, 3)
      .map((m) => m.message)
      .filter((m): m is string => Boolean(m))
      .map((m) => `- ${m.slice(0, 200)}`);
    await db.insert(insights).values({
      orgId: input.orgId,
      projectId: input.projectId,
      kind: "anomaly",
      title: `${input.projectName}: ${total} ${eventType} events in ${windowMinutes}m`,
      bodyMd:
        latestMessages.length > 0
          ? `Latest messages:\n${latestMessages.join("\n")}`
          : "No message payloads on the matching events.",
      evidence: { event_ids: matches.map((m) => m.id) },
      confidence: "high",
      status: "new",
      createdBy: "agent",
    });
    await db
      .update(alertRules)
      .set({ lastFiredAt: new Date() })
      .where(eq(alertRules.id, rule.id));
  }
}
