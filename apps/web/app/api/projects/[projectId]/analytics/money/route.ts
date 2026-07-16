import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@azen/db";
import { DEFAULT_HOURLY_RATE_PENCE } from "@azen/config";
import { jsonError, withErrorHandling } from "../../../../../../lib/server/http";
import { requireOrgId } from "../../../../../../lib/server/org";
import { isUuid } from "../../../../../../lib/server/schemas";
import {
  getProjectForAnalytics,
  parseRange,
} from "../../../../../../lib/server/analytics/base";
import {
  buildLtvCurve,
  computePaybackMonths,
  computeRevenueConcentration,
  type LtvCurvePoint,
  type RevenueConcentration,
} from "../../../../../../lib/server/analytics/money-depth";
import type { MoneyResponse } from "../../../../../../components/analytics/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ projectId: string }> };

/**
 * Money & Value — per-project value attribution + honest ROI (§10).
 *
 * READ-ONLY over `events` + `agent_runs`, always scoped to (org_id, project_id)
 * and to the inclusive London-calendar-day window `parseRange` resolves. This
 * is the CLIENT ledger: end-customer money lives in the `events` spine
 * (value_pence), never the agency payments table (two-ledger rule).
 *
 * Metrics:
 *  - attributed revenue   = Σ value_pence over value-bearing events (type ≠
 *                           payment.refunded). This is the SAME convention as the
 *                           OS-wide `revenue_attributed` KPI (eventType "*",
 *                           valuePath $.value_pence) — so this number reconciles
 *                           with the ROI/datapack figure shown elsewhere. In the
 *                           data that means quote.accepted + booking.created +
 *                           payment.captured + invoice.paid + order.created …
 *  - refunds              = Σ value_pence where type = payment.refunded
 *  - net revenue          = gross − refunds
 *  - AOV                  = gross ÷ #revenue transactions
 *  - time value           = (Σ minutes_saved ÷ 60) × hourly_rate  (project rate,
 *                           else DEFAULT_HOURLY_RATE_PENCE — same convention as ROI)
 *  - attributed value     = net revenue + time value
 *  - run cost             = Σ agent_runs.cost_estimate_pence for this project
 *  - ROI                  = attributed value ÷ run cost  (null when no run cost)
 *  - revenue trend        = daily London-day buckets of revenue pence
 *  - top value events     = the biggest individual revenue events
 *  - revenue by source    = attributed revenue split by event type
 *
 * Never throws on an empty project — every metric falls back to 0 / [] / null.
 */

export interface MoneyByType {
  type: string;
  label: string;
  pence: number;
  count: number;
}

export interface MoneyValueEvent {
  id: string;
  type: string;
  label: string;
  occurredAt: string;
  pence: number;
}

/** Richer money wire shape — structurally a superset of MoneyResponse. */
export interface MoneyData extends MoneyResponse {
  /** Σ revenue-type value_pence (gross). Also mirrored as totalPence. */
  grossRevenuePence: number;
  /** gross − refunds. */
  netRevenuePence: number;
  refundsPence: number;
  refundsCount: number;
  /** #revenue-type events (the denominator for AOV). */
  transactions: number;
  /** gross ÷ transactions; null when there were none. */
  aovPence: number | null;
  minutesSaved: number;
  hoursSaved: number;
  hourlyRatePence: number;
  timeValuePence: number;
  /** net revenue + time value — the honest "value returned" number. */
  attributedValuePence: number;
  runCostPence: number;
  runCount: number;
  /** attributed value ÷ run cost; null when run cost is 0 (undefined ratio). */
  roiMultiple: number | null;
  revenueByType: MoneyByType[];
  topValueEvents: MoneyValueEvent[];
  // ── P9-PACK3 additive: payback + client LTV curve + revenue concentration ──
  buildFeePence: number;
  /** trailing-30-day attributed value, independent of the range control. */
  monthlyAttributedValuePence: number;
  /** buildFeePence ÷ monthlyAttributedValuePence in months; null when either side is ≤0. */
  paybackMonths: number | null;
  /** cumulative agency revenue for this project's CLIENT, one point per month with a payment. */
  ltvCurve: LtvCurvePoint[];
  /** how concentrated the agency's own revenue is on this client — a risk note. */
  revenueConcentration: RevenueConcentration;
}

const num = (v: unknown): number =>
  typeof v === "number" ? v : Number(v ?? 0) || 0;
const round2 = (n: number): number => Math.round(n * 100) / 100;

const TYPE_LABELS: Record<string, string> = {
  "quote.accepted": "Quotes accepted",
  "booking.created": "Bookings",
  "booking.completed": "Bookings completed",
  "order.created": "Orders",
  "payment.captured": "Payments captured",
  "invoice.paid": "Invoices paid",
  "subscription.started": "Subscriptions",
  "payment.refunded": "Refunds",
};
/** Humanise an event type for money labels ("lead.converted" → "Lead converted"). */
const typeLabel = (t: string): string => {
  if (TYPE_LABELS[t]) return TYPE_LABELS[t];
  const words = t.replace(/[._]/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
};

interface AggRow {
  gross_revenue: number | string;
  txns: number | string;
  refunds: number | string;
  refunds_count: number | string;
  minutes_saved: number | string;
}
interface CostRow {
  run_cost: number | string;
  run_count: number | string;
  hourly_rate: number | string | null;
  build_fee: number | string | null;
  client_id: string;
}
interface Monthly30dRow {
  gross_30d: number | string;
  refunds_30d: number | string;
  minutes_saved_30d: number | string;
}
interface LtvMonthRow {
  month: string;
  pence: number | string;
}
interface OrgTotalRow {
  pence: number | string;
}
interface ByTypeRow {
  type: string;
  pence: number | string;
  cnt: number | string;
}
interface TrendRow {
  period_start: string;
  value: number | string;
}
interface TopRow {
  id: string;
  type: string;
  occurred_at: string;
  pence: number | string;
  raw_label: string | null;
}

export const GET = withErrorHandling(async (req: Request, { params }: Ctx) => {
  const orgId = await requireOrgId();
  const { projectId } = await params;
  if (!isUuid(projectId)) return jsonError(404, "project_not_found");

  const r = parseRange(new URL(req.url).searchParams);
  const project = await getProjectForAnalytics(orgId, projectId);
  if (!project) return jsonError(404, "project_not_found");

  // A "revenue event" = any value-bearing event that is not a refund. Matches
  // the OS-wide `revenue_attributed` KPI (eventType "*", Σ value_pence).
  const isRevenue = sql`e.value_pence is not null and e.value_pence > 0 and e.type <> 'payment.refunded'`;

  // Inclusive [fromDay … toDay] London calendar days → UTC instants in SQL.
  const win = sql`
    win as (
      select
        (${r.fromDay}::date::timestamp at time zone 'Europe/London') as w_start,
        ((${r.toDay}::date + 1)::timestamp at time zone 'Europe/London') as w_end
    )`;

  // ── event-side aggregates (single row) ──────────────────────────────────────
  const aggRows = (await db.execute(sql`
    with ${win}
    select
      coalesce(sum(e.value_pence) filter (where ${isRevenue}), 0)::bigint as gross_revenue,
      count(*) filter (where ${isRevenue})::int as txns,
      coalesce(sum(e.value_pence) filter (where e.type = 'payment.refunded'), 0)::bigint as refunds,
      count(*) filter (where e.type = 'payment.refunded')::int as refunds_count,
      coalesce(sum(e.minutes_saved), 0)::numeric as minutes_saved
    from events e, win
    where e.org_id = ${orgId}::uuid
      and e.project_id = ${projectId}::uuid
      and e.occurred_at >= win.w_start
      and e.occurred_at < win.w_end
  `)) as unknown as AggRow[];
  const agg = aggRows[0];

  // ── agent-run cost + the project's hourly rate ──────────────────────────────
  const costRows = (await db.execute(sql`
    with ${win}
    select
      coalesce(sum(r.cost_estimate_pence), 0)::bigint as run_cost,
      count(*)::int as run_count,
      (
        select coalesce(p.hourly_rate_pence, ${DEFAULT_HOURLY_RATE_PENCE})
        from projects p
        where p.id = ${projectId}::uuid and p.org_id = ${orgId}::uuid
      ) as hourly_rate,
      (
        select p.build_fee_pence
        from projects p
        where p.id = ${projectId}::uuid and p.org_id = ${orgId}::uuid
      ) as build_fee,
      (
        select p.client_id::text
        from projects p
        where p.id = ${projectId}::uuid and p.org_id = ${orgId}::uuid
      ) as client_id
    from agent_runs r, win
    where r.org_id = ${orgId}::uuid
      and r.project_id = ${projectId}::uuid
      and r.started_at >= win.w_start
      and r.started_at < win.w_end
  `)) as unknown as CostRow[];
  const cost = costRows[0];

  // ── P9-PACK3: trailing-30d attributed value (payback), independent of `r` ──
  const monthly30dRows = (await db.execute(sql`
    select
      coalesce(sum(e.value_pence) filter (where ${isRevenue}), 0)::bigint as gross_30d,
      coalesce(sum(e.value_pence) filter (where e.type = 'payment.refunded'), 0)::bigint as refunds_30d,
      coalesce(sum(e.minutes_saved), 0)::numeric as minutes_saved_30d
    from events e
    where e.org_id = ${orgId}::uuid
      and e.project_id = ${projectId}::uuid
      and e.occurred_at >= now() - make_interval(days => 30)
  `)) as unknown as Monthly30dRow[];
  const monthly30d = monthly30dRows[0];

  // ── P9-PACK3: client LTV — monthly agency-payment sums (ascending) ─────────
  const clientId = cost?.client_id ?? null;
  const ltvMonthRows = clientId
    ? ((await db.execute(sql`
        select
          to_char(date_trunc('month', p.paid_at at time zone 'Europe/London'), 'YYYY-MM') as month,
          coalesce(sum(p.amount_pence), 0)::bigint as pence
        from payments p
        where p.org_id = ${orgId}::uuid
          and p.client_id = ${clientId}::uuid
          and p.status = 'paid'
          and p.paid_at is not null
        group by 1
        order by 1
      `)) as unknown as LtvMonthRow[])
    : [];

  // ── P9-PACK3: org-wide agency revenue total (concentration denominator) ────
  const orgTotalRows = (await db.execute(sql`
    select coalesce(sum(p.amount_pence), 0)::bigint as pence
    from payments p
    where p.org_id = ${orgId}::uuid and p.status = 'paid'
  `)) as unknown as OrgTotalRow[];
  const orgTotalPence = num(orgTotalRows[0]?.pence);

  // ── revenue split by type ───────────────────────────────────────────────────
  const byTypeRows = (await db.execute(sql`
    with ${win}
    select
      e.type as type,
      coalesce(sum(e.value_pence), 0)::bigint as pence,
      count(*)::int as cnt
    from events e, win
    where e.org_id = ${orgId}::uuid
      and e.project_id = ${projectId}::uuid
      and ${isRevenue}
      and e.occurred_at >= win.w_start
      and e.occurred_at < win.w_end
    group by e.type
    order by pence desc
  `)) as unknown as ByTypeRow[];

  // ── daily revenue trend (zero-filled across the window, ascending) ──────────
  // generate_series-filled per London day (same convention as pulse/route.ts),
  // so revenue-less days render as 0 rather than collapsing out. LineChart/
  // MiniTrend space points by array index, not by date, so absent days would
  // otherwise draw a non-time-linear x-axis that misrepresents when revenue
  // actually landed (dry spells would look like steady daily revenue).
  const trendRows = (await db.execute(sql`
    with ${win},
    days as (
      select generate_series(${r.fromDay}::date, ${r.toDay}::date, interval '1 day')::date as d
    ),
    rev as (
      select
        (e.occurred_at at time zone 'Europe/London')::date as d,
        coalesce(sum(e.value_pence), 0)::bigint as value
      from events e, win
      where e.org_id = ${orgId}::uuid
        and e.project_id = ${projectId}::uuid
        and ${isRevenue}
        and e.occurred_at >= win.w_start
        and e.occurred_at < win.w_end
      group by 1
    )
    select
      to_char((days.d::timestamp at time zone 'Europe/London') at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS"Z"') as period_start,
      coalesce(rev.value, 0)::bigint as value
    from days
    left join rev on rev.d = days.d
    order by days.d
  `)) as unknown as TrendRow[];

  // ── biggest individual revenue events ───────────────────────────────────────
  const topRows = (await db.execute(sql`
    with ${win}
    select
      e.id as id,
      e.type as type,
      to_char(e.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as occurred_at,
      e.value_pence::bigint as pence,
      coalesce(
        nullif(e.data->>'description', ''),
        nullif(e.data->>'service', ''),
        nullif(e.data->>'plan', ''),
        nullif(e.data->>'name', ''),
        nullif(e.data->>'invoice_id', ''),
        nullif(e.data->>'quote_id', ''),
        nullif(e.data->>'order_id', ''),
        nullif(e.data->>'external_id', ''),
        nullif(e.subject->>'name', '')
      ) as raw_label
    from events e, win
    where e.org_id = ${orgId}::uuid
      and e.project_id = ${projectId}::uuid
      and ${isRevenue}
      and e.occurred_at >= win.w_start
      and e.occurred_at < win.w_end
    order by e.value_pence desc, e.occurred_at desc
    limit 8
  `)) as unknown as TopRow[];

  // ── derive ──────────────────────────────────────────────────────────────────
  const grossRevenuePence = num(agg?.gross_revenue);
  const transactions = num(agg?.txns);
  const refundsPence = num(agg?.refunds);
  const refundsCount = num(agg?.refunds_count);
  const minutesSaved = num(agg?.minutes_saved);

  const runCostPence = num(cost?.run_cost);
  const runCount = num(cost?.run_count);
  // The SQL already coalesces a NULL project rate → DEFAULT, so a returned value
  // (including a deliberate 0 = "don't bill time-saved value") is authoritative.
  // Use nullish coalescing, not `||`, so an explicit £0 rate isn't silently
  // overridden by the default (matches datapack/agency-monthly.ts).
  const hourlyRatePence =
    cost?.hourly_rate === null || cost?.hourly_rate === undefined
      ? DEFAULT_HOURLY_RATE_PENCE
      : num(cost.hourly_rate);

  const netRevenuePence = grossRevenuePence - refundsPence;
  const aovPence =
    transactions > 0 ? Math.round(grossRevenuePence / transactions) : null;
  const hoursSaved = round2(minutesSaved / 60);
  const timeValuePence = Math.round((minutesSaved / 60) * hourlyRatePence);
  const attributedValuePence = netRevenuePence + timeValuePence;
  const roiMultiple =
    runCostPence > 0 ? round2(attributedValuePence / runCostPence) : null;

  const revenueByType: MoneyByType[] = byTypeRows.map((row) => ({
    type: row.type,
    label: typeLabel(row.type),
    pence: num(row.pence),
    count: num(row.cnt),
  }));

  const topValueEvents: MoneyValueEvent[] = topRows.map((row) => ({
    id: row.id,
    type: row.type,
    label: row.raw_label ?? typeLabel(row.type),
    occurredAt: row.occurred_at,
    pence: num(row.pence),
  }));

  // ── P9-PACK3 derive: payback + LTV curve + revenue concentration ───────────
  const buildFeePence = num(cost?.build_fee);
  const monthlyNetRevenuePence = num(monthly30d?.gross_30d) - num(monthly30d?.refunds_30d);
  const monthlyTimeValuePence = Math.round(
    (num(monthly30d?.minutes_saved_30d) / 60) * hourlyRatePence,
  );
  const monthlyAttributedValuePence = monthlyNetRevenuePence + monthlyTimeValuePence;
  const paybackMonths = computePaybackMonths(buildFeePence, monthlyAttributedValuePence);

  const ltvCurve = buildLtvCurve(
    ltvMonthRows.map((row) => ({ month: row.month, pence: num(row.pence) })),
  );
  const clientLtvPence = ltvCurve.length > 0 ? ltvCurve[ltvCurve.length - 1]!.cumulativePence : 0;
  const revenueConcentration = computeRevenueConcentration(clientLtvPence, orgTotalPence);

  const body: MoneyData = {
    range: r.range,
    from: r.fromDay,
    to: r.toDay,
    // MoneyResponse contract: headline pence + revenue series.
    totalPence: netRevenuePence,
    series: trendRows.map((t) => ({
      periodStart: t.period_start,
      value: num(t.value),
    })),
    // added value fields
    grossRevenuePence,
    netRevenuePence,
    refundsPence,
    refundsCount,
    transactions,
    aovPence,
    minutesSaved,
    hoursSaved,
    hourlyRatePence,
    timeValuePence,
    attributedValuePence,
    runCostPence,
    runCount,
    roiMultiple,
    revenueByType,
    topValueEvents,
    buildFeePence,
    monthlyAttributedValuePence,
    paybackMonths,
    ltvCurve,
    revenueConcentration,
  };
  return NextResponse.json(body);
});
