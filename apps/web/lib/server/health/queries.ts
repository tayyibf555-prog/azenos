/**
 * Read-only Health Center queries (docs/phase8/CONTRACTS.md — P8-HEALTH).
 * The grid re-derives every cell from the SAME numbers the evaluator judges
 * (loadProjectHealthInputs + the pure checks) so the screen never drifts from
 * the last evaluate run's logic; the open-alert list reads alert_instances.
 * Nothing here writes.
 */
import { alertInstances, clients, db, projects } from "@azen/db";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import {
  type CellState,
  type CheckResult,
  type HealthBadge,
  type HealthColumn,
  COLUMNS,
  columnStates,
  deriveHealth,
  evaluateChecks,
} from "./checks";
import { loadProjectHealthInputs } from "./evaluate";

export interface HealthGridProject {
  projectId: string;
  projectName: string;
  slug: string;
  health: HealthBadge;
  columns: Record<HealthColumn, CellState>;
  /** Per-check message, keyed by column, for cell tooltips. */
  cells: Record<HealthColumn, { state: CellState; message: string }[]>;
  openAlerts: number;
}

export interface HealthGridClient {
  clientId: string;
  clientName: string;
  projects: HealthGridProject[];
}

export interface HealthGrid {
  clients: HealthGridClient[];
  totals: { green: number; amber: number; red: number };
  /** Live projects whose freshness column is critical (silent). */
  silentProjects: number;
  columns: readonly HealthColumn[];
}

function cellsByColumn(
  results: CheckResult[],
): Record<HealthColumn, { state: CellState; message: string }[]> {
  const out = {} as Record<HealthColumn, { state: CellState; message: string }[]>;
  for (const col of COLUMNS) out[col] = [];
  for (const r of results) out[r.column].push({ state: r.state, message: r.message });
  return out;
}

export async function getHealthGrid(
  orgId: string,
  now: Date = new Date(),
): Promise<HealthGrid> {
  const [inputs, meta, openCounts] = await Promise.all([
    loadProjectHealthInputs(orgId, now),
    db
      .select({
        projectId: projects.id,
        projectName: projects.name,
        slug: projects.slug,
        clientId: projects.clientId,
        clientName: clients.name,
      })
      .from(projects)
      .innerJoin(clients, eq(clients.id, projects.clientId))
      .where(and(eq(projects.orgId, orgId), eq(projects.status, "live"))),
    db
      .select({
        projectId: alertInstances.projectId,
        n: sql<number>`count(*)::int`,
      })
      .from(alertInstances)
      .where(
        and(
          eq(alertInstances.orgId, orgId),
          isNull(alertInstances.resolvedAt),
          sql`${alertInstances.evidence}->>'source' = 'health'`,
        ),
      )
      .groupBy(alertInstances.projectId),
  ]);

  const inputByProject = new Map(inputs.map((i) => [i.projectId, i]));
  const openByProject = new Map<string, number>();
  for (const r of openCounts) {
    if (r.projectId) openByProject.set(r.projectId, Number(r.n));
  }

  const byClient = new Map<string, HealthGridClient>();
  const totals = { green: 0, amber: 0, red: 0 };
  let silentProjects = 0;

  for (const m of meta) {
    const input = inputByProject.get(m.projectId);
    if (!input) continue;
    const results = evaluateChecks(input, now);
    const columns = columnStates(results);
    const health = deriveHealth(results);
    totals[health] += 1;
    if (columns.freshness === "critical") silentProjects += 1;

    const project: HealthGridProject = {
      projectId: m.projectId,
      projectName: m.projectName,
      slug: m.slug,
      health,
      columns,
      cells: cellsByColumn(results),
      openAlerts: openByProject.get(m.projectId) ?? 0,
    };

    let bucket = byClient.get(m.clientId);
    if (!bucket) {
      bucket = { clientId: m.clientId, clientName: m.clientName, projects: [] };
      byClient.set(m.clientId, bucket);
    }
    bucket.projects.push(project);
  }

  const clientList = [...byClient.values()].sort((a, b) =>
    a.clientName.localeCompare(b.clientName),
  );
  for (const c of clientList) {
    c.projects.sort((a, b) => a.projectName.localeCompare(b.projectName));
  }

  return {
    clients: clientList,
    totals,
    silentProjects,
    columns: COLUMNS,
  };
}

export interface OpenAlert {
  id: string;
  projectId: string | null;
  projectName: string | null;
  clientName: string | null;
  kind: string;
  severity: "info" | "warn" | "critical";
  message: string;
  check: string | null;
  firedAt: string;
  ackedAt: string | null;
  escalated: boolean;
}

/** Open (unresolved) health alert_instances, most-severe + newest first. */
export async function listOpenAlerts(orgId: string): Promise<OpenAlert[]> {
  const rows = await db
    .select({
      id: alertInstances.id,
      projectId: alertInstances.projectId,
      projectName: projects.name,
      clientName: clients.name,
      kind: alertInstances.kind,
      severity: alertInstances.severity,
      message: alertInstances.message,
      evidence: alertInstances.evidence,
      firedAt: alertInstances.firedAt,
      ackedAt: alertInstances.ackedAt,
    })
    .from(alertInstances)
    .leftJoin(projects, eq(projects.id, alertInstances.projectId))
    .leftJoin(clients, eq(clients.id, projects.clientId))
    .where(
      and(
        eq(alertInstances.orgId, orgId),
        isNull(alertInstances.resolvedAt),
        sql`${alertInstances.evidence}->>'source' = 'health'`,
      ),
    )
    .orderBy(
      sql`case ${alertInstances.severity} when 'critical' then 0 when 'warn' then 1 else 2 end`,
      desc(alertInstances.firedAt),
    );

  return rows.map((r) => {
    const check = r.evidence["check"];
    return {
      id: r.id,
      projectId: r.projectId,
      projectName: r.projectName,
      clientName: r.clientName,
      kind: r.kind,
      severity: r.severity,
      message: r.message,
      check: typeof check === "string" ? check : null,
      firedAt: r.firedAt.toISOString(),
      ackedAt: r.ackedAt ? r.ackedAt.toISOString() : null,
      escalated: Object.prototype.hasOwnProperty.call(r.evidence, "escalated_at"),
    };
  });
}

/** Whether any critical health alert is currently unacked (banner heuristic). */
export async function hasUnackedCritical(orgId: string): Promise<boolean> {
  const rows = await db
    .select({ id: alertInstances.id })
    .from(alertInstances)
    .where(
      and(
        eq(alertInstances.orgId, orgId),
        eq(alertInstances.severity, "critical"),
        isNull(alertInstances.resolvedAt),
        isNull(alertInstances.ackedAt),
        sql`${alertInstances.evidence}->>'source' = 'health'`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}
