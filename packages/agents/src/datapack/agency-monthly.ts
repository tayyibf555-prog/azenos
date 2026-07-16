import type { Db } from "@azen/db";
import { DEFAULT_HOURLY_RATE_PENCE } from "@azen/config";

/**
 * buildAgencyMonthlyPack — the deterministic Agency Monthly data pack
 * (docs/phase5/CONTRACTS.md §P5-MONTHLY, spec §9.3). Pure SQL over metric_rollups,
 * insights (ALL statuses incl. dismissed — §9.3 "it learns what Tayyib ignores"),
 * weekly briefs, the AGENCY money ledger (subscriptions/payments/expenses), the
 * Phase 2 ROI rollups and the Phase 4 per-project cost attribution, plus the
 * conversation-cluster intelligence. NO raw-event dumps into the prompt — the
 * pack is the sole, auditable source of truth the Monthly Strategist sees, and
 * is what lands in each briefs.dataSnapshot.
 *
 * `monthStartLondon` is the UTC instant of the START of the London calendar
 * month being reported (the same instant londonMonthStartUTC returns and the
 * rollup engine writes for a month bucket's period_start). Every window boundary
 * is derived from it INSIDE Postgres with the shared rollup pattern
 * (`… at time zone 'Europe/London'`) so DST never shifts a bucket.
 *
 * @azen/agents has no drizzle-orm dependency, so every read goes through the
 * postgres-js client (db.$client) with bound params — the same connection and
 * conventions as buildAgencyDailyPack.
 */

// ── shape (docs/phase5/CONTRACTS.md §P5-MONTHLY) ──────────────────────────────

export interface MonthlyKpi {
  key: string;
  name: string;
  unit: string;
  /** this month's month-rollup value, or null when there is no bucket */
  value: number | null;
  /** mean of the prior 3 complete London months, or null with no history */
  prior3Avg: number | null;
  /** value vs prior3Avg as a percentage, or null when it cannot be computed */
  deltaPct: number | null;
  goodDirection: string;
}

/** Phase 2 ROI (§10), reproduced over the month window from day rollups. */
export interface MonthlyRoi {
  revenueAttributedPence: number;
  minutesSaved: number;
  timeValuePence: number;
  hourlyRatePence: number;
  retainerPence: number;
  runCostPence: number;
  /** (revenue + time value) ÷ (retainer + run cost); null when denom is 0 */
  roiMultiple: number | null;
}

/** Phase 4 per-project cost + margin (getCostsByClient / getProjectMargins). */
export interface MonthlyProjectCost {
  clientSystemAiPence: number;
  osAgentPence: number;
  hostingPence: number;
  totalCostPence: number;
  marginPence: number;
}

/** Client-facing value metrics (the per-client value report, ≥80% pasteable). */
export interface MonthlyProjectValue {
  bookingsMade: number;
  conversationsHandled: number;
  /** resolved ÷ handled conversations, 0-1; null when none handled */
  resolvedRate: number | null;
  revenueTouchedPence: number;
  hoursSaved: number;
  minutesSaved: number;
  errorCount: number;
}

export interface MonthlyProject {
  id: string;
  name: string;
  clientId: string;
  clientName: string;
  health: string;
  status: string;
  kpis: MonthlyKpi[];
  roi: MonthlyRoi;
  cost: MonthlyProjectCost;
  value: MonthlyProjectValue;
}

export interface MonthlyInsight {
  projectId: string;
  projectName: string;
  kind: string;
  title: string;
  bodyMd: string;
  confidence: string;
  status: string;
  createdAt: string;
  estimatedValuePence: number | null;
  estimatedHoursSavedMonthly: number | null;
  scoutCandidate: boolean;
}

export interface MonthlyWeeklyBrief {
  id: string;
  periodStart: string;
  headline: string;
  excerptMd: string;
}

export interface MrrBridgeMove {
  clientId: string;
  clientName: string;
  amountPence: number;
}

export interface MrrBridge {
  /** MRR active as of the month START (= prior month end). */
  startPence: number;
  /** New recurring revenue that began this month and is live at month end. */
  gainedPence: number;
  /** Recurring revenue live at month start but cancelled during the month. */
  lostPence: number;
  /** gained − lost. */
  netPence: number;
  /** start + net — the reconciled month-end MRR. */
  endPence: number;
  /** MRR active as of month end, computed directly (a cross-check of endPence). */
  endDirectPence: number;
  gained: MrrBridgeMove[];
  lost: MrrBridgeMove[];
}

/**
 * Phase 8 §P8-BENCH — one anonymised industry-benchmark line for the strategist.
 * clientValue and median are in DISPLAY units (pence / hours / count). Only the
 * subject client's own value + the aggregate peer median escape; no other
 * client's number or identity is ever present. Populated only when the client's
 * industry cleared the ≥3-distinct-client anonymity floor.
 */
export interface MonthlyBenchmarkMetric {
  key: string;
  label: string;
  clientValue: number;
  median: number;
  standing: "ahead" | "near" | "behind";
}

export interface MonthlyClientBenchmark {
  industryName: string;
  /** distinct clients in the industry sample (always ≥3) */
  sampleClients: number;
  metrics: MonthlyBenchmarkMetric[];
}

export interface MonthlyClient {
  clientId: string;
  clientName: string;
  status: string;
  /** a live/representative project id to hang the per-client brief on */
  representativeProjectId: string | null;
  projectIds: string[];
  activeMrrPence: number;
  ltvPence: number;
  paidThisMonthPence: number;
  retainerPence: number;
  aiCostPence: number;
  osCostPence: number;
  roiMultiple: number | null;
  bookingsMade: number;
  conversationsHandled: number;
  resolvedRate: number | null;
  hoursSaved: number;
  revenueTouchedPence: number;
  minutesSaved: number;
  /** automation_opportunity / upsell / scout-flagged clusters — the dossier seed */
  topOpportunities: MonthlyInsight[];
  /** §P8-BENCH: anonymised industry benchmark, or null below the floor / no industry */
  benchmark: MonthlyClientBenchmark | null;
}

export interface MonthlyConversationDigest {
  total: number;
  resolvedRate: number | null;
  escalatedRate: number | null;
  sentiment: { positive: number; neutral: number; negative: number };
  topClusters: {
    projectName: string;
    topic: string;
    count: number;
    sharePct: number;
    trend: string;
  }[];
}

export interface MonthlyAgentActivity {
  agent: string;
  runs: number;
  costPence: number;
}

export interface MonthlyMoneyPoint {
  month: string;
  mrrPence: number;
  cashInPence: number;
  cashOutPence: number;
}

export interface MonthlyPack {
  /** the London calendar month reported (YYYY-MM) */
  forMonth: string;
  /** e.g. "July 2026" */
  monthLabel: string;
  /** when the pack was built (ISO UTC) */
  generatedAt: string;
  agency: {
    mrrPence: number;
    activeClients: number;
    liveProjects: number;
    healthSummary: { green: number; amber: number; red: number };
    cashInPence: number;
    cashOutPence: number;
    netPence: number;
    clientBookingsThisMonth: number;
    recurringExpensesMonthlyPence: number;
    aiSpendPence: number;
  };
  mrrBridge: MrrBridge;
  moneyTrend: MonthlyMoneyPoint[];
  projects: MonthlyProject[];
  clients: MonthlyClient[];
  weeklyBriefs: MonthlyWeeklyBrief[];
  /** the previous monthly owner report, for week/month-over-month continuity */
  priorMonthlyOwnerBrief: { periodStart: string; headline: string } | null;
  /** EVERY insight for the org, any status incl. dismissed (§9.3) */
  insights: MonthlyInsight[];
  insightStatusCounts: Record<string, number>;
  /** the dismissed subset, surfaced so the strategist learns what is ignored */
  dismissedInsights: MonthlyInsight[];
  conversationDigest: MonthlyConversationDigest;
  agentActivity: MonthlyAgentActivity[];
  /** Industry Learning lands in Phase 6 — empty until then (§P5-MONTHLY) */
  knowledgeUpdates: never[];
}

// ── helpers ───────────────────────────────────────────────────────────────────

const round2 = (n: number): number => Math.round(n * 100) / 100;
const num = (v: unknown): number => Number(v ?? 0);
const numOrNull = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v);

/** YYYY-MM-DD of a Date's UTC calendar day (London-month Dates are UTC instants). */
function nextMonthFirstDateStr(monthFirst: string): string {
  const y = Number(monthFirst.slice(0, 4));
  const mo = Number(monthFirst.slice(5, 7)); // 1-based this month → 0-based next
  return new Date(Date.UTC(y, mo, 1)).toISOString().slice(0, 10);
}

// ── window row (all boundaries resolved once, in Postgres) ────────────────────

interface WindowRow {
  for_month: string;
  month_label: string;
  start_utc: string;
  end_utc: string;
  prior3_start_utc: string;
  month_first: string;
  generated_at: string;
}

interface AgencyRow {
  mrr_pence: number;
  active_clients: number;
  live_projects: number;
  green: number;
  amber: number;
  red: number;
  cash_in: number;
  cash_out: number;
  client_bookings: number;
  recurring_expenses: number;
  ai_spend: number;
}

interface ProjectRow {
  id: string;
  name: string;
  client_id: string;
  client_name: string;
  health: string;
  status: string;
  retainer_pence: number;
  hourly_rate_pence: number | null;
}

interface ProjectAggRow {
  project_id: string;
  revenue_attributed: number;
  minutes_saved: number;
  tokens_cost_pence: number;
  os_agent_pence: number;
  hosting_pence: number;
  bookings_made: number;
  conversations: number;
  resolved: number;
  errors: number;
}

interface KpiRow {
  key: string;
  name: string;
  unit: string;
  good_direction: string;
  value: number | null;
  prior3_avg: number | null;
}

interface InsightRow {
  project_id: string;
  project_name: string;
  kind: string;
  title: string;
  body_md: string;
  confidence: string;
  status: string;
  created_at: string;
  estimated_value_pence: number | null;
  estimated_hours_saved_monthly: number | null;
  evidence: Record<string, unknown> | null;
}

interface WeeklyBriefRow {
  id: string;
  period_start: string;
  headline: string;
  body_md: string;
}

interface SubRow {
  client_id: string;
  client_name: string;
  amount_pence_monthly: number;
  status: string;
  started_at: string;
  cancelled_at: string | null;
}

interface ClientRevenueRow {
  client_id: string;
  ltv: number;
  paid_this_month: number;
  active_mrr: number;
}

interface ClientMetaRow {
  id: string;
  name: string;
  status: string;
}

interface ConvoAggRow {
  total: number;
  resolved: number;
  escalated: number;
  positive: number;
  neutral: number;
  negative: number;
}

interface ClusterRow {
  project_name: string;
  topic: string;
  count: number;
  share_pct: number;
  trend: string;
}

interface AgentActivityRow {
  agent: string;
  runs: number;
  pence: number;
}

interface MoneyMonthRow {
  month: string;
  cash_in: number;
  cash_out: number;
}

const EXCERPT_MAX = 600;

function toInsight(r: InsightRow): MonthlyInsight {
  const evidence = r.evidence ?? {};
  return {
    projectId: r.project_id,
    projectName: r.project_name,
    kind: r.kind,
    title: r.title,
    bodyMd: r.body_md,
    confidence: r.confidence,
    status: r.status,
    createdAt: r.created_at,
    estimatedValuePence: numOrNull(r.estimated_value_pence),
    estimatedHoursSavedMonthly: numOrNull(r.estimated_hours_saved_monthly),
    scoutCandidate: evidence["scout_candidate"] === true,
  };
}

// ── §P8-BENCH anonymised industry benchmarks ──────────────────────────────────

/**
 * Headline benchmark metrics — day-rollup keys with clean, client-comparable
 * semantics that match the shared value report's tiles. All are goodDirection
 * 'up', so higher = ahead of the median. toDisplay is monotonic, so applying it
 * after the percentile is equivalent (pence / hours / count display units).
 */
const BENCH_KEYS = [
  { key: "revenue_attributed", label: "Value delivered", toDisplay: (r: number) => Math.round(r) },
  { key: "minutes_saved", label: "Hours saved", toDisplay: (r: number) => Math.round((r / 60) * 10) / 10 },
  { key: "conversations", label: "Conversations handled", toDisplay: (r: number) => Math.round(r) },
] as const;

/** Anonymity floor: an industry with fewer distinct clients gets no benchmark. */
const BENCH_FLOOR = 3;

/** Linear-interpolation percentile (numpy / percentile_cont), p in [0,1]. */
function percentileAt(sortedAsc: number[], p: number): number {
  const n = sortedAsc.length;
  if (n === 0) return 0;
  if (n === 1) return sortedAsc[0]!;
  const rank = p * (n - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sortedAsc[lo]!;
  return sortedAsc[lo]! + (rank - lo) * (sortedAsc[hi]! - sortedAsc[lo]!);
}

function benchStanding(value: number, median: number): "ahead" | "near" | "behind" {
  if (median <= 0) return value > 0 ? "ahead" : "near";
  const ratio = value / median;
  if (ratio >= 0.95 && ratio <= 1.05) return "near";
  return value > median ? "ahead" : "behind";
}

interface BenchRow {
  industry_id: string;
  client_id: string;
  metric_key: string;
  value: number;
}

/**
 * Per-client × per-metric monthly aggregates grouped by industry, reduced to one
 * anonymised benchmark line per client — but ONLY for industries that cleared
 * the ≥3-distinct-client floor. Same window + live-project filter + percentile
 * math as the web-side lib/server/benchmarks.ts (kept in lock-step by design).
 * Clients with live projects but no rollup for a metric count as a real 0.
 */
async function computeMonthlyBenchmarks(
  db: Db,
  orgId: string,
  startUTC: string,
  endUTC: string,
): Promise<Map<string, MonthlyClientBenchmark>> {
  const client = db.$client;
  const keys = BENCH_KEYS.map((k) => k.key);

  const rows = (await client`
    with live as (
      select cl.industry_id, cl.id as client_id, p.id as project_id
      from clients cl
      join projects p on p.client_id = cl.id and p.status = 'live'
      where cl.org_id = ${orgId}::uuid and cl.industry_id is not null
    ),
    client_set as (select distinct industry_id, client_id from live),
    keys as (select unnest(${keys}::text[]) as metric_key)
    select cs.industry_id::text as industry_id, cs.client_id::text as client_id,
      k.metric_key as metric_key,
      coalesce(sum(r.value), 0)::float8 as value
    from client_set cs
    cross join keys k
    left join live l on l.client_id = cs.client_id
    left join metric_rollups r on r.project_id = l.project_id
      and r.metric_key = k.metric_key and r.period = 'day'
      and r.period_start >= ${startUTC}::timestamptz and r.period_start < ${endUTC}::timestamptz
    group by cs.industry_id, cs.client_id, k.metric_key
  `) as unknown as BenchRow[];

  const nameRows = (await client`
    select id::text as id, name from industries where org_id = ${orgId}::uuid
  `) as unknown as { id: string; name: string }[];
  const nameById = new Map(nameRows.map((r) => [r.id, r.name] as const));

  const byIndustry = new Map<
    string,
    { clients: Set<string>; perClient: Map<string, Map<string, number>> }
  >();
  for (const row of rows) {
    let g = byIndustry.get(row.industry_id);
    if (!g) {
      g = { clients: new Set(), perClient: new Map() };
      byIndustry.set(row.industry_id, g);
    }
    g.clients.add(row.client_id);
    let pc = g.perClient.get(row.client_id);
    if (!pc) {
      pc = new Map();
      g.perClient.set(row.client_id, pc);
    }
    pc.set(row.metric_key, Number(row.value));
  }

  const out = new Map<string, MonthlyClientBenchmark>();
  for (const [industryId, g] of byIndustry) {
    const clientIds = [...g.clients];
    if (clientIds.length < BENCH_FLOOR) continue; // anonymity floor
    const industryName = nameById.get(industryId) ?? "industry";

    const medianByKey = new Map<string, number>();
    const signalByKey = new Map<string, boolean>();
    for (const spec of BENCH_KEYS) {
      const values = clientIds
        .map((id) => g.perClient.get(id)?.get(spec.key) ?? 0)
        .sort((a, b) => a - b);
      medianByKey.set(spec.key, percentileAt(values, 0.5));
      // Zero-signal gate — MUST match the web lib (lib/server/benchmarks.ts:
      // `raw.p75 <= 0 && subject <= 0` skips): gate the peer signal on p75 > 0,
      // NOT max > 0. Gating on max let a lone top client (p75 = 0) surface a bar
      // here that the shared report / Client 360 hid, so the same client saw a
      // peer comparison in the Monthly Strategist but not in the report.
      signalByKey.set(spec.key, percentileAt(values, 0.75) > 0);
    }

    for (const clientId of clientIds) {
      const metrics: MonthlyBenchmarkMetric[] = [];
      for (const spec of BENCH_KEYS) {
        const rawClient = g.perClient.get(clientId)?.get(spec.key) ?? 0;
        if (!signalByKey.get(spec.key) && rawClient <= 0) continue; // no signal
        const clientValue = spec.toDisplay(rawClient);
        const median = spec.toDisplay(medianByKey.get(spec.key) ?? 0);
        metrics.push({
          key: spec.key,
          label: spec.label,
          clientValue,
          median,
          standing: benchStanding(clientValue, median),
        });
      }
      if (metrics.length === 0) continue;
      out.set(clientId, {
        industryName,
        sampleClients: clientIds.length,
        metrics,
      });
    }
  }
  return out;
}

export async function buildAgencyMonthlyPack(
  db: Db,
  orgId: string,
  monthStartLondon: Date,
): Promise<MonthlyPack> {
  const client = db.$client;
  const ms = monthStartLondon.toISOString();

  // ── window boundaries (this month + prior-3-month baseline), DST-safe ───────
  const winRows = (await client`
    with base as (select ${ms}::timestamptz as month_start_utc)
    select
      to_char(month_start_utc at time zone 'Europe/London', 'YYYY-MM') as for_month,
      to_char(month_start_utc at time zone 'Europe/London', 'FMMonth YYYY') as month_label,
      to_char(month_start_utc, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as start_utc,
      to_char(((month_start_utc at time zone 'Europe/London' + interval '1 month') at time zone 'Europe/London'), 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as end_utc,
      to_char(((month_start_utc at time zone 'Europe/London' - interval '3 months') at time zone 'Europe/London'), 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as prior3_start_utc,
      to_char(month_start_utc at time zone 'Europe/London', 'YYYY-MM-DD') as month_first,
      to_char(month_start_utc at time zone 'Europe/London', 'YYYY-MM') as ym,
      to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as generated_at
    from base
  `) as unknown as (WindowRow & { ym: string })[];
  const w = winRows[0]!;
  const start = w.start_utc;
  const end = w.end_utc;
  const monthFirst = w.month_first;
  const nextFirst = nextMonthFirstDateStr(monthFirst);

  // ── agency scalar summary (money ledger + health + booking count) ───────────
  const agencyRows = (await client`
    select
      (select coalesce(sum(amount_pence_monthly), 0)::float8 from subscriptions
         where org_id = ${orgId}::uuid and status = 'active') as mrr_pence,
      (select count(*)::int from clients
         where org_id = ${orgId}::uuid and status = 'active') as active_clients,
      (select count(*)::int from projects
         where org_id = ${orgId}::uuid and status = 'live') as live_projects,
      (select count(*)::int from projects
         where org_id = ${orgId}::uuid and status not in ('completed','cancelled') and health = 'green') as green,
      (select count(*)::int from projects
         where org_id = ${orgId}::uuid and status not in ('completed','cancelled') and health = 'amber') as amber,
      (select count(*)::int from projects
         where org_id = ${orgId}::uuid and status not in ('completed','cancelled') and health = 'red') as red,
      (select coalesce(sum(amount_pence), 0)::float8 from payments
         where org_id = ${orgId}::uuid and status = 'paid'
           and paid_at >= ${start}::timestamptz and paid_at < ${end}::timestamptz) as cash_in,
      (select coalesce(sum(amount_pence), 0)::float8 from expenses
         where org_id = ${orgId}::uuid and period = ${w.ym}) as cash_out,
      (select count(*)::int from bookings
         where org_id = ${orgId}::uuid and kind = 'client_end_customer'
           and starts_at >= ${start}::timestamptz and starts_at < ${end}::timestamptz) as client_bookings,
      (select coalesce(sum(amount_pence), 0)::float8 from expenses
         where org_id = ${orgId}::uuid and recurring = true and period = ${w.ym}) as recurring_expenses,
      (select coalesce(sum(cost_estimate_pence), 0)::float8 from agent_runs
         where org_id = ${orgId}::uuid
           and started_at >= ${start}::timestamptz and started_at < ${end}::timestamptz) as ai_spend
  `) as unknown as AgencyRow[];
  const a = agencyRows[0]!;

  // ── projects (static columns) ───────────────────────────────────────────────
  const projectRows = (await client`
    select p.id::text as id, p.name as name, p.client_id::text as client_id,
      coalesce(cl.name, '') as client_name, p.health::text as health, p.status::text as status,
      p.retainer_pence_monthly::float8 as retainer_pence, p.hourly_rate_pence as hourly_rate_pence
    from projects p
    left join clients cl on cl.id = p.client_id
    where p.org_id = ${orgId}::uuid and p.status not in ('completed','cancelled')
    order by cl.name, p.name
  `) as unknown as ProjectRow[];

  // ── per-project monthly aggregates (ROI rollups + costs + value metrics) ────
  const aggRows = (await client`
    select
      p.id::text as project_id,
      coalesce((select sum(r.value) from metric_rollups r
        where r.project_id = p.id and r.metric_key = 'revenue_attributed' and r.period = 'day'
          and r.period_start >= ${start}::timestamptz and r.period_start < ${end}::timestamptz), 0)::float8 as revenue_attributed,
      coalesce((select sum(r.value) from metric_rollups r
        where r.project_id = p.id and r.metric_key = 'minutes_saved' and r.period = 'day'
          and r.period_start >= ${start}::timestamptz and r.period_start < ${end}::timestamptz), 0)::float8 as minutes_saved,
      coalesce((select sum(r.value) from metric_rollups r
        where r.project_id = p.id and r.metric_key = 'tokens_cost_pence' and r.period = 'day'
          and r.period_start >= ${start}::timestamptz and r.period_start < ${end}::timestamptz), 0)::float8 as tokens_cost_pence,
      coalesce((select sum(ar.cost_estimate_pence) from agent_runs ar
        where ar.project_id = p.id
          and ar.started_at >= ${start}::timestamptz and ar.started_at < ${end}::timestamptz), 0)::float8 as os_agent_pence,
      coalesce((select sum(e.amount_pence) from expenses e
        where e.project_id = p.id and e.period = ${w.ym}), 0)::float8 as hosting_pence,
      coalesce((select count(*) from bookings b
        where b.project_id = p.id and b.kind = 'client_end_customer'
          and b.starts_at >= ${start}::timestamptz and b.starts_at < ${end}::timestamptz), 0)::int as bookings_made,
      coalesce((select count(*) from events ev
        where ev.project_id = p.id and ev.type = 'llm.conversation'
          and ev.occurred_at >= ${start}::timestamptz and ev.occurred_at < ${end}::timestamptz), 0)::int as conversations,
      coalesce((select count(*) from events ev
        where ev.project_id = p.id and ev.type = 'llm.conversation' and ev.data->>'resolution' = 'resolved'
          and ev.occurred_at >= ${start}::timestamptz and ev.occurred_at < ${end}::timestamptz), 0)::int as resolved,
      coalesce((select count(*) from events ev
        where ev.project_id = p.id and ev.type = 'system.error'
          and ev.occurred_at >= ${start}::timestamptz and ev.occurred_at < ${end}::timestamptz), 0)::int as errors
    from projects p
    where p.org_id = ${orgId}::uuid and p.status not in ('completed','cancelled')
  `) as unknown as ProjectAggRow[];
  const aggByProject = new Map<string, ProjectAggRow>();
  for (const r of aggRows) aggByProject.set(r.project_id, r);

  // ── per-project KPIs (effective global∪override defs, isKpi; month vs prior-3) ─
  const projects: MonthlyProject[] = [];
  for (const p of projectRows) {
    const kpiRows = (await client`
      with eff as (
        select distinct on (key)
          key, name, unit, good_direction::text as good_direction, is_kpi, sort
        from metric_definitions
        where org_id = ${orgId}::uuid and (project_id = ${p.id}::uuid or project_id is null)
        order by key, (project_id is not null) desc
      )
      select
        e.key as key, e.name as name, e.unit::text as unit, e.good_direction as good_direction,
        (select r.value from metric_rollups r
           where r.project_id = ${p.id}::uuid and r.metric_key = e.key
             and r.period = 'month' and r.period_start = ${start}::timestamptz)::float8 as value,
        (select avg(r.value) from metric_rollups r
           where r.project_id = ${p.id}::uuid and r.metric_key = e.key and r.period = 'month'
             and r.period_start >= ${w.prior3_start_utc}::timestamptz
             and r.period_start < ${start}::timestamptz)::float8 as prior3_avg
      from eff e
      where e.is_kpi = true
      order by e.sort, e.key
    `) as unknown as KpiRow[];

    const kpis: MonthlyKpi[] = kpiRows.map((k) => {
      const value = numOrNull(k.value);
      const prior3Avg = numOrNull(k.prior3_avg);
      const deltaPct =
        value !== null && prior3Avg !== null && prior3Avg !== 0
          ? round2(((value - prior3Avg) / prior3Avg) * 100)
          : null;
      return {
        key: k.key,
        name: k.name,
        unit: k.unit,
        value: value === null ? null : round2(value),
        prior3Avg: prior3Avg === null ? null : round2(prior3Avg),
        deltaPct,
        goodDirection: k.good_direction,
      };
    });

    const agg = aggByProject.get(p.id);
    const revenueAttributedPence = Math.round(num(agg?.revenue_attributed));
    const minutesSaved = num(agg?.minutes_saved);
    const runCostPence = Math.round(num(agg?.tokens_cost_pence));
    const osAgentPence = Math.round(num(agg?.os_agent_pence));
    const hostingPence = Math.round(num(agg?.hosting_pence));
    const retainerPence = Math.round(num(p.retainer_pence));
    const hourlyRatePence = p.hourly_rate_pence ?? DEFAULT_HOURLY_RATE_PENCE;
    const timeValuePence = Math.round((minutesSaved / 60) * hourlyRatePence);
    const numeratorPence = revenueAttributedPence + timeValuePence;
    const denominatorPence = retainerPence + runCostPence;
    const roiMultiple =
      denominatorPence > 0 ? round2(numeratorPence / denominatorPence) : null;
    const totalCostPence = runCostPence + osAgentPence + hostingPence;
    const conversations = num(agg?.conversations);
    const resolved = num(agg?.resolved);

    projects.push({
      id: p.id,
      name: p.name,
      clientId: p.client_id,
      clientName: p.client_name,
      health: p.health,
      status: p.status,
      kpis,
      roi: {
        revenueAttributedPence,
        minutesSaved,
        timeValuePence,
        hourlyRatePence,
        retainerPence,
        runCostPence,
        roiMultiple,
      },
      cost: {
        clientSystemAiPence: runCostPence,
        osAgentPence,
        hostingPence,
        totalCostPence,
        marginPence: retainerPence - totalCostPence,
      },
      value: {
        bookingsMade: num(agg?.bookings_made),
        conversationsHandled: conversations,
        resolvedRate: conversations > 0 ? round2(resolved / conversations) : null,
        revenueTouchedPence: revenueAttributedPence,
        hoursSaved: round2(minutesSaved / 60),
        minutesSaved,
        errorCount: num(agg?.errors),
      },
    });
  }

  // ── ALL insights, any status incl. dismissed (§9.3) ─────────────────────────
  const insightRows = (await client`
    select i.project_id::text as project_id, coalesce(p.name, '') as project_name,
      i.kind::text as kind, i.title, i.body_md, i.confidence::text as confidence,
      i.status::text as status,
      to_char(i.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as created_at,
      i.estimated_value_pence, i.estimated_hours_saved_monthly, i.evidence
    from insights i
    left join projects p on p.id = i.project_id
    where i.org_id = ${orgId}::uuid
    order by i.created_at desc
  `) as unknown as InsightRow[];
  const insights = insightRows.map(toInsight);
  const insightStatusCounts: Record<string, number> = {};
  for (const i of insights) {
    insightStatusCounts[i.status] = (insightStatusCounts[i.status] ?? 0) + 1;
  }
  const dismissedInsights = insights.filter((i) => i.status === "dismissed");

  // ── weekly briefs this month + the prior monthly owner report ───────────────
  const weeklyRows = (await client`
    select id::text as id,
      to_char(period_start at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as period_start,
      headline, body_md
    from briefs
    where org_id = ${orgId}::uuid and period = 'weekly'
      and period_start >= ${start}::timestamptz and period_start < ${end}::timestamptz
    order by period_start asc
  `) as unknown as WeeklyBriefRow[];
  const weeklyBriefs: MonthlyWeeklyBrief[] = weeklyRows.map((r) => ({
    id: r.id,
    periodStart: r.period_start,
    headline: r.headline,
    excerptMd:
      r.body_md.length > EXCERPT_MAX
        ? `${r.body_md.slice(0, EXCERPT_MAX).trimEnd()}…`
        : r.body_md,
  }));

  const priorMonthlyRows = (await client`
    select to_char(period_start at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as period_start, headline
    from briefs
    where org_id = ${orgId}::uuid and scope = 'agency' and period = 'monthly'
      and period_start < ${start}::timestamptz
    order by period_start desc
    limit 1
  `) as unknown as { period_start: string; headline: string }[];
  const priorMonthlyOwnerBrief = priorMonthlyRows[0]
    ? {
        periodStart: priorMonthlyRows[0].period_start,
        headline: priorMonthlyRows[0].headline,
      }
    : null;

  // ── MRR bridge (JS from raw sub rows; date-string compares are DST-immune) ──
  const subRows = (await client`
    select s.client_id::text as client_id, coalesce(c.name, '') as client_name,
      s.amount_pence_monthly::float8 as amount_pence_monthly, s.status::text as status,
      to_char(s.started_at, 'YYYY-MM-DD') as started_at,
      case when s.cancelled_at is null then null else to_char(s.cancelled_at, 'YYYY-MM-DD') end as cancelled_at
    from subscriptions s
    left join clients c on c.id = s.client_id
    where s.org_id = ${orgId}::uuid
  `) as unknown as SubRow[];
  const mrrBridge = computeMrrBridge(subRows, monthFirst, nextFirst);

  // ── per-client revenue (agency ledger) + value rollup + dossier seed ────────
  const clientRevRows = (await client`
    select c.id::text as client_id,
      coalesce((select sum(p.amount_pence) from payments p
        where p.client_id = c.id and p.org_id = ${orgId}::uuid and p.status = 'paid'), 0)::float8 as ltv,
      coalesce((select sum(p.amount_pence) from payments p
        where p.client_id = c.id and p.org_id = ${orgId}::uuid and p.status = 'paid'
          and p.paid_at >= ${start}::timestamptz and p.paid_at < ${end}::timestamptz), 0)::float8 as paid_this_month,
      coalesce((select sum(s.amount_pence_monthly) from subscriptions s
        where s.client_id = c.id and s.org_id = ${orgId}::uuid and s.status = 'active'), 0)::float8 as active_mrr
    from clients c
    where c.org_id = ${orgId}::uuid
  `) as unknown as ClientRevenueRow[];
  const revByClient = new Map<string, ClientRevenueRow>();
  for (const r of clientRevRows) revByClient.set(r.client_id, r);

  const clientMetaRows = (await client`
    select id::text as id, name, status::text as status
    from clients where org_id = ${orgId}::uuid
    order by name
  `) as unknown as ClientMetaRow[];

  // §P8-BENCH: anonymised industry benchmarks (same month window), one line per
  // client whose industry cleared the ≥3-distinct-client floor.
  const benchmarkByClient = await computeMonthlyBenchmarks(db, orgId, start, end);

  const clients = buildClients(
    clientMetaRows,
    projects,
    insights,
    revByClient,
    benchmarkByClient,
  );

  // ── conversation digest (org-wide this month) + top clusters ────────────────
  const convoRows = (await client`
    select
      count(*)::int as total,
      count(*) filter (where data->>'resolution' = 'resolved')::int as resolved,
      count(*) filter (where data->>'resolution' = 'escalated')::int as escalated,
      count(*) filter (where data->>'sentiment' = 'positive')::int as positive,
      count(*) filter (where data->>'sentiment' = 'neutral')::int as neutral,
      count(*) filter (where data->>'sentiment' = 'negative')::int as negative
    from events
    where org_id = ${orgId}::uuid and type = 'llm.conversation'
      and occurred_at >= ${start}::timestamptz and occurred_at < ${end}::timestamptz
  `) as unknown as ConvoAggRow[];
  const cv = convoRows[0]!;
  const convoTotal = num(cv.total);

  const clusterRows = (await client`
    select coalesce(p.name, '') as project_name, i.title as topic,
      coalesce((i.evidence->>'count')::float8, 0) as count,
      coalesce((i.evidence->>'share_pct')::float8, 0) as share_pct,
      coalesce(i.evidence->>'trend', 'flat') as trend
    from insights i
    left join projects p on p.id = i.project_id
    where i.org_id = ${orgId}::uuid and i.kind = 'faq_cluster' and i.status <> 'dismissed'
    order by (i.evidence->>'count')::float8 desc nulls last, i.title
    limit 12
  `) as unknown as ClusterRow[];

  const conversationDigest: MonthlyConversationDigest = {
    total: convoTotal,
    resolvedRate: convoTotal > 0 ? round2(num(cv.resolved) / convoTotal) : null,
    escalatedRate: convoTotal > 0 ? round2(num(cv.escalated) / convoTotal) : null,
    sentiment: {
      positive: num(cv.positive),
      neutral: num(cv.neutral),
      negative: num(cv.negative),
    },
    topClusters: clusterRows.map((r) => ({
      projectName: r.project_name,
      topic: r.topic,
      count: Math.round(num(r.count)),
      sharePct: round2(num(r.share_pct)),
      trend: r.trend,
    })),
  };

  // ── agent activity this month (where the OS's AI spend went) ─────────────────
  const activityRows = (await client`
    select agent::text as agent, count(*)::int as runs,
      coalesce(sum(cost_estimate_pence), 0)::float8 as pence
    from agent_runs
    where org_id = ${orgId}::uuid
      and started_at >= ${start}::timestamptz and started_at < ${end}::timestamptz
    group by agent
    order by pence desc, agent
  `) as unknown as AgentActivityRow[];
  const agentActivity: MonthlyAgentActivity[] = activityRows.map((r) => ({
    agent: r.agent,
    runs: num(r.runs),
    costPence: Math.round(num(r.pence)),
  }));

  // ── money trend (this + prior 3 London months): MRR end + cash flows ────────
  const moneyRows = (await client`
    with months as (
      select to_char((${start}::timestamptz at time zone 'Europe/London' - make_interval(months => g)), 'YYYY-MM') as ym
      from generate_series(0, 3) g
    )
    select m.ym as month,
      coalesce((select sum(p.amount_pence) from payments p
        where p.org_id = ${orgId}::uuid and p.status = 'paid'
          and to_char(p.paid_at at time zone 'Europe/London', 'YYYY-MM') = m.ym), 0)::float8 as cash_in,
      coalesce((select sum(e.amount_pence) from expenses e
        where e.org_id = ${orgId}::uuid and e.period = m.ym), 0)::float8 as cash_out
    from months m
    order by m.ym asc
  `) as unknown as MoneyMonthRow[];
  const moneyTrend: MonthlyMoneyPoint[] = moneyRows.map((r) => ({
    month: r.month,
    mrrPence: mrrForMonthEnd(subRows, `${r.month}-01`),
    cashInPence: Math.round(num(r.cash_in)),
    cashOutPence: Math.round(num(r.cash_out)),
  }));

  const cashIn = Math.round(num(a.cash_in));
  const cashOut = Math.round(num(a.cash_out));

  return {
    forMonth: w.for_month,
    monthLabel: w.month_label,
    generatedAt: w.generated_at,
    agency: {
      mrrPence: Math.round(num(a.mrr_pence)),
      activeClients: num(a.active_clients),
      liveProjects: num(a.live_projects),
      healthSummary: { green: num(a.green), amber: num(a.amber), red: num(a.red) },
      cashInPence: cashIn,
      cashOutPence: cashOut,
      netPence: cashIn - cashOut,
      clientBookingsThisMonth: num(a.client_bookings),
      recurringExpensesMonthlyPence: Math.round(num(a.recurring_expenses)),
      aiSpendPence: Math.round(num(a.ai_spend)),
    },
    mrrBridge,
    moneyTrend,
    projects,
    clients,
    weeklyBriefs,
    priorMonthlyOwnerBrief,
    insights,
    insightStatusCounts,
    dismissedInsights,
    conversationDigest,
    agentActivity,
    knowledgeUpdates: [],
  };
}

// ── MRR bridge math (mirrors apps/web money.ts mrrForMonth date-string logic) ──

/** MRR active as of a month's END (exclusive next-month-first), from raw subs. */
function mrrForMonthEnd(subRows: SubRow[], monthFirst: string): number {
  const endExclusive = nextMonthFirstDateStr(monthFirst);
  let sum = 0;
  for (const s of subRows) {
    if (s.status !== "active" && s.status !== "cancelled") continue;
    if (s.started_at >= endExclusive) continue;
    if (s.cancelled_at !== null && s.cancelled_at < endExclusive) continue;
    sum += s.amount_pence_monthly;
  }
  return Math.round(sum);
}

/**
 * Standard MRR bridge over [monthFirst, nextFirst). A subscription counts to the
 * month START if it was live at monthFirst (started before, not yet cancelled);
 * GAINED = live at end but not at start (began this month); LOST = live at start
 * but not at end (cancelled this month). end = start + gained − lost reconciles
 * exactly because a sub live at both boundaries cancels out and a sub that both
 * started and ended within the month counts to neither. Only active/cancelled
 * subs carry recurring revenue; paused/past_due never do.
 */
function computeMrrBridge(
  subRows: SubRow[],
  monthFirst: string,
  nextFirst: string,
): MrrBridge {
  const liveAt = (s: SubRow, boundary: string): boolean => {
    if (s.status !== "active" && s.status !== "cancelled") return false;
    if (s.started_at >= boundary) return false;
    if (s.cancelled_at !== null && s.cancelled_at < boundary) return false;
    return true;
  };

  let startPence = 0;
  let gainedPence = 0;
  let lostPence = 0;
  const gained: MrrBridgeMove[] = [];
  const lost: MrrBridgeMove[] = [];

  for (const s of subRows) {
    const atStart = liveAt(s, monthFirst);
    const atEnd = liveAt(s, nextFirst);
    if (atStart) startPence += s.amount_pence_monthly;
    if (atEnd && !atStart) {
      gainedPence += s.amount_pence_monthly;
      gained.push({
        clientId: s.client_id,
        clientName: s.client_name,
        amountPence: Math.round(s.amount_pence_monthly),
      });
    } else if (atStart && !atEnd) {
      lostPence += s.amount_pence_monthly;
      lost.push({
        clientId: s.client_id,
        clientName: s.client_name,
        amountPence: Math.round(s.amount_pence_monthly),
      });
    }
  }

  const netPence = gainedPence - lostPence;
  return {
    startPence: Math.round(startPence),
    gainedPence: Math.round(gainedPence),
    lostPence: Math.round(lostPence),
    netPence: Math.round(netPence),
    endPence: Math.round(startPence + netPence),
    endDirectPence: mrrForMonthEnd(subRows, monthFirst),
    gained,
    lost,
  };
}

// ── per-client value rollup + dossier seed ────────────────────────────────────

/** Insight kinds that seed an upsell dossier (§P5-MONTHLY doc 3). */
function isOpportunity(i: MonthlyInsight): boolean {
  if (i.status === "dismissed") return false;
  if (i.kind === "automation_opportunity" || i.kind === "upsell") return true;
  if (i.kind === "faq_cluster" && i.scoutCandidate) return true;
  return false;
}

function buildClients(
  clientMeta: ClientMetaRow[],
  projects: MonthlyProject[],
  insights: MonthlyInsight[],
  revByClient: Map<string, ClientRevenueRow>,
  benchmarkByClient: Map<string, MonthlyClientBenchmark>,
): MonthlyClient[] {
  const projectsByClient = new Map<string, MonthlyProject[]>();
  for (const p of projects) {
    const list = projectsByClient.get(p.clientId) ?? [];
    list.push(p);
    projectsByClient.set(p.clientId, list);
  }

  const opportunitiesByClient = new Map<string, MonthlyInsight[]>();
  const projectClient = new Map(projects.map((p) => [p.id, p.clientId] as const));
  for (const i of insights) {
    if (!isOpportunity(i)) continue;
    const clientId = projectClient.get(i.projectId);
    if (!clientId) continue;
    const list = opportunitiesByClient.get(clientId) ?? [];
    list.push(i);
    opportunitiesByClient.set(clientId, list);
  }

  const out: MonthlyClient[] = [];
  for (const meta of clientMeta) {
    const clientProjects = projectsByClient.get(meta.id) ?? [];
    // Representative project for the per-client brief: first live, else first.
    const representative =
      clientProjects.find((p) => p.status === "live") ?? clientProjects[0] ?? null;

    let retainerPence = 0;
    let aiCostPence = 0;
    let osCostPence = 0;
    let numeratorPence = 0;
    let denominatorPence = 0;
    let bookingsMade = 0;
    let conversationsHandled = 0;
    let resolvedCount = 0;
    let revenueTouchedPence = 0;
    let minutesSaved = 0;
    for (const p of clientProjects) {
      retainerPence += p.roi.retainerPence;
      aiCostPence += p.cost.clientSystemAiPence;
      osCostPence += p.cost.osAgentPence;
      numeratorPence += p.roi.revenueAttributedPence + p.roi.timeValuePence;
      denominatorPence += p.roi.retainerPence + p.roi.runCostPence;
      bookingsMade += p.value.bookingsMade;
      conversationsHandled += p.value.conversationsHandled;
      resolvedCount += Math.round(
        (p.value.resolvedRate ?? 0) * p.value.conversationsHandled,
      );
      revenueTouchedPence += p.value.revenueTouchedPence;
      minutesSaved += p.value.minutesSaved;
    }

    const rev = revByClient.get(meta.id);
    const topOpportunities = (opportunitiesByClient.get(meta.id) ?? [])
      .sort(
        (x, y) =>
          (y.estimatedValuePence ?? 0) - (x.estimatedValuePence ?? 0) ||
          confidenceRank(y.confidence) - confidenceRank(x.confidence),
      )
      .slice(0, 8);

    out.push({
      clientId: meta.id,
      clientName: meta.name,
      status: meta.status,
      representativeProjectId: representative ? representative.id : null,
      projectIds: clientProjects.map((p) => p.id),
      activeMrrPence: Math.round(num(rev?.active_mrr)),
      ltvPence: Math.round(num(rev?.ltv)),
      paidThisMonthPence: Math.round(num(rev?.paid_this_month)),
      retainerPence,
      aiCostPence,
      osCostPence,
      roiMultiple:
        denominatorPence > 0 ? round2(numeratorPence / denominatorPence) : null,
      bookingsMade,
      conversationsHandled,
      resolvedRate:
        conversationsHandled > 0
          ? round2(resolvedCount / conversationsHandled)
          : null,
      hoursSaved: round2(minutesSaved / 60),
      revenueTouchedPence,
      minutesSaved,
      topOpportunities,
      benchmark: benchmarkByClient.get(meta.id) ?? null,
    });
  }
  return out;
}

function confidenceRank(c: string): number {
  return c === "high" ? 3 : c === "med" ? 2 : 1;
}
