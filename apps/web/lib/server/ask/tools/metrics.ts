import { z } from "zod";
import { and, eq, isNull, or, sql, type SQL } from "drizzle-orm";
import {
  bucketStartSQL,
  db,
  isoUTC,
  londonTodayUTC,
  metricDefinitions,
} from "@azen/db";
import { defineTool } from "./types";
import { resolveProjectIdBySlug } from "./shared";

/**
 * query_metric_rollups — the metrics workhorse. Reads the pre-computed
 * metric_rollups (never scans raw events for the answer) for one metric key over
 * a period window, org-scoped. When project_slug is given it's a single project;
 * omitted, it sums that key across every project in the org. Supports the three
 * derived ratio keys M2 defined (agent_success_rate, escalation_rate,
 * no_show_rate) by combining their underlying series.
 *
 * getMetricSeries in queries.ts is the sibling read but is strictly per-project
 * and multi-key; this tool needs the org-wide aggregate too, so it does its own
 * scoped read using @azen/db's shared bucket/London-instant SQL (no forked math).
 */

const POINT_CAP = 400;

interface DerivedSpec {
  name: string;
  num: { kind: "metric"; key: string } | { kind: "event"; eventType: string };
  den: { kind: "metric"; key: string };
}

// Mirrors DERIVED_METRICS in queries.ts (M2). Ratios are percent, clamped 0-100,
// null when the denominator bucket is 0 (num/den count disjoint populations, so
// the raw ratio can exceed 1 — same reasoning as M2's series builder).
const DERIVED: Record<string, DerivedSpec> = {
  agent_success_rate: {
    name: "Agent success rate",
    num: { kind: "metric", key: "agent_runs_succeeded" },
    den: { kind: "metric", key: "agent_runs" },
  },
  escalation_rate: {
    name: "Escalation rate",
    num: { kind: "metric", key: "escalations" },
    den: { kind: "metric", key: "conversations" },
  },
  no_show_rate: {
    name: "No-show rate",
    num: { kind: "event", eventType: "booking.no_show" },
    den: { kind: "metric", key: "bookings_created" },
  },
};

const toDateStr = (d: Date): string => d.toISOString().slice(0, 10);
function shiftDateStr(dateStr: string, deltaDays: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return toDateStr(d);
}
/** UTC instant of Europe/London midnight on `dateStr` (DST-correct via Postgres). */
function londonInstant(dateStr: string): SQL {
  return sql`(${dateStr}::date)::timestamp at time zone 'Europe/London'`;
}

type IsoValueMap = Map<string, number>;

async function readRollupSeries(
  orgId: string,
  projectId: string | undefined,
  key: string,
  period: string,
  start: SQL,
  end: SQL,
): Promise<IsoValueMap> {
  const projCond = projectId
    ? sql`and project_id = ${projectId}::uuid`
    : sql``;
  const rows = (await db.execute(sql`
    select ${isoUTC(sql`period_start`)} as period_start, sum(value) as value
    from metric_rollups
    where org_id = ${orgId}::uuid
      and metric_key = ${key}
      and period = ${period}::rollup_period
      and period_start >= ${start} and period_start < ${end}
      ${projCond}
    group by period_start
    order by period_start asc
  `)) as unknown as { period_start: string; value: unknown }[];
  return new Map(rows.map((r) => [r.period_start, Number(r.value)] as const));
}

async function readEventCountSeries(
  orgId: string,
  projectId: string | undefined,
  eventType: string,
  period: string,
  start: SQL,
  end: SQL,
): Promise<IsoValueMap> {
  const projCond = projectId
    ? sql`and e.project_id = ${projectId}::uuid`
    : sql``;
  const rows = (await db.execute(sql`
    select ${isoUTC(sql`bucket`)} as period_start, count(*)::int as value
    from (
      select ${bucketStartSQL(period as "hour" | "day" | "week" | "month")} as bucket
      from events e
      where e.org_id = ${orgId}::uuid
        and e.type = ${eventType}
        and e.occurred_at >= ${start}
        ${projCond}
    ) sub
    where bucket >= ${start} and bucket < ${end}
    group by bucket
    order by bucket asc
  `)) as unknown as { period_start: string; value: number }[];
  return new Map(rows.map((r) => [r.period_start, Number(r.value)] as const));
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

async function metricMeta(
  orgId: string,
  projectId: string | undefined,
  key: string,
): Promise<{ name: string; unit: string }> {
  const [row] = await db
    .select({ name: metricDefinitions.name, unit: metricDefinitions.unit })
    .from(metricDefinitions)
    .where(
      and(
        eq(metricDefinitions.orgId, orgId),
        eq(metricDefinitions.key, key),
        // prefer a project override, else the global default
        projectId
          ? or(
              eq(metricDefinitions.projectId, projectId),
              isNull(metricDefinitions.projectId),
            )
          : isNull(metricDefinitions.projectId),
      ),
    )
    .orderBy(sql`${metricDefinitions.projectId} nulls last`)
    .limit(1);
  return { name: row?.name ?? key, unit: row?.unit ?? "count" };
}

export const queryMetricRollups = defineTool({
  name: "query_metric_rollups",
  description:
    "Read a pre-computed metric time series from metric_rollups. Give a metric_key (e.g. bookings_created, conversations, revenue_attributed, minutes_saved, tokens_cost_pence, or a derived ratio: agent_success_rate, escalation_rate, no_show_rate) and a period (day/week/month, default day). Optionally scope to one project by project_slug; omit it to sum the key across all projects in the org. Optional from/to are London calendar dates (YYYY-MM-DD); defaults to the trailing 30 days. Returns { series: [{periodStart, value}], meta: {name, unit} }. Values are pence for pence-unit metrics, percent (0-100) for ratios; a ratio bucket is null when its denominator is 0.",
  inputSchema: z
    .object({
      project_slug: z.string().min(1).optional(),
      metric_key: z.string().min(1),
      period: z.enum(["day", "week", "month"]).default("day"),
      from: z.string().min(1).optional(),
      to: z.string().min(1).optional(),
    })
    .strict(),
  run: async (orgId, input) => {
    let projectId: string | undefined;
    if (input.project_slug !== undefined) {
      const resolved = await resolveProjectIdBySlug(orgId, input.project_slug);
      if (resolved === null) {
        // Unknown-to-this-org slug: empty series, no leak, no error.
        return {
          ok: true,
          data: {
            series: [],
            meta: { name: input.metric_key, unit: "count" },
            note: `no project '${input.project_slug}' in this org`,
          },
        };
      }
      projectId = resolved;
    }

    const period = input.period;
    const toDate = input.to ?? toDateStr(londonTodayUTC());
    const fromDate = input.from ?? shiftDateStr(toDate, -29);
    const start = londonInstant(fromDate);
    const end = londonInstant(shiftDateStr(toDate, 1));

    const derived = DERIVED[input.metric_key];
    let series: { periodStart: string; value: number | null }[];
    let meta: { name: string; unit: string };

    if (derived) {
      const numMap =
        derived.num.kind === "metric"
          ? await readRollupSeries(orgId, projectId, derived.num.key, period, start, end)
          : await readEventCountSeries(
              orgId,
              projectId,
              derived.num.eventType,
              period,
              start,
              end,
            );
      const denMap = await readRollupSeries(
        orgId,
        projectId,
        derived.den.key,
        period,
        start,
        end,
      );
      const isos = new Set<string>();
      numMap.forEach((_v, iso) => isos.add(iso));
      denMap.forEach((_v, iso) => isos.add(iso));
      series = [...isos].sort().map((iso) => {
        const num = numMap.get(iso) ?? 0;
        const den = denMap.get(iso) ?? 0;
        return {
          periodStart: iso,
          value: den > 0 ? Math.min(100, round2((num / den) * 100)) : null,
        };
      });
      meta = { name: derived.name, unit: "percent" };
    } else {
      const m = await readRollupSeries(orgId, projectId, input.metric_key, period, start, end);
      series = [...m.entries()].map(([periodStart, value]) => ({ periodStart, value }));
      meta = await metricMeta(orgId, projectId, input.metric_key);
    }

    const truncated = series.length > POINT_CAP;
    return {
      ok: true,
      data: {
        // series is ascending (oldest-first); when capped keep the MOST RECENT
        // POINT_CAP buckets (slice the tail), never the stale head.
        series: truncated ? series.slice(-POINT_CAP) : series,
        meta,
        ...(truncated ? { truncated: true } : {}),
      },
    };
  },
});
