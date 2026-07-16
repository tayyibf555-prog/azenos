import { and, eq, sql } from "drizzle-orm";
import { db, projects } from "@azen/db";
import {
  METRIC_CATALOG,
  coreTemplatesForPlanTypes,
  matchGroup,
  type DiscoveredMetric,
  type EventTypeSignal,
} from "../metric-catalog";
import {
  coveragePlan,
  getTrackingPlan,
  type CoverageItem,
} from "../tracking-presets";
import { getProjectMetrics, type MetricDefinitionView } from "./queries";

/**
 * Metric discovery (Phase 9 §P9-W0B). Combines:
 *  - core:      the metric templates a project of this TYPE is expected to
 *               want (per lib/tracking-presets TRACKING_PRESETS), regardless
 *               of whether data or a metric_definitions row exists yet;
 *  - enabled:   the project's EXISTING effective metric definitions (global
 *               defaults ∪ project-custom ∪ the 3 always-on derived ratios) —
 *               reused verbatim from queries.getProjectMetrics, no new query;
 *  - available: METRIC_CATALOG templates whose triggering signal is present
 *               in this project's own events (ONE scan), minus anything
 *               already enabled (by key);
 *  - missing:   tracking-plan types the project's preset expects but has
 *               never sent — reuses the pure coveragePlan() unchanged.
 */
export interface MetricDiscoveryResult {
  core: DiscoveredMetric[];
  enabled: MetricDefinitionView[];
  available: DiscoveredMetric[];
  missing: CoverageItem[];
}

interface ScanRow {
  type: string;
  cnt: number;
  has_value_pence: boolean;
  has_minutes_saved: boolean;
}

/**
 * ONE scan of this project's events: distinct type + bool aggregates of
 * value_pence/minutes_saved presence (contract: "select distinct type +
 * bool aggregates ... from ONE scan"). Never touches raw event data beyond
 * that — discovery is presence-only, not a data export.
 */
async function scanEventSignals(
  orgId: string,
  projectId: string,
): Promise<Map<string, EventTypeSignal>> {
  const rows = (await db.execute(sql`
    select
      type,
      count(*)::int as cnt,
      bool_or(value_pence is not null) as has_value_pence,
      bool_or(minutes_saved is not null) as has_minutes_saved
    from events
    where org_id = ${orgId}::uuid
      and project_id = ${projectId}::uuid
    group by type
  `)) as unknown as ScanRow[];

  const out = new Map<string, EventTypeSignal>();
  for (const r of rows) {
    out.set(r.type, {
      type: r.type,
      count: Number(r.cnt),
      hasValuePence: Boolean(r.has_value_pence),
      hasMinutesSaved: Boolean(r.has_minutes_saved),
    });
  }
  return out;
}

async function getProjectType(orgId: string, projectId: string): Promise<string> {
  const [row] = await db
    .select({ type: projects.type })
    .from(projects)
    .where(and(eq(projects.orgId, orgId), eq(projects.id, projectId)))
    .limit(1);
  return row?.type ?? "custom";
}

export async function discoverMetrics(
  orgId: string,
  projectId: string,
): Promise<MetricDiscoveryResult> {
  const [signals, projectType, { definitions: enabled }] = await Promise.all([
    scanEventSignals(orgId, projectId),
    getProjectType(orgId, projectId),
    getProjectMetrics(orgId, projectId),
  ]);

  const enabledKeys = new Set(enabled.map((d) => d.key));

  const available: DiscoveredMetric[] = [];
  const seenAvailable = new Set<string>();
  for (const group of METRIC_CATALOG) {
    const matched = matchGroup(group, signals);
    if (!matched) continue;
    for (const tpl of group.templates) {
      if (enabledKeys.has(tpl.key) || seenAvailable.has(tpl.key)) continue;
      seenAvailable.add(tpl.key);
      available.push({ ...tpl, groupId: group.id, why: matched.why });
    }
  }

  const plan = getTrackingPlan(projectType);
  const coverage = coveragePlan(plan, new Set(signals.keys()));
  const missing = coverage.items.filter((i) => !i.present);

  const planTypes = new Set<string>([...plan.required, ...plan.recommended]);
  const core = coreTemplatesForPlanTypes(planTypes);

  return { core, enabled, available, missing };
}
