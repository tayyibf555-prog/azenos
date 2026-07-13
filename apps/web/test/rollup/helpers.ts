import { randomUUID } from "node:crypto";
import {
  clients,
  db,
  events,
  insights,
  metricDefinitions,
  metricRollups,
  organizations,
  projects,
  rollupWatermarks,
} from "@azen/db";
import { and, asc, eq, sql } from "drizzle-orm";

/**
 * Throwaway-org test hygiene (docs/phase1/CONTRACTS.md §Ground rules): every
 * test builds its own org/client/project with random ids and tears it all down
 * in afterEach. These tests NEVER read or mutate the demo org, and they build
 * their own metric definitions + events so they don't depend on seed values.
 */

export interface RollupHarness {
  orgId: string;
  clientId: string;
  projectId: string;
  projectName: string;
}

export async function createHarness(
  projectName = `Rollup Test ${randomUUID().slice(0, 8)}`,
): Promise<RollupHarness> {
  const orgId = randomUUID();
  const clientId = randomUUID();
  const projectId = randomUUID();

  await db.insert(organizations).values({ id: orgId, name: projectName });
  await db.insert(clients).values({
    id: clientId,
    orgId,
    name: "Rollup Test Client",
    status: "active",
  });
  await db.insert(projects).values({
    id: projectId,
    orgId,
    clientId,
    name: projectName,
    slug: `rollup-test-${randomUUID()}`,
    type: "ai_agent",
    stack: "custom_code",
    status: "live",
  });

  return { orgId, clientId, projectId, projectName };
}

export async function cleanupHarness(h: RollupHarness): Promise<void> {
  await db.delete(events).where(eq(events.orgId, h.orgId));
  await db.delete(insights).where(eq(insights.orgId, h.orgId));
  await db.delete(metricRollups).where(eq(metricRollups.orgId, h.orgId));
  await db.delete(rollupWatermarks).where(eq(rollupWatermarks.orgId, h.orgId));
  await db.delete(metricDefinitions).where(eq(metricDefinitions.orgId, h.orgId));
  await db.delete(projects).where(eq(projects.orgId, h.orgId));
  await db.delete(clients).where(eq(clients.orgId, h.orgId));
  await db.delete(organizations).where(eq(organizations.id, h.orgId));
}

export interface EventInput {
  type: string;
  occurredAt: string | Date;
  receivedAt?: string | Date;
  data?: Record<string, unknown>;
  valuePence?: number | null;
  minutesSaved?: number | null;
}

const toDate = (v: string | Date): Date => (v instanceof Date ? v : new Date(v));

export async function insertEvent(
  h: RollupHarness,
  ev: EventInput,
): Promise<void> {
  await db.insert(events).values({
    orgId: h.orgId,
    projectId: h.projectId,
    type: ev.type,
    source: "sdk",
    idempotencyKey: `test:${randomUUID()}`,
    occurredAt: toDate(ev.occurredAt),
    receivedAt: ev.receivedAt ? toDate(ev.receivedAt) : new Date(),
    data: ev.data ?? {},
    valuePence: ev.valuePence ?? null,
    minutesSaved: ev.minutesSaved ?? null,
    raw: ev.data ?? {},
  });
}

export interface DefInput {
  key: string;
  name?: string;
  aggregation: "count" | "sum" | "avg" | "p95" | "last" | "rate";
  eventType: string;
  unit?: "count" | "pence" | "minutes" | "percent" | "ms";
  valuePath?: string | null;
  whereEquals?: Record<string, string | number | boolean> | null;
  isKpi?: boolean;
  goodDirection?: "up" | "down";
  sort?: number;
  /** null = global default for the org; otherwise the harness project */
  projectScoped?: boolean;
}

export async function insertDef(
  h: RollupHarness,
  def: DefInput,
): Promise<void> {
  await db.insert(metricDefinitions).values({
    orgId: h.orgId,
    projectId: def.projectScoped ? h.projectId : null,
    key: def.key,
    name: def.name ?? def.key,
    aggregation: def.aggregation,
    eventType: def.eventType,
    unit: def.unit ?? "count",
    valuePath: def.valuePath ?? null,
    whereEquals: def.whereEquals ?? null,
    isKpi: def.isKpi ?? false,
    goodDirection: def.goodDirection ?? "up",
    sort: def.sort ?? 0,
  });
}

export interface RollupRow {
  metricKey: string;
  period: string;
  periodStart: string; // ISO
  value: number;
  sampleCount: number;
}

export async function readRollups(
  h: RollupHarness,
  period?: string,
): Promise<RollupRow[]> {
  const rows = await db
    .select({
      metricKey: metricRollups.metricKey,
      period: metricRollups.period,
      periodStart: metricRollups.periodStart,
      value: metricRollups.value,
      sampleCount: metricRollups.sampleCount,
    })
    .from(metricRollups)
    .where(
      period
        ? and(
            eq(metricRollups.projectId, h.projectId),
            eq(metricRollups.period, period as "hour" | "day" | "week" | "month"),
          )
        : eq(metricRollups.projectId, h.projectId),
    )
    .orderBy(
      asc(metricRollups.metricKey),
      asc(metricRollups.period),
      asc(metricRollups.periodStart),
    );
  return rows.map((r) => ({
    metricKey: r.metricKey,
    period: r.period,
    periodStart: r.periodStart.toISOString(),
    value: r.value,
    sampleCount: r.sampleCount,
  }));
}

/** All (metricKey → value) for one period+periodStart, for exact assertions. */
export async function rollupsAt(
  h: RollupHarness,
  period: string,
  periodStartIso: string,
): Promise<Map<string, RollupRow>> {
  const rows = await readRollups(h, period);
  const map = new Map<string, RollupRow>();
  for (const r of rows) {
    if (r.periodStart === new Date(periodStartIso).toISOString()) {
      map.set(r.metricKey, r);
    }
  }
  return map;
}

export async function readWatermark(h: RollupHarness): Promise<Date | null> {
  const [row] = await db
    .select({ pt: rollupWatermarks.processedThrough })
    .from(rollupWatermarks)
    .where(eq(rollupWatermarks.projectId, h.projectId))
    .limit(1);
  return row?.pt ?? null;
}

/**
 * London day-start UTC instants for `count` complete days ending yesterday,
 * computed by Postgres so they match the engine/anomaly boundaries exactly.
 * Index 0 = yesterday, index 1 = the day before, …
 */
export async function londonDayStartsUTC(count: number): Promise<string[]> {
  const rows = (await db.execute(sql`
    select to_char(
      (date_trunc('day', now() at time zone 'Europe/London') - make_interval(days => g)) at time zone 'Europe/London' at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS"Z"'
    ) as iso
    from generate_series(1, ${count}) g order by g
  `)) as unknown as { iso: string }[];
  return rows.map((r) => r.iso);
}

export async function insertRollupRow(
  h: RollupHarness,
  row: {
    metricKey: string;
    period: "hour" | "day" | "week" | "month";
    periodStartIso: string;
    value: number;
    sampleCount: number;
  },
): Promise<void> {
  await db.insert(metricRollups).values({
    orgId: h.orgId,
    projectId: h.projectId,
    metricKey: row.metricKey,
    period: row.period,
    periodStart: new Date(row.periodStartIso),
    value: row.value,
    sampleCount: row.sampleCount,
  });
}

export async function countAnomalies(h: RollupHarness): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int`.mapWith(Number) })
    .from(insights)
    .where(and(eq(insights.orgId, h.orgId), eq(insights.kind, "anomaly")));
  return row?.n ?? 0;
}
