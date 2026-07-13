import { and, eq, gte, lte, sql, type SQL } from "drizzle-orm";
import type { AnyColumn } from "drizzle-orm";
import { db, projects } from "@azen/db";

/**
 * Shared internals for the Ask tools: org-scoped project-slug resolution and
 * from/to range predicates. Kept tiny and reused by every structured tool so
 * scoping and date semantics can't drift between them.
 */

/**
 * Resolve a project slug within THIS org. Returns the id, or null when the slug
 * is unknown *to this org* — a cross-org project and a typo are indistinguishable
 * to the caller (no leak). projects.slug is globally unique, so the org filter
 * is what keeps another org's project from ever resolving here.
 */
export async function resolveProjectIdBySlug(
  orgId: string,
  slug: string,
): Promise<string | null> {
  const [row] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.orgId, orgId), eq(projects.slug, slug)))
    .limit(1);
  return row?.id ?? null;
}

/**
 * from/to predicates on a timestamptz column. `from`/`to` accept an ISO date
 * (YYYY-MM-DD) or a full ISO datetime. A bare date is treated as a whole
 * Europe/London calendar day: `from` >= London-midnight of `from`, `to` <
 * London-midnight of the day after `to`. This matches query_metric_rollups
 * (londonInstant in metrics.ts) so the two tools agree on where a "day" starts —
 * a DST boundary no longer splits an event near midnight into different calendar
 * days across tools. A full ISO datetime is used as the literal instant.
 */
export function timestampRangeConds(
  col: AnyColumn,
  from?: string,
  to?: string,
): SQL[] {
  const conds: SQL[] = [];
  if (from) {
    if (from.includes("T")) {
      const g = gte(col, new Date(from));
      if (g) conds.push(g);
    } else {
      conds.push(
        sql`${col} >= (${from}::date)::timestamp at time zone 'Europe/London'`,
      );
    }
  }
  if (to) {
    if (to.includes("T")) {
      const l = lte(col, new Date(to));
      if (l) conds.push(l);
    } else {
      conds.push(
        sql`${col} < ((${to}::date + 1)::timestamp at time zone 'Europe/London')`,
      );
    }
  }
  return conds;
}

/**
 * from/to predicates on a `date` column (not timestamptz — e.g. incurred_at).
 * Both bounds are inclusive whole days; the ::date casts keep the comparison in
 * date space so no timezone shift creeps in.
 */
export function dateRangeConds(
  col: AnyColumn,
  from?: string,
  to?: string,
): SQL[] {
  const conds: SQL[] = [];
  if (from) conds.push(sql`${col} >= ${from}::date`);
  if (to) conds.push(sql`${col} <= ${to}::date`);
  return conds;
}

/** Escape ILIKE wildcards in user text so a stray %/_ can't widen the match. */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}
