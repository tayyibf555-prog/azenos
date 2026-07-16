import type { Db } from "@azen/db";

/**
 * buildAgencyWeeklyPack — the deterministic Agency Weekly data pack (spec §9.2;
 * docs/phase5/CONTRACTS.md §P5-WEEKLY). Same runner discipline as
 * buildAgencyDailyPack: pure SQL over the events spine, briefs, insights,
 * subscriptions/payments and bookings — NEVER a raw-event dump into the prompt.
 * The Weekly Synthesizer receives this curated JSON and never touches the DB.
 *
 * `weekStartLondon` is the UTC instant of the London week START (Monday 00:00
 * London) of the week being summarised. Every window boundary is derived inside
 * Postgres from it with the shared rollup bucket pattern
 * (`… at time zone 'Europe/London'`), so every boundary is DST-correct. The pack
 * covers the 7-day window [weekStart, weekStart+7d); "last week" is the 7 days
 * before it and "prior 4 weeks" the 28 days before it.
 *
 * drizzle-orm is not a dependency of this package, so queries run through the
 * postgres-js client (`db.$client`) — the same connection the rest of the OS
 * uses (matching buildAgencyDailyPack / buildConvoClusterPack).
 *
 * AGENCY SCOREBOARD NOTE (reported to the lead): the scoreboard KPIs are the
 * agency-wide ADDITIVE outcomes computed straight from the events spine
 * (revenue, minutes saved, conversations, client bookings, errors) plus their
 * matching last-week and prior-4-week figures. Per-project week rollups exist in
 * metric_rollups, but summing them agency-wide is only correct for additive
 * aggregations (sum/count) and silently wrong for avg/p95/rate metrics — so the
 * agency scoreboard is built from the raw additive spine, which is unambiguous
 * and DST-safe. Per-metric_rollup detail stays a per-project concern (the daily
 * pack). Switch to a rollup-driven scoreboard if the lead adds an agency-level
 * aggregation policy.
 */

const round2 = (n: number): number => Math.round(n * 100) / 100;
const num = (v: unknown): number => Number(v ?? 0);

// ── pack shape (the contract between the pack builder and the Weekly agent) ────

export interface WeeklyPackScoreboardKpi {
  key: string;
  name: string;
  /** 'pence' | 'minutes' | 'count' */
  unit: string;
  goodDirection: "up" | "down";
  thisWeek: number;
  lastWeek: number;
  /** mean weekly value across the prior 4 complete weeks, or null with no history */
  fourWeekAvg: number | null;
  /** thisWeek vs lastWeek as a percentage, or null when it cannot be computed */
  deltaPctVsLastWeek: number | null;
  /** movement of thisWeek vs lastWeek (directional only; good/bad is the agent's call) */
  trend: "up" | "down" | "flat";
}

export interface WeeklyPackDailyBrief {
  /** London calendar day the brief summarised (YYYY-MM-DD) */
  day: string;
  headline: string;
  /** the brief's "Needs attention" bullets, parsed from its stored body markdown */
  needsAttention: string[];
}

export interface WeeklyPackProject {
  id: string;
  name: string;
  clientName: string;
  health: string;
  revenuePence: number;
  minutesSaved: number;
  conversations: number;
  errors: number;
}

export interface WeeklyPackInsightRef {
  projectName: string;
  kind: string;
  title: string;
  confidence: string;
}

export interface WeeklyPackCluster {
  projectName: string;
  topic: string;
  count: number;
  sharePct: number;
  trend: string;
  scoutCandidate: boolean;
  note: string;
}

/** Phase 7 §B3 — feedback_items counts this week vs last, by kind, agency-wide. */
export interface WeeklyPackFeedbackKind {
  kind: string;
  thisWeek: number;
  lastWeek: number;
  /** movement of thisWeek vs lastWeek (directional only; good/bad is the agent's call) */
  trend: "up" | "down" | "flat";
}

export interface WeeklyPackFeedback {
  /** one row per kind, canonical order: bug, feature, question, praise, other */
  byKind: WeeklyPackFeedbackKind[];
  totalThisWeek: number;
  totalLastWeek: number;
  trend: "up" | "down" | "flat";
}

export interface WeeklyPackPriorEdition {
  /** London Monday (YYYY-MM-DD) of the prior weekly edition */
  weekStart: string;
  headline: string;
  /** the prior edition's full body markdown (capped) — so the agent can say what changed */
  bodyMd: string;
}

export interface WeeklyPack {
  /** London Monday (YYYY-MM-DD) that STARTS the summarised week */
  weekStart: string;
  /** London Sunday (YYYY-MM-DD) that ENDS the summarised week (inclusive label) */
  weekEnd: string;
  /** when the pack was built (ISO UTC) */
  generatedAt: string;
  agency: {
    mrrPence: number;
    liveProjects: number;
    activeClients: number;
    healthSummary: { green: number; amber: number; red: number };
  };
  scoreboard: WeeklyPackScoreboardKpi[];
  dailyBriefs: WeeklyPackDailyBrief[];
  insights: {
    openedThisWeek: number;
    openedByKind: { kind: string; count: number }[];
    /** opened this week AND already moved off 'new' (proxy for closed-within-week) */
    closedThisWeek: number;
    currentlyOpen: number;
    topOpen: WeeklyPackInsightRef[];
  };
  conversationClusters: WeeklyPackCluster[];
  projects: WeeklyPackProject[];
  feedback: WeeklyPackFeedback;
  money: {
    collectedThisWeekPence: number;
    collectedLastWeekPence: number;
    currentMrrPence: number;
    mrrStartedThisWeekPence: number;
    mrrCancelledThisWeekPence: number;
    mrrNetChangeThisWeekPence: number;
    overdue: { month: string; count: number; pence: number };
  };
  /** the agent's own previous weekly edition, so it can reference what changed */
  priorEdition: WeeklyPackPriorEdition | null;
}

/** Newest N still-open insights carried verbatim in the pack (prompt-size guard). */
const MAX_TOP_OPEN = 15;
/** Newest N faq_cluster themes carried in the pack. */
const MAX_CLUSTERS = 20;
/** Prior-edition body markdown cap (chars) so the pack stays bounded. */
const PRIOR_BODY_CAP = 4000;

// ── scoreboard metric catalogue (agency-wide, additive; see file header) ──────

interface ScoreboardDef {
  key: string;
  name: string;
  unit: string;
  goodDirection: "up" | "down";
}

/** Canonical feedback kind order (bugs first — matches the brief-writing rule). */
const FEEDBACK_KINDS = ["bug", "feature", "question", "praise", "other"] as const;

/** Same up/down/flat directional trend rule as the scoreboard (±5% dead zone). */
function trendOf(thisPeriod: number, lastPeriod: number): "up" | "down" | "flat" {
  if (lastPeriod === 0) return thisPeriod === 0 ? "flat" : "up";
  const ratio = thisPeriod / lastPeriod;
  return ratio > 1.05 ? "up" : ratio < 0.95 ? "down" : "flat";
}

const SCOREBOARD_DEFS: readonly ScoreboardDef[] = [
  { key: "revenue", name: "Revenue", unit: "pence", goodDirection: "up" },
  { key: "minutes_saved", name: "Minutes saved", unit: "minutes", goodDirection: "up" },
  { key: "conversations", name: "Conversations handled", unit: "count", goodDirection: "up" },
  { key: "client_bookings", name: "Client bookings", unit: "count", goodDirection: "up" },
  { key: "errors", name: "Errors", unit: "count", goodDirection: "down" },
];

/**
 * Extract the bullet items under a `## <title>` heading from a brief's stored
 * body markdown (composeBodyMd writes "## Needs attention" then "- item" lines
 * until the next "## " heading). Deterministic string scan — no markdown parser
 * dependency. Returns [] when the section is absent.
 */
function extractSectionBullets(md: string, title: string): string[] {
  const lines = md.split(/\r?\n/);
  const out: string[] = [];
  let inSection = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("## ")) {
      inSection = line.slice(3).trim().toLowerCase() === title.toLowerCase();
      continue;
    }
    if (inSection && line.startsWith("- ")) out.push(line.slice(2).trim());
  }
  return out;
}

interface WindowRow {
  this_from: string;
  this_to: string;
  last_from: string;
  four_from: string;
  week_start_day: string;
  week_end_day: string;
  generated_at: string;
}

interface AgencyRow {
  mrr_pence: number;
  live_projects: number;
  active_clients: number;
  green: number;
  amber: number;
  red: number;
}

interface MetricRow {
  rev_this: number;
  rev_last: number;
  rev_four: number;
  min_this: number;
  min_last: number;
  min_four: number;
  conv_this: number;
  conv_last: number;
  conv_four: number;
  err_this: number;
  err_last: number;
  err_four: number;
}

interface BookingRow {
  this_week: number;
  last_week: number;
  four_week: number;
}

interface BriefRow {
  day: string;
  headline: string;
  body_md: string;
}

interface InsightCountRow {
  opened_this: number;
  closed_this: number;
  currently_open: number;
}

interface KindRow {
  kind: string;
  count: number;
}

interface TopOpenRow {
  project_name: string;
  kind: string;
  title: string;
  confidence: string;
}

interface ClusterRow {
  project_name: string;
  topic: string;
  evidence: Record<string, unknown> | null;
  body_md: string;
}

interface ProjectRow {
  id: string;
  name: string;
  client_name: string;
  health: string;
  revenue: number;
  minutes: number;
  conversations: number;
  errors: number;
}

interface MoneyRow {
  collected_this: number;
  collected_last: number;
  current_mrr: number;
  started_this: number;
  cancelled_this: number;
}

interface OverdueRow {
  month: string;
  overdue_count: number;
  overdue_pence: number;
}

interface PriorRow {
  week_start: string;
  headline: string;
  body_md: string;
}

interface FeedbackKindRow {
  kind: string;
  this_count: number;
  last_count: number;
}

function buildScoreboard(m: MetricRow, b: BookingRow): WeeklyPackScoreboardKpi[] {
  const values: Record<string, { this: number; last: number; four: number }> = {
    revenue: { this: num(m.rev_this), last: num(m.rev_last), four: num(m.rev_four) },
    minutes_saved: { this: num(m.min_this), last: num(m.min_last), four: num(m.min_four) },
    conversations: { this: num(m.conv_this), last: num(m.conv_last), four: num(m.conv_four) },
    client_bookings: {
      this: num(b.this_week),
      last: num(b.last_week),
      four: num(b.four_week),
    },
    errors: { this: num(m.err_this), last: num(m.err_last), four: num(m.err_four) },
  };

  return SCOREBOARD_DEFS.map((def) => {
    const v = values[def.key]!;
    const thisWeek = Math.round(v.this);
    const lastWeek = Math.round(v.last);
    // prior 4 weeks is a 28-day window; its mean weekly value is the /4 average.
    const fourWeekAvg = round2(v.four / 4);
    const deltaPctVsLastWeek =
      lastWeek !== 0 ? round2(((thisWeek - lastWeek) / lastWeek) * 100) : null;
    let trend: "up" | "down" | "flat";
    if (lastWeek === 0) {
      trend = thisWeek === 0 ? "flat" : "up";
    } else {
      const ratio = thisWeek / lastWeek;
      trend = ratio > 1.05 ? "up" : ratio < 0.95 ? "down" : "flat";
    }
    return {
      key: def.key,
      name: def.name,
      unit: def.unit,
      goodDirection: def.goodDirection,
      thisWeek,
      lastWeek,
      fourWeekAvg,
      deltaPctVsLastWeek,
      trend,
    };
  });
}

export async function buildAgencyWeeklyPack(
  db: Db,
  orgId: string,
  weekStartLondon: Date,
): Promise<WeeklyPack> {
  const client = db.$client;
  const d = weekStartLondon.toISOString();

  // ── window boundaries (all DST-safe, derived from the London week start) ────
  const winRows = (await client`
    with base as (select ${d}::timestamptz at time zone 'Europe/London' as ws)
    select
      to_char((ws at time zone 'Europe/London') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as this_from,
      to_char(((ws + interval '7 days') at time zone 'Europe/London') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as this_to,
      to_char(((ws - interval '7 days') at time zone 'Europe/London') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as last_from,
      to_char(((ws - interval '28 days') at time zone 'Europe/London') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as four_from,
      to_char(ws, 'YYYY-MM-DD') as week_start_day,
      to_char(ws + interval '6 days', 'YYYY-MM-DD') as week_end_day,
      to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as generated_at
    from base
  `) as unknown as WindowRow[];
  const w = winRows[0]!;
  const monthLabel = w.week_end_day.slice(0, 7);

  // ── agency summary (as of now) ──────────────────────────────────────────────
  const agencyRows = (await client`
    select
      (select coalesce(sum(amount_pence_monthly), 0)::float8
         from subscriptions where org_id = ${orgId}::uuid and status = 'active') as mrr_pence,
      (select count(*)::int from projects
         where org_id = ${orgId}::uuid and status = 'live') as live_projects,
      (select count(*)::int from clients
         where org_id = ${orgId}::uuid and status = 'active') as active_clients,
      (select count(*)::int from projects
         where org_id = ${orgId}::uuid and status not in ('completed', 'cancelled') and health = 'green') as green,
      (select count(*)::int from projects
         where org_id = ${orgId}::uuid and status not in ('completed', 'cancelled') and health = 'amber') as amber,
      (select count(*)::int from projects
         where org_id = ${orgId}::uuid and status not in ('completed', 'cancelled') and health = 'red') as red
  `) as unknown as AgencyRow[];
  const a = agencyRows[0]!;

  // ── scoreboard: additive agency outcomes from the events spine ──────────────
  const metricRows = (await client`
    select
      coalesce(sum(value_pence) filter (where occurred_at >= ${w.this_from}::timestamptz and occurred_at < ${w.this_to}::timestamptz), 0)::float8 as rev_this,
      coalesce(sum(value_pence) filter (where occurred_at >= ${w.last_from}::timestamptz and occurred_at < ${w.this_from}::timestamptz), 0)::float8 as rev_last,
      coalesce(sum(value_pence) filter (where occurred_at >= ${w.four_from}::timestamptz and occurred_at < ${w.this_from}::timestamptz), 0)::float8 as rev_four,
      coalesce(sum(minutes_saved) filter (where occurred_at >= ${w.this_from}::timestamptz and occurred_at < ${w.this_to}::timestamptz), 0)::float8 as min_this,
      coalesce(sum(minutes_saved) filter (where occurred_at >= ${w.last_from}::timestamptz and occurred_at < ${w.this_from}::timestamptz), 0)::float8 as min_last,
      coalesce(sum(minutes_saved) filter (where occurred_at >= ${w.four_from}::timestamptz and occurred_at < ${w.this_from}::timestamptz), 0)::float8 as min_four,
      count(*) filter (where type = 'llm.conversation' and occurred_at >= ${w.this_from}::timestamptz and occurred_at < ${w.this_to}::timestamptz)::int as conv_this,
      count(*) filter (where type = 'llm.conversation' and occurred_at >= ${w.last_from}::timestamptz and occurred_at < ${w.this_from}::timestamptz)::int as conv_last,
      count(*) filter (where type = 'llm.conversation' and occurred_at >= ${w.four_from}::timestamptz and occurred_at < ${w.this_from}::timestamptz)::int as conv_four,
      count(*) filter (where type = 'system.error' and occurred_at >= ${w.this_from}::timestamptz and occurred_at < ${w.this_to}::timestamptz)::int as err_this,
      count(*) filter (where type = 'system.error' and occurred_at >= ${w.last_from}::timestamptz and occurred_at < ${w.this_from}::timestamptz)::int as err_last,
      count(*) filter (where type = 'system.error' and occurred_at >= ${w.four_from}::timestamptz and occurred_at < ${w.this_from}::timestamptz)::int as err_four
    from events
    where org_id = ${orgId}::uuid
      and occurred_at >= ${w.four_from}::timestamptz and occurred_at < ${w.this_to}::timestamptz
  `) as unknown as MetricRow[];
  const m = metricRows[0]!;

  const bookingRows = (await client`
    select
      count(*) filter (where starts_at >= ${w.this_from}::timestamptz and starts_at < ${w.this_to}::timestamptz)::int as this_week,
      count(*) filter (where starts_at >= ${w.last_from}::timestamptz and starts_at < ${w.this_from}::timestamptz)::int as last_week,
      count(*) filter (where starts_at >= ${w.four_from}::timestamptz and starts_at < ${w.this_from}::timestamptz)::int as four_week
    from bookings
    where org_id = ${orgId}::uuid and kind = 'client_end_customer'
  `) as unknown as BookingRow[];
  const b = bookingRows[0]!;

  const scoreboard = buildScoreboard(m, b);

  // ── the 7 daily briefs' headlines + attention (from briefs) ─────────────────
  const briefRows = (await client`
    select
      to_char(period_start at time zone 'Europe/London', 'YYYY-MM-DD') as day,
      headline,
      body_md
    from briefs
    where org_id = ${orgId}::uuid and scope = 'agency' and period = 'daily'
      and period_start >= ${w.this_from}::timestamptz and period_start < ${w.this_to}::timestamptz
    order by period_start asc
  `) as unknown as BriefRow[];
  const dailyBriefs: WeeklyPackDailyBrief[] = briefRows.map((r) => ({
    day: r.day,
    headline: r.headline,
    needsAttention: extractSectionBullets(r.body_md ?? "", "Needs attention"),
  }));

  // ── insights opened/closed this week + currently open + top open ────────────
  const insightCountRows = (await client`
    select
      count(*) filter (where created_at >= ${w.this_from}::timestamptz and created_at < ${w.this_to}::timestamptz)::int as opened_this,
      count(*) filter (where created_at >= ${w.this_from}::timestamptz and created_at < ${w.this_to}::timestamptz and status <> 'new')::int as closed_this,
      count(*) filter (where status = 'new')::int as currently_open
    from insights
    where org_id = ${orgId}::uuid
  `) as unknown as InsightCountRow[];
  const ic = insightCountRows[0]!;

  const kindRows = (await client`
    select kind::text as kind, count(*)::int as count
    from insights
    where org_id = ${orgId}::uuid
      and created_at >= ${w.this_from}::timestamptz and created_at < ${w.this_to}::timestamptz
    group by kind
    order by count desc, kind
  `) as unknown as KindRow[];

  const topOpenRows = (await client`
    select coalesce(p.name, '') as project_name, i.kind::text as kind, i.title as title, i.confidence::text as confidence
    from insights i
    left join projects p on p.id = i.project_id
    where i.org_id = ${orgId}::uuid and i.status = 'new'
    order by i.created_at desc
    limit ${MAX_TOP_OPEN}
  `) as unknown as TopOpenRow[];

  // ── conversation clusters active this week (faq_cluster insights) ───────────
  // "This week" = created in the window OR whose evidence window 'to' day is in
  // the week's day range (the daily convo job updates a fingerprinted row in
  // place, so created_at can predate the week it was last refreshed for).
  const clusterRows = (await client`
    select coalesce(p.name, '') as project_name, i.title as topic, i.evidence as evidence, i.body_md as body_md
    from insights i
    left join projects p on p.id = i.project_id
    where i.org_id = ${orgId}::uuid and i.kind = 'faq_cluster'
      and (
        (i.created_at >= ${w.this_from}::timestamptz and i.created_at < ${w.this_to}::timestamptz)
        or (
          coalesce(i.evidence->'window'->>'to', '') >= ${w.week_start_day}
          and coalesce(i.evidence->'window'->>'to', '') <= ${w.week_end_day}
        )
      )
    order by (i.evidence->>'share_pct')::float8 desc nulls last, i.created_at desc
    limit ${MAX_CLUSTERS}
  `) as unknown as ClusterRow[];
  const conversationClusters: WeeklyPackCluster[] = clusterRows.map((r) => {
    const ev = r.evidence ?? {};
    return {
      projectName: r.project_name,
      topic: r.topic,
      count: num(ev["count"]),
      sharePct: num(ev["share_pct"]),
      trend: typeof ev["trend"] === "string" ? (ev["trend"] as string) : "flat",
      scoutCandidate: ev["scout_candidate"] === true,
      note: r.body_md ?? "",
    };
  });

  // ── per-project week aggregates (for the WoW narratives) ────────────────────
  const projectRows = (await client`
    select
      p.id::text as id,
      p.name as name,
      coalesce(cl.name, '') as client_name,
      p.health::text as health,
      coalesce((select sum(e.value_pence) from events e
         where e.project_id = p.id
           and e.occurred_at >= ${w.this_from}::timestamptz and e.occurred_at < ${w.this_to}::timestamptz), 0)::float8 as revenue,
      coalesce((select sum(e.minutes_saved) from events e
         where e.project_id = p.id
           and e.occurred_at >= ${w.this_from}::timestamptz and e.occurred_at < ${w.this_to}::timestamptz), 0)::float8 as minutes,
      (select count(*)::int from events e
         where e.project_id = p.id and e.type = 'llm.conversation'
           and e.occurred_at >= ${w.this_from}::timestamptz and e.occurred_at < ${w.this_to}::timestamptz) as conversations,
      (select count(*)::int from events e
         where e.project_id = p.id and e.type = 'system.error'
           and e.occurred_at >= ${w.this_from}::timestamptz and e.occurred_at < ${w.this_to}::timestamptz) as errors
    from projects p
    left join clients cl on cl.id = p.client_id
    where p.org_id = ${orgId}::uuid and p.status not in ('completed', 'cancelled')
    order by p.name
  `) as unknown as ProjectRow[];
  const projects: WeeklyPackProject[] = projectRows.map((p) => ({
    id: p.id,
    name: p.name,
    clientName: p.client_name,
    health: p.health,
    revenuePence: Math.round(num(p.revenue)),
    minutesSaved: Math.round(num(p.minutes)),
    conversations: num(p.conversations),
    errors: num(p.errors),
  }));

  // ── feedback this week vs last week, by kind, agency-wide ───────────────────
  const feedbackKindRows = (await client`
    select
      kind::text as kind,
      count(*) filter (where created_at >= ${w.this_from}::timestamptz and created_at < ${w.this_to}::timestamptz)::int as this_count,
      count(*) filter (where created_at >= ${w.last_from}::timestamptz and created_at < ${w.this_from}::timestamptz)::int as last_count
    from feedback_items
    where org_id = ${orgId}::uuid
      and created_at >= ${w.last_from}::timestamptz and created_at < ${w.this_to}::timestamptz
    group by kind
  `) as unknown as FeedbackKindRow[];
  const feedbackByKind = new Map<string, { thisCount: number; lastCount: number }>();
  for (const r of feedbackKindRows) {
    feedbackByKind.set(r.kind, { thisCount: num(r.this_count), lastCount: num(r.last_count) });
  }
  const feedbackByKindPack: WeeklyPackFeedbackKind[] = FEEDBACK_KINDS.map((kind) => {
    const v = feedbackByKind.get(kind) ?? { thisCount: 0, lastCount: 0 };
    return {
      kind,
      thisWeek: v.thisCount,
      lastWeek: v.lastCount,
      trend: trendOf(v.thisCount, v.lastCount),
    };
  });
  const feedbackTotalThis = feedbackByKindPack.reduce((s, k) => s + k.thisWeek, 0);
  const feedbackTotalLast = feedbackByKindPack.reduce((s, k) => s + k.lastWeek, 0);

  // ── money week: collected, MRR moves, overdue ───────────────────────────────
  const moneyRows = (await client`
    select
      coalesce((select sum(amount_pence) from payments
         where org_id = ${orgId}::uuid and status = 'paid' and paid_at is not null
           and paid_at >= ${w.this_from}::timestamptz and paid_at < ${w.this_to}::timestamptz), 0)::float8 as collected_this,
      coalesce((select sum(amount_pence) from payments
         where org_id = ${orgId}::uuid and status = 'paid' and paid_at is not null
           and paid_at >= ${w.last_from}::timestamptz and paid_at < ${w.this_from}::timestamptz), 0)::float8 as collected_last,
      coalesce((select sum(amount_pence_monthly) from subscriptions
         where org_id = ${orgId}::uuid and status = 'active'), 0)::float8 as current_mrr,
      coalesce((select sum(amount_pence_monthly) from subscriptions
         where org_id = ${orgId}::uuid
           and started_at >= ${w.week_start_day}::date and started_at <= ${w.week_end_day}::date), 0)::float8 as started_this,
      coalesce((select sum(amount_pence_monthly) from subscriptions
         where org_id = ${orgId}::uuid and cancelled_at is not null
           and cancelled_at >= ${w.week_start_day}::date and cancelled_at <= ${w.week_end_day}::date), 0)::float8 as cancelled_this
  `) as unknown as MoneyRow[];
  const mo = moneyRows[0]!;

  // Overdue retainers for the week's London month — mirrors getRetainers: an
  // active sub's expected monthly minus received retainer/stripe-other payments
  // this month; a shortfall is overdue.
  const overdueRows = (await client`
    with monthbounds as (
      select
        (${w.week_end_day}::date - (extract(day from ${w.week_end_day}::date)::int - 1))::date as month_start
    ),
    bounds as (
      select
        (month_start)::timestamp at time zone 'Europe/London' as start_ts,
        (month_start + interval '1 month')::timestamp at time zone 'Europe/London' as end_ts,
        to_char(month_start, 'YYYY-MM') as month
      from monthbounds
    ),
    retainers as (
      select
        s.amount_pence_monthly as expected,
        coalesce((select sum(p.amount_pence) from payments p
          where p.org_id = ${orgId}::uuid and p.status = 'paid'
            and (p.kind = 'retainer' or (p.source = 'stripe' and p.kind = 'other'))
            and p.client_id = s.client_id
            and p.project_id is not distinct from s.project_id
            and p.paid_at >= (select start_ts from bounds)
            and p.paid_at < (select end_ts from bounds)), 0) as received
      from subscriptions s
      where s.org_id = ${orgId}::uuid and s.status = 'active'
    )
    select
      (select month from bounds) as month,
      count(*) filter (where received < expected)::int as overdue_count,
      coalesce(sum(greatest(0, expected - received)), 0)::float8 as overdue_pence
    from retainers
  `) as unknown as OverdueRow[];
  const ov = overdueRows[0]!;

  const startedThis = Math.round(num(mo.started_this));
  const cancelledThis = Math.round(num(mo.cancelled_this));

  // ── prior weekly edition (so the agent can say what changed) ────────────────
  const priorRows = (await client`
    select
      to_char(period_start at time zone 'Europe/London', 'YYYY-MM-DD') as week_start,
      headline,
      body_md
    from briefs
    where org_id = ${orgId}::uuid and scope = 'agency' and period = 'weekly'
      and period_start < ${w.this_from}::timestamptz
    order by period_start desc
    limit 1
  `) as unknown as PriorRow[];
  const priorEdition: WeeklyPackPriorEdition | null = priorRows[0]
    ? {
        weekStart: priorRows[0].week_start,
        headline: priorRows[0].headline,
        bodyMd: (priorRows[0].body_md ?? "").slice(0, PRIOR_BODY_CAP),
      }
    : null;

  return {
    weekStart: w.week_start_day,
    weekEnd: w.week_end_day,
    generatedAt: w.generated_at,
    agency: {
      mrrPence: Math.round(num(a.mrr_pence)),
      liveProjects: num(a.live_projects),
      activeClients: num(a.active_clients),
      healthSummary: { green: num(a.green), amber: num(a.amber), red: num(a.red) },
    },
    scoreboard,
    dailyBriefs,
    insights: {
      openedThisWeek: num(ic.opened_this),
      openedByKind: kindRows.map((r) => ({ kind: r.kind, count: num(r.count) })),
      closedThisWeek: num(ic.closed_this),
      currentlyOpen: num(ic.currently_open),
      topOpen: topOpenRows.map((r) => ({
        projectName: r.project_name,
        kind: r.kind,
        title: r.title,
        confidence: r.confidence,
      })),
    },
    conversationClusters,
    projects,
    feedback: {
      byKind: feedbackByKindPack,
      totalThisWeek: feedbackTotalThis,
      totalLastWeek: feedbackTotalLast,
      trend: trendOf(feedbackTotalThis, feedbackTotalLast),
    },
    money: {
      collectedThisWeekPence: Math.round(num(mo.collected_this)),
      collectedLastWeekPence: Math.round(num(mo.collected_last)),
      currentMrrPence: Math.round(num(mo.current_mrr)),
      mrrStartedThisWeekPence: startedThis,
      mrrCancelledThisWeekPence: cancelledThis,
      mrrNetChangeThisWeekPence: startedThis - cancelledThis,
      overdue: {
        month: ov.month,
        count: num(ov.overdue_count),
        pence: Math.round(num(ov.overdue_pence)),
      },
    },
    priorEdition,
  };
}
