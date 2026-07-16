import { and, eq, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { clients, db, projects } from "@azen/db";
import type { ProjectGoal } from "@azen/db";

/**
 * Shared server core for the deep per-project Analytics screen.
 *
 * Everything here is READ-ONLY: the section endpoints only ever run
 * SELECT/WITH queries over events / metric_rollups / agent_runs / bookings /
 * insights, always scoped to (org_id, project_id). London calendar-day
 * boundaries are resolved in SQL with the `… at time zone 'Europe/London'`
 * pattern (see app/api/projects/[projectId]/conversations/query.ts), so
 * `parseRange` only hands sections the day keys + a coarse UTC window.
 */

export type AnalyticsRange = "7d" | "30d" | "90d";

const RANGE_DAYS: Record<AnalyticsRange, number> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
};

export const ANALYTICS_RANGES: readonly AnalyticsRange[] = ["7d", "30d", "90d"];

export interface ParsedRange {
  /** normalised range token (defaults to "30d" for anything unrecognised) */
  range: AnalyticsRange;
  /** inclusive window length in days */
  days: number;
  /** inclusive London calendar day the window starts on (YYYY-MM-DD) */
  fromDay: string;
  /** inclusive London calendar day the window ends on — "today" (YYYY-MM-DD) */
  toDay: string;
  /** coarse UTC window start; SQL is authoritative for exact London boundaries */
  fromIso: string;
  /** window end — request time */
  toIso: string;
}

/** London calendar day key (YYYY-MM-DD) for an instant. Pure, server-safe. */
export function londonDayKey(instant: Date = new Date()): string {
  // en-CA yields ISO-shaped YYYY-MM-DD; the timeZone does the DST-correct shift.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

/** Subtract whole days from a YYYY-MM-DD key (UTC math on the date parts). */
function addDays(dayKey: string, delta: number): string {
  const [y, m, d] = dayKey.split("-").map(Number);
  const dt = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(
    dt.getUTCDate(),
  ).padStart(2, "0")}`;
}

/**
 * Normalise the shared range control into a concrete window. `days` is the
 * inclusive length, so a 7d window is [today-6 … today].
 */
export function parseRange(searchParams: URLSearchParams): ParsedRange {
  const raw = searchParams.get("range");
  const range: AnalyticsRange =
    raw === "7d" || raw === "30d" || raw === "90d" ? raw : "30d";
  const days = RANGE_DAYS[range];
  const now = new Date();
  const toDay = londonDayKey(now);
  const fromDay = addDays(toDay, -(days - 1));
  return {
    range,
    days,
    fromDay,
    toDay,
    fromIso: new Date(`${fromDay}T00:00:00.000Z`).toISOString(),
    toIso: now.toISOString(),
  };
}

/**
 * London calendar-day bucket for a timestamptz column, returned as a UTC
 * instant so the JSON series carries stable ISO keys. Wave-1 sections group by
 * this and format client-side. e.g. `londonDayBucket(events.occurredAt)`.
 */
export function londonDayBucket(column: SQL | unknown): SQL {
  return sql`(date_trunc('day', ${column} at time zone 'Europe/London') at time zone 'Europe/London')`;
}

/** London hour-of-day (0..23) for a timestamptz column — for the heatmap. */
export function londonHour(column: SQL | unknown): SQL {
  return sql`extract(hour from ${column} at time zone 'Europe/London')::int`;
}

/** London ISO weekday (1=Mon … 7=Sun) for a timestamptz column. */
export function londonWeekday(column: SQL | unknown): SQL {
  return sql`extract(isodow from ${column} at time zone 'Europe/London')::int`;
}

export interface AnalyticsProject {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  status: string;
  health: string;
  type: string;
  stack: string;
  retainerPenceMonthly: number;
  clientName: string;
  goals: ProjectGoal[];
}

/**
 * Typed, org-scoped project loader for the analytics route + endpoints.
 * Returns null when the project does not exist in this org (→ 404 upstream).
 * Read-only.
 */
export async function getProjectForAnalytics(
  orgId: string,
  projectId: string,
): Promise<AnalyticsProject | null> {
  const [row] = await db
    .select({
      id: projects.id,
      name: projects.name,
      slug: projects.slug,
      description: projects.description,
      status: projects.status,
      health: projects.health,
      type: projects.type,
      stack: projects.stack,
      retainerPenceMonthly: projects.retainerPenceMonthly,
      clientName: clients.name,
      goals: projects.goals,
    })
    .from(projects)
    .innerJoin(clients, eq(projects.clientId, clients.id))
    .where(and(eq(projects.id, projectId), eq(projects.orgId, orgId)))
    .limit(1);
  return row ?? null;
}
