import { and, eq, gte, inArray, lt } from "drizzle-orm";
import { db, metricRollups } from "@azen/db";
import type { ProjectGoal } from "@azen/db";

/**
 * P9-PACK1 — goal pacing (docs/phase9/CONTRACTS.md §P9-PACK1).
 *
 * "Pacing" answers: for each project goal ({metric, target, period}), given
 * how much of the current day/week/month has elapsed (Europe/London wall
 * clock), are we on track to hit `target` by period end?
 *
 * - actual-to-date is read straight off metric_rollups: the rollup engine
 *   recomputes the CURRENT (still-open) bucket on every incremental pass from
 *   all events that have occurred so far in that bucket
 *   (packages/db/src/rollup/engine.ts recomputeAffected), so the row for
 *   period='week'/'month' at the bucket containing "now" already holds the
 *   live to-date sum — no extra summing needed here.
 * - expected-to-date = target x (elapsed / period length), both measured in
 *   the same Europe/London wall-clock period the goal itself is scored on.
 *
 * Bounds resolution is pure JS (deterministic, unit-testable without a DB —
 * see test/pacing/pacing.test.ts) using the standard "format in the target
 * zone, diff the offset" technique for resolving an IANA zone's wall-clock
 * boundary without a date library. The rollup engine's SQL
 * `date_trunc(period, ts at time zone 'Europe/London') at time zone
 * 'Europe/London'` stays the authority for what's actually stored — the DB
 * read below matches against a RANGE (>= start, < end), not exact-instant
 * equality, so any sub-millisecond formatting drift between the two
 * implementations can never miss the row.
 */

export type GoalPeriod = ProjectGoal["period"];

const LONDON_TZ = "Europe/London";

/** London calendar day key (YYYY-MM-DD) for an instant. Pure, deterministic. */
export function londonDayKey(instant: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: LONDON_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

/** ISO weekday (1=Mon..7=Sun) of a YYYY-MM-DD day key -- pure UTC date-part math. */
function isoWeekdayOfKey(dayKey: string): number {
  const [y, m, d] = dayKey.split("-").map(Number);
  const dow = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1)).getUTCDay();
  return dow === 0 ? 7 : dow;
}

/** Add whole calendar days to a YYYY-MM-DD key (UTC date-part arithmetic). */
function addDaysToKey(dayKey: string, delta: number): string {
  const [y, m, d] = dayKey.split("-").map(Number);
  const dt = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(
    dt.getUTCDate(),
  ).padStart(2, "0")}`;
}

function monthStartKey(dayKey: string): string {
  return `${dayKey.slice(0, 7)}-01`;
}

function nextMonthStartKey(dayKey: string): string {
  const [y, m] = dayKey.slice(0, 7).split("-").map(Number);
  const ny = m === 12 ? (y ?? 1970) + 1 : (y ?? 1970);
  const nm = m === 12 ? 1 : (m ?? 1) + 1;
  return `${ny}-${String(nm).padStart(2, "0")}-01`;
}

/**
 * The UTC-minutes offset of `timeZone` at `instant` (e.g. +60 for London
 * during BST). Standard "format in the zone, diff against a UTC read of the
 * same parts" technique -- no date library, no new dependency.
 */
function tzOffsetMinutesAt(instant: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(instant)) parts[p.type] = p.value;
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return Math.round((asUtc - instant.getTime()) / 60_000);
}

/**
 * UTC instant of London wall-clock midnight on `dayKey` (DST-correct: the
 * offset is sampled at the UTC-midnight guess, which always lands before the
 * ~1am/2am local clock-change instant on transition days, so it reflects the
 * offset actually in force at local midnight).
 */
function londonMidnightUtc(dayKey: string): Date {
  const guess = new Date(`${dayKey}T00:00:00.000Z`);
  const offsetMin = tzOffsetMinutesAt(guess, LONDON_TZ);
  return new Date(guess.getTime() - offsetMin * 60_000);
}

export interface PeriodWindow {
  /** inclusive UTC instant the period begins */
  start: Date;
  /** exclusive UTC instant the period ends */
  end: Date;
}

/** Pure: the Europe/London day/week(Mon-start)/month window containing `now`. */
export function londonPeriodBounds(
  period: GoalPeriod,
  now: Date = new Date(),
): PeriodWindow {
  const todayKey = londonDayKey(now);
  let startKey: string;
  let endKey: string;
  if (period === "day") {
    startKey = todayKey;
    endKey = addDaysToKey(todayKey, 1);
  } else if (period === "week") {
    const dow = isoWeekdayOfKey(todayKey); // 1=Mon..7=Sun
    startKey = addDaysToKey(todayKey, -(dow - 1));
    endKey = addDaysToKey(startKey, 7);
  } else {
    startKey = monthStartKey(todayKey);
    endKey = nextMonthStartKey(todayKey);
  }
  return { start: londonMidnightUtc(startKey), end: londonMidnightUtc(endKey) };
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;

export interface GoalPacingResult {
  metric: string;
  period: GoalPeriod;
  target: number;
  /** ISO instant the current period started */
  periodStart: string;
  /** ISO instant the current period ends (exclusive) */
  periodEnd: string;
  /** fraction (0..1) of the period elapsed as of `now` */
  elapsedFraction: number;
  actualToDate: number;
  expectedToDate: number;
  /** actualToDate as a % of expectedToDate; null when nothing was expected yet */
  pacePct: number | null;
  onPace: boolean;
}

/**
 * Pure pace math for one goal given its actual-to-date value (straight off
 * metric_rollups, or hand-built in a test) and a reference instant. No DB
 * access -- deterministic and directly unit-testable.
 */
export function computeGoalPacing(
  goal: ProjectGoal,
  actualToDate: number,
  now: Date = new Date(),
): GoalPacingResult {
  const bounds = londonPeriodBounds(goal.period, now);
  const totalMs = bounds.end.getTime() - bounds.start.getTime();
  const clampedNow = Math.min(
    Math.max(now.getTime(), bounds.start.getTime()),
    bounds.end.getTime(),
  );
  const elapsedFraction =
    totalMs > 0 ? Math.max(0, Math.min(1, (clampedNow - bounds.start.getTime()) / totalMs)) : 0;
  const expectedToDate = goal.target * elapsedFraction;
  const pacePct = expectedToDate > 0 ? round2((actualToDate / expectedToDate) * 100) : null;
  const onPace = expectedToDate > 0 ? actualToDate >= expectedToDate : true;

  return {
    metric: goal.metric,
    period: goal.period,
    target: goal.target,
    periodStart: bounds.start.toISOString(),
    periodEnd: bounds.end.toISOString(),
    elapsedFraction: round4(elapsedFraction),
    actualToDate: round2(actualToDate),
    expectedToDate: round2(expectedToDate),
    pacePct,
    onPace,
  };
}

/**
 * Full pacing read for every goal on a project: fetches each goal's
 * actual-to-date off metric_rollups -- the row whose period_start falls in
 * the current London-bounded window (a RANGE match, not exact-instant
 * equality; see module doc) -- batched per distinct period so a project with
 * several goals on the same period only issues one query per period, then
 * runs the pure pace math. A missing row (no events yet this period)
 * degrades gracefully to actualToDate=0. Read-only, org+project scoped.
 */
export async function computeProjectGoalPacing(
  orgId: string,
  projectId: string,
  goals: ProjectGoal[],
  now: Date = new Date(),
): Promise<GoalPacingResult[]> {
  if (goals.length === 0) return [];

  const byPeriod = new Map<GoalPeriod, ProjectGoal[]>();
  for (const g of goals) {
    const arr = byPeriod.get(g.period) ?? [];
    arr.push(g);
    byPeriod.set(g.period, arr);
  }

  const byMetricPeriod = new Map<string, GoalPacingResult>();
  for (const [period, periodGoals] of byPeriod) {
    const bounds = londonPeriodBounds(period, now);
    const keys = periodGoals.map((g) => g.metric);
    const rows = await db
      .select({ metricKey: metricRollups.metricKey, value: metricRollups.value })
      .from(metricRollups)
      .where(
        and(
          eq(metricRollups.orgId, orgId),
          eq(metricRollups.projectId, projectId),
          eq(metricRollups.period, period),
          gte(metricRollups.periodStart, bounds.start),
          lt(metricRollups.periodStart, bounds.end),
          inArray(metricRollups.metricKey, keys),
        ),
      );
    const byKey = new Map(rows.map((r) => [r.metricKey, Number(r.value)] as const));
    for (const g of periodGoals) {
      byMetricPeriod.set(
        `${g.metric} ${g.period}`,
        computeGoalPacing(g, byKey.get(g.metric) ?? 0, now),
      );
    }
  }
  // stable order matching the project's declared goal order, not the
  // period-batched fetch order.
  return goals.map((g) => byMetricPeriod.get(`${g.metric} ${g.period}`)!);
}
