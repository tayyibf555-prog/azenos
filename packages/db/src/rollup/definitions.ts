import { and, eq, isNull, or } from "drizzle-orm";
import type { Db } from "../client";
import { metricDefinitions } from "../schema/index";
import { toEvaluable, type EffectiveDefinition, type EvaluableDefinition } from "./metric-sql";

/**
 * Definition resolution shared by the rollup engine and the anomaly detector
 * (kept in its own module to avoid an engine↔anomaly import cycle).
 */

type Conn = Omit<Db, "$client">;

/** Effective set for a project: globals (project_id NULL) ∪ project overrides
 * by key (a project row with the same key wins). Sorted by `sort`. */
export async function resolveEffectiveDefinitions(
  conn: Conn,
  orgId: string,
  projectId: string,
): Promise<EffectiveDefinition[]> {
  const rows = await conn
    .select({
      key: metricDefinitions.key,
      name: metricDefinitions.name,
      unit: metricDefinitions.unit,
      aggregation: metricDefinitions.aggregation,
      eventType: metricDefinitions.eventType,
      valuePath: metricDefinitions.valuePath,
      whereEquals: metricDefinitions.whereEquals,
      goodDirection: metricDefinitions.goodDirection,
      isKpi: metricDefinitions.isKpi,
      sort: metricDefinitions.sort,
      projectId: metricDefinitions.projectId,
    })
    .from(metricDefinitions)
    .where(
      and(
        eq(metricDefinitions.orgId, orgId),
        or(
          eq(metricDefinitions.projectId, projectId),
          isNull(metricDefinitions.projectId),
        ),
      ),
    );

  const byKey = new Map<string, EffectiveDefinition>();
  for (const r of rows) {
    const existing = byKey.get(r.key);
    if (existing && r.projectId === null) continue; // keep the project override
    byKey.set(r.key, {
      key: r.key,
      name: r.name,
      unit: r.unit,
      aggregation: r.aggregation,
      eventType: r.eventType,
      valuePath: r.valuePath,
      whereEquals: r.whereEquals,
      goodDirection: r.goodDirection,
      isKpi: r.isKpi,
      sort: r.sort,
    });
  }
  return [...byKey.values()].sort((a, b) => a.sort - b.sort);
}

/** Drop definitions the SQL grammar can't evaluate (contract: console.warn). */
export function validateDefinitions(
  defs: EffectiveDefinition[],
): EvaluableDefinition[] {
  const out: EvaluableDefinition[] = [];
  for (const def of defs) {
    const ev = toEvaluable(def);
    if (ev === null) {
      console.warn(
        `[rollup] skipping invalid metric definition "${def.key}" (aggregation=${def.aggregation}, valuePath=${def.valuePath ?? "null"})`,
      );
      continue;
    }
    out.push(ev);
  }
  return out;
}
