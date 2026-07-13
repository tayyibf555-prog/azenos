import { sql } from "drizzle-orm";
import type { Db } from "../client";
import { insights } from "../schema/index";
import { resolveEffectiveDefinitions } from "./definitions";
import { isoUTC } from "./metric-sql";

/**
 * Cheap, non-AI anomaly detection (spec §8.4, docs/phase2/CONTRACTS.md). For
 * each KPI, compare the latest COMPLETE London day (yesterday) against the
 * trailing 28 complete days' rollup values; |z| ≥ 2.5 with enough history
 * writes one `anomaly` insight — deduped on the open anomaly per metric.
 */

const MIN_SAMPLES = 8;
const Z_THRESHOLD = 2.5;

const round2 = (n: number): number => Math.round(n * 100) / 100;

// London day boundaries as UTC instants (DST-correct via Postgres). Yesterday
// is the most recent COMPLETE day; the trailing window is the 28 days before it.
const yesterdayStartSQL = sql`(date_trunc('day', now() at time zone 'Europe/London') - interval '1 day') at time zone 'Europe/London'`;
const windowStartSQL = sql`(date_trunc('day', now() at time zone 'Europe/London') - interval '29 days') at time zone 'Europe/London'`;

interface Bounds {
  name: string;
  yIso: string;
  wIso: string;
}

interface Stats {
  y: number | null;
  mean: number | null;
  std: number | null;
  n: number;
}

const num = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v);

/**
 * @returns the number of anomaly insights written this run.
 */
export async function detectAnomaliesForProject(
  db: Db,
  orgId: string,
  projectId: string,
): Promise<number> {
  const kpis = (await resolveEffectiveDefinitions(db, orgId, projectId)).filter(
    (d) => d.isKpi,
  );
  if (kpis.length === 0) return 0;

  const boundsRows = (await db.execute(sql`
    select p.name as name, ${isoUTC(yesterdayStartSQL)} as y_iso, ${isoUTC(windowStartSQL)} as w_iso
    from projects p where p.id = ${projectId}::uuid
  `)) as unknown as { name: string; y_iso: string; w_iso: string }[];
  const b = boundsRows[0];
  if (!b) return 0;
  const bounds: Bounds = { name: b.name, yIso: b.y_iso, wIso: b.w_iso };

  let created = 0;
  for (const def of kpis) {
    const rows = (await db.execute(sql`
      select
        (select value from metric_rollups where project_id = ${projectId}::uuid and metric_key = ${def.key} and period = 'day' and period_start = ${bounds.yIso}::timestamptz) as y,
        (select avg(value) from metric_rollups where project_id = ${projectId}::uuid and metric_key = ${def.key} and period = 'day' and period_start >= ${bounds.wIso}::timestamptz and period_start < ${bounds.yIso}::timestamptz) as mean,
        (select stddev_samp(value) from metric_rollups where project_id = ${projectId}::uuid and metric_key = ${def.key} and period = 'day' and period_start >= ${bounds.wIso}::timestamptz and period_start < ${bounds.yIso}::timestamptz) as std,
        (select count(*)::int from metric_rollups where project_id = ${projectId}::uuid and metric_key = ${def.key} and period = 'day' and period_start >= ${bounds.wIso}::timestamptz and period_start < ${bounds.yIso}::timestamptz) as n
    `)) as unknown as { y: unknown; mean: unknown; std: unknown; n: unknown }[];

    const s: Stats = {
      y: num(rows[0]?.y),
      mean: num(rows[0]?.mean),
      std: num(rows[0]?.std),
      n: Number(rows[0]?.n ?? 0),
    };
    // Need a value yesterday, ≥8 samples, and non-degenerate spread.
    if (s.y === null || s.mean === null || s.std === null) continue;
    if (s.n < MIN_SAMPLES || s.std <= 0) continue;

    const z = (s.y - s.mean) / s.std;
    if (Math.abs(z) < Z_THRESHOLD) continue;

    const existing = (await db.execute(sql`
      select 1 as x from insights
      where project_id = ${projectId}::uuid and kind = 'anomaly' and status = 'new'
        and evidence->>'metric_key' = ${def.key}
      limit 1
    `)) as unknown as { x: number }[];
    if (existing.length > 0) continue;

    const direction = z > 0 ? "up" : "down";
    await db.insert(insights).values({
      orgId,
      projectId,
      kind: "anomaly",
      title: `${bounds.name}: ${def.name} ${direction} vs 28-day normal`,
      bodyMd: `Yesterday's ${def.name.toLowerCase()} was ${round2(s.y)} vs a 28-day mean of ${round2(s.mean)} (σ ${round2(s.std)}) — a z-score of ${round2(z)}.`,
      evidence: {
        metric_key: def.key,
        period_start: bounds.yIso,
        value: s.y,
        mean: round2(s.mean),
        std: round2(s.std),
        z: round2(z),
      },
      confidence: "med",
      status: "new",
      createdBy: "agent",
    });
    created += 1;
  }

  return created;
}
