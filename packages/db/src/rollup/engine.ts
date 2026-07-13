import { and, eq, sql, type SQL } from "drizzle-orm";
import type { Db } from "../client";
import { projects } from "../schema/index";
import { detectAnomaliesForProject } from "./anomaly";
import { resolveEffectiveDefinitions, validateDefinitions } from "./definitions";
import {
  aggregateValueSQL,
  bucketStartSQL,
  isoUTC,
  isoUTCMicros,
  periodEndSQL,
  ROLLUP_PERIODS,
  type EvaluableDefinition,
  type RollupPeriod,
} from "./metric-sql";

/**
 * Incremental, idempotent, late-event-proof metric rollups
 * (docs/phase2/CONTRACTS.md §Rollup engine, spec §8/§13). The ONLY write path
 * into metric_rollups. Aggregation is done entirely in Postgres — no per-event
 * JS loops; the only JS iteration is per affected bucket-period × definition.
 */

const MAX_BUCKETS_PER_RUN = 500;
// One event touches at most 4 buckets (hour/day/week/month), so bounding a
// pass to ~125 events guarantees the ≤500-bucket cap without a distinct count.
const MAX_EVENTS_PER_PASS = Math.floor(MAX_BUCKETS_PER_RUN / 4);
const FORCE_WINDOW_DAYS_DEFAULT = 90;
// Safety stop for the drain loop; a real backlog needs far fewer passes.
const MAX_PASSES = 100_000;
const EPOCH_ISO = "1970-01-01T00:00:00.000000Z";

/** db handle or a transaction — PgTransaction lacks the driver's $client. */
type Conn = Omit<Db, "$client">;

type AffectedBuckets = Map<RollupPeriod, string[]>;

export interface RollupOptions {
  orgId?: string;
  projectId?: string;
  /** ignore the watermark and recompute a trailing window (default 90 days) */
  force?: boolean;
  /** window for force mode; M2 scopes this (e.g. 30 days after a def edit) */
  forceWindowDays?: number;
}

export interface RollupRunSummary {
  projects: number;
  passes: number;
  bucketsRecomputed: number;
  anomaliesCreated: number;
}

interface ProjectTarget {
  id: string;
  orgId: string;
  name: string;
}

// ── affected-bucket discovery ────────────────────────────────────────────────

async function affectedBuckets(conn: Conn, scope: SQL): Promise<AffectedBuckets> {
  const unions = ROLLUP_PERIODS.map(
    (p) =>
      sql`select ${p}::text as period, ${isoUTC(bucketStartSQL(p))} as ps from events e where ${scope}`,
  );
  const rows = (await conn.execute(
    sql`select distinct period, ps from (${sql.join(unions, sql` union all `)}) u`,
  )) as unknown as { period: RollupPeriod; ps: string }[];

  const map: AffectedBuckets = new Map();
  for (const p of ROLLUP_PERIODS) map.set(p, []);
  for (const r of rows) map.get(r.period)!.push(r.ps);
  return map;
}

function totalBuckets(affected: AffectedBuckets): number {
  let n = 0;
  for (const list of affected.values()) n += list.length;
  return n;
}

// ── watermark ────────────────────────────────────────────────────────────────

async function getWatermarkIso(conn: Conn, projectId: string): Promise<string> {
  const rows = (await conn.execute(
    sql`select ${isoUTCMicros(sql`processed_through`)} as iso from rollup_watermarks where project_id = ${projectId}::uuid`,
  )) as unknown as { iso: string }[];
  return rows[0]?.iso ?? EPOCH_ISO;
}

async function advanceWatermark(
  conn: Conn,
  projectId: string,
  orgId: string,
  cutoffIso: string,
): Promise<void> {
  // cutoffIso stays a string all the way to the DB — a JS Date would truncate
  // received_at's microseconds and could stall the drain loop's progress.
  await conn.execute(sql`
    insert into rollup_watermarks (project_id, org_id, processed_through, updated_at)
    values (${projectId}::uuid, ${orgId}::uuid, ${cutoffIso}::timestamptz, now())
    on conflict (project_id) do update set processed_through = excluded.processed_through, updated_at = now()
  `);
}

// ── recompute (delete-then-insert per affected bucket set, one transaction) ───

async function recomputeAffected(
  tx: Conn,
  orgId: string,
  projectId: string,
  defs: EvaluableDefinition[],
  affected: AffectedBuckets,
): Promise<void> {
  for (const period of ROLLUP_PERIODS) {
    const buckets = affected.get(period)!;
    if (buckets.length === 0) continue;

    const sorted = [...buckets].sort();
    const minIso = sorted[0]!;
    const maxIso = sorted[sorted.length - 1]!;
    const inList = sql.join(
      sorted.map((iso) => sql`${iso}::timestamptz`),
      sql`, `,
    );

    await tx.execute(
      sql`delete from metric_rollups where project_id = ${projectId}::uuid and period = ${period}::rollup_period and period_start in (${inList})`,
    );

    for (const def of defs) {
      const valued = def.value !== null;
      const v = valued ? def.value! : sql`null::numeric`;
      let where = sql`e.project_id = ${projectId}::uuid and e.occurred_at >= ${minIso}::timestamptz and e.occurred_at < ${periodEndSQL(period, maxIso)}`;
      if (def.eventType !== "*") where = sql`${where} and e.type = ${def.eventType}`;
      for (const c of def.where) where = sql`${where} and ${c}`;
      if (valued) where = sql`${where} and (${def.value!}) is not null`;

      const inner = sql`select ${bucketStartSQL(period)} as bucket, ${v} as v, e.occurred_at as occ, e.id as id from events e where ${where}`;
      await tx.execute(sql`
        insert into metric_rollups (org_id, project_id, metric_key, period, period_start, value, sample_count)
        select ${orgId}::uuid, ${projectId}::uuid, ${def.key}::text, ${period}::rollup_period, bucket, ${aggregateValueSQL(def.aggregation)}, count(*)::int
        from (${inner}) sub
        where bucket in (${inList})
        group by bucket
      `);
    }
  }
}

// ── incremental pass (one bounded, watermark-advancing step) ─────────────────

interface PassResult {
  caughtUp: boolean;
  dayChanged: boolean;
  buckets: number;
}

async function incrementalPass(
  db: Conn,
  target: ProjectTarget,
  defs: EvaluableDefinition[],
): Promise<PassResult> {
  const proj = target.id;
  const wmIso = await getWatermarkIso(db, proj);
  const nowIso = new Date().toISOString();

  const n = await countEvents(
    db,
    sql`e.project_id = ${proj}::uuid and e.received_at > ${wmIso}::timestamptz and e.received_at <= ${nowIso}::timestamptz`,
  );
  if (n === 0) {
    await advanceWatermark(db, proj, target.orgId, nowIso);
    return { caughtUp: true, dayChanged: false, buckets: 0 };
  }

  let cutoffIso = nowIso;
  let caughtUp = true;
  if (n > MAX_EVENTS_PER_PASS) {
    const c = await receivedAtAtOffset(db, proj, wmIso, nowIso, MAX_EVENTS_PER_PASS - 1);
    if (c) {
      cutoffIso = c;
      caughtUp = false;
    }
  }

  const affected = await affectedBuckets(
    db,
    sql`e.project_id = ${proj}::uuid and e.received_at > ${wmIso}::timestamptz and e.received_at <= ${cutoffIso}::timestamptz`,
  );
  const dayChanged = affected.get("day")!.length > 0;
  const buckets = totalBuckets(affected);

  await db.transaction(async (tx) => {
    await recomputeAffected(tx, target.orgId, proj, defs, affected);
    await advanceWatermark(tx, proj, target.orgId, cutoffIso);
  });

  return { caughtUp, dayChanged, buckets };
}

async function countEvents(conn: Conn, scope: SQL): Promise<number> {
  const rows = (await conn.execute(
    sql`select count(*)::int as n from events e where ${scope}`,
  )) as unknown as { n: number }[];
  return Number(rows[0]?.n ?? 0);
}

async function receivedAtAtOffset(
  conn: Conn,
  projectId: string,
  wmIso: string,
  nowIso: string,
  offset: number,
): Promise<string | null> {
  const rows = (await conn.execute(
    sql`select ${isoUTCMicros(sql`e.received_at`)} as iso from events e
        where e.project_id = ${projectId}::uuid and e.received_at > ${wmIso}::timestamptz and e.received_at <= ${nowIso}::timestamptz
        order by e.received_at asc offset ${offset} limit 1`,
  )) as unknown as { iso: string }[];
  return rows[0]?.iso ?? null;
}

// ── force recompute (ignore watermark; recompute a trailing window) ──────────

async function forceProject(
  db: Conn,
  target: ProjectTarget,
  defs: EvaluableDefinition[],
  windowDays: number,
): Promise<PassResult> {
  const sinceIso = new Date(Date.now() - windowDays * 86_400_000).toISOString();
  const affected = await affectedBuckets(
    db,
    sql`e.project_id = ${target.id}::uuid and e.occurred_at >= ${sinceIso}::timestamptz`,
  );
  const dayChanged = affected.get("day")!.length > 0;
  const buckets = totalBuckets(affected);

  // Process in ≤500-bucket transactions (the cap), looping to drain the window.
  for (const chunk of chunkAffected(affected, MAX_BUCKETS_PER_RUN)) {
    await db.transaction(async (tx) => {
      await recomputeAffected(tx, target.orgId, target.id, defs, chunk);
    });
  }
  // Force is an out-of-band recompute (e.g. after a definition edit); it does
  // NOT advance the incremental watermark, which tracks received_at coverage.
  return { caughtUp: true, dayChanged, buckets };
}

function* chunkAffected(
  affected: AffectedBuckets,
  size: number,
): Generator<AffectedBuckets> {
  const flat: { period: RollupPeriod; ps: string }[] = [];
  for (const period of ROLLUP_PERIODS) {
    for (const ps of affected.get(period)!) flat.push({ period, ps });
  }
  for (let i = 0; i < flat.length; i += size) {
    const slice = flat.slice(i, i + size);
    const map: AffectedBuckets = new Map();
    for (const p of ROLLUP_PERIODS) map.set(p, []);
    for (const item of slice) map.get(item.period)!.push(item.ps);
    yield map;
  }
}

// ── public entry points ──────────────────────────────────────────────────────

/** What ingest calls post-response: one bounded incremental pass for a project
 * (over the cap → next run continues). Keeps the after-response reaction lean. */
export async function runIncrementalRollupForProject(
  db: Db,
  orgId: string,
  projectId: string,
): Promise<void> {
  const [project] = await db
    .select({ id: projects.id, orgId: projects.orgId, name: projects.name })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project) return;

  const defs = validateDefinitions(
    await resolveEffectiveDefinitions(db, orgId, projectId),
  );
  try {
    await incrementalPass(db, project, defs);
  } catch (err) {
    // This runs as a detached post-response reaction (§6.3 step 6), so the
    // project can be deleted mid-pass — e.g. a test tearing down its throwaway
    // org while the reaction is still in flight. If the project is gone, that
    // race is benign; swallow it. If it still exists, the error is real —
    // re-throw so the caller (and real bugs) surface.
    const [stillThere] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (stillThere) throw err;
  }
}

/** Scheduled/CLI entry: rolls up all projects (or one), then runs the anomaly
 * detector for every project whose day buckets changed. Fully drains each
 * project's backlog by looping the bounded pass. */
export async function runRollups(
  db: Db,
  opts: RollupOptions = {},
): Promise<RollupRunSummary> {
  const conds = [] as SQL[];
  if (opts.orgId) conds.push(eq(projects.orgId, opts.orgId));
  if (opts.projectId) conds.push(eq(projects.id, opts.projectId));
  const targets = await db
    .select({ id: projects.id, orgId: projects.orgId, name: projects.name })
    .from(projects)
    .where(conds.length ? and(...conds) : undefined);

  const summary: RollupRunSummary = {
    projects: 0,
    passes: 0,
    bucketsRecomputed: 0,
    anomaliesCreated: 0,
  };
  const changedDayProjects: ProjectTarget[] = [];

  for (const target of targets) {
    const defs = validateDefinitions(
      await resolveEffectiveDefinitions(db, target.orgId, target.id),
    );
    let dayChanged = false;

    if (opts.force) {
      const r = await forceProject(
        db,
        target,
        defs,
        opts.forceWindowDays ?? FORCE_WINDOW_DAYS_DEFAULT,
      );
      summary.passes += 1;
      summary.bucketsRecomputed += r.buckets;
      dayChanged = r.dayChanged;
    } else {
      let caughtUp = false;
      let guard = 0;
      while (!caughtUp && guard < MAX_PASSES) {
        const r = await incrementalPass(db, target, defs);
        caughtUp = r.caughtUp;
        dayChanged = dayChanged || r.dayChanged;
        summary.passes += 1;
        summary.bucketsRecomputed += r.buckets;
        guard += 1;
      }
      if (guard >= MAX_PASSES) {
        console.warn(`[rollup] project ${target.id} hit the pass guard — backlog not fully drained`);
      }
    }

    summary.projects += 1;
    if (dayChanged) changedDayProjects.push(target);
  }

  for (const target of changedDayProjects) {
    summary.anomaliesCreated += await detectAnomaliesForProject(
      db,
      target.orgId,
      target.id,
    );
  }

  return summary;
}
