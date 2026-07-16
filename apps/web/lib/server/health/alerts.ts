/**
 * Alert ack / resolve mutations (docs/phase8/CONTRACTS.md — P8-HEALTH). The
 * only UI-driven writes to alert_instances. Org-scoped; an id belonging to
 * another org (or already resolved, for ack) simply matches no row → null,
 * which the route maps to 404.
 */
import { alertInstances, db } from "@azen/db";
import { and, eq, isNull } from "drizzle-orm";

export type AlertAction = "ack" | "resolve";

export interface AlertMutationRow {
  id: string;
  ackedAt: string | null;
  resolvedAt: string | null;
}

export async function mutateAlert(
  orgId: string,
  id: string,
  action: AlertAction,
  now: Date = new Date(),
): Promise<AlertMutationRow | null> {
  const set =
    action === "ack" ? { ackedAt: now } : { resolvedAt: now };

  const rows = await db
    .update(alertInstances)
    .set(set)
    .where(
      and(
        eq(alertInstances.id, id),
        eq(alertInstances.orgId, orgId),
        // resolving is idempotent-safe, but acking an already-resolved alert is
        // meaningless — restrict ack to still-open rows.
        action === "ack" ? isNull(alertInstances.resolvedAt) : undefined,
      ),
    )
    .returning({
      id: alertInstances.id,
      ackedAt: alertInstances.ackedAt,
      resolvedAt: alertInstances.resolvedAt,
    });

  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    ackedAt: r.ackedAt ? r.ackedAt.toISOString() : null,
    resolvedAt: r.resolvedAt ? r.resolvedAt.toISOString() : null,
  };
}
