/**
 * Churn-risk scoring (docs/phase9/CONTRACTS.md §P9-KB).
 *
 * A DETERMINISTIC 0-100 composite churn-risk score per client, surfaced as a chip
 * on Client 360 and the Health grid. The weights are PINNED IN CODE (they are a
 * product decision, not a tuneable) and the five factors each resolve to a 0..1
 * risk sub-score from real signals:
 *
 *   engagement trend   30%  — event volume this 30d vs the prior 30d (a drop = risk)
 *   sentiment trend    20%  — negative-conversation share, weighted by worsening
 *   feedback bug-spike 15%  — bug-feedback volume this 30d vs the prior 30d
 *   payment lag        20%  — past_due retainer, or days since last paid invoice
 *   silence            15%  — days since the client's most recent event
 *
 * score = round(100 × Σ weightᵢ · riskᵢ). Bands (contract): healthy <25,
 * watch 25–60, risk >60. Everything here is PURE + unit-tested at the band
 * boundaries; the loader (getChurnScores) reads the signals with plain SQL over
 * the events / feedback_items / subscriptions / payments spines, org-scoped, and
 * never writes.
 */

import { db } from "@azen/db";

// ── pinned weights (a product decision — do not tune without a contract change) ─
export const CHURN_WEIGHTS = {
  engagement: 0.3,
  sentiment: 0.2,
  bugSpike: 0.15,
  payment: 0.2,
  silence: 0.15,
} as const;

export type ChurnBand = "healthy" | "watch" | "risk";

export interface ChurnInputs {
  /** Events (any type) across this client's projects in the recent 30-day window. */
  engagementRecent: number;
  /** Events in the prior 30-day window (days 31–60). */
  engagementPrior: number;
  /** llm.conversation with sentiment=negative, recent window. */
  sentimentNegRecent: number;
  /** All llm.conversation, recent window. */
  sentimentTotalRecent: number;
  /** llm.conversation with sentiment=negative, prior window. */
  sentimentNegPrior: number;
  /** All llm.conversation, prior window. */
  sentimentTotalPrior: number;
  /** bug feedback_items, recent window. */
  bugRecent: number;
  /** bug feedback_items, prior window. */
  bugPrior: number;
  /** Any subscription for this client is past_due. */
  hasPastDue: boolean;
  /** Any active retainer/subscription exists (so payment cadence is expected). */
  hasActiveRetainer: boolean;
  /** Whole days since the last PAID payment; null when none on record. */
  daysSinceLastPayment: number | null;
  /** Whole days since the client's most recent event; null when none ever. */
  daysSinceLastEvent: number | null;
}

export interface ChurnFactorBreakdown {
  engagement: number;
  sentiment: number;
  bugSpike: number;
  payment: number;
  silence: number;
}

export interface ChurnScore {
  clientId: string;
  clientName: string;
  score: number;
  band: ChurnBand;
  /** Per-factor 0..1 risk sub-scores (for tooltips / drill-down). */
  factors: ChurnFactorBreakdown;
  /** Short human reasons for the top contributors (numbers-first). */
  reasons: string[];
  inputs: ChurnInputs;
}

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);
const round1 = (n: number): number => Math.round(n * 1000) / 1000;

// ── factor risk functions (each PURE, 0..1; documented boundaries) ────────────

/**
 * Engagement-trend risk: a drop in event volume vs the prior window. With no
 * prior activity there is no drop to measure (0 risk — silence covers a full
 * stop). A 50% drop → 0.5; a total stop from a busy prior → 1.0. Growth → 0.
 */
export function engagementRisk(recent: number, prior: number): number {
  if (prior <= 0) return 0;
  return clamp01((prior - recent) / prior);
}

/**
 * Sentiment-trend risk: the recent negative-conversation share, pushed up when it
 * WORSENED vs the prior window. No recent conversations → no signal (0). At a
 * given negative share the risk is that share, plus half of any increase over the
 * prior share. Fully negative + worsening saturates at 1.0.
 */
export function sentimentRisk(
  negRecent: number,
  totalRecent: number,
  negPrior: number,
  totalPrior: number,
): number {
  if (totalRecent <= 0) return 0;
  const rateRecent = negRecent / totalRecent;
  const ratePrior = totalPrior > 0 ? negPrior / totalPrior : rateRecent;
  const worsening = Math.max(0, rateRecent - ratePrior);
  return clamp01(rateRecent + worsening * 0.5);
}

/** Baseline bug count that reads as a full spike when there was no prior history. */
const BUG_SPIKE_BASE = 3;

/**
 * Bug-spike risk: a rise in bug-feedback volume vs the prior window. No recent
 * bugs → 0. With a prior baseline, risk = relative increase (double the bugs →
 * 1.0). With no prior bugs, BUG_SPIKE_BASE new bugs reads as a full spike.
 */
export function bugSpikeRisk(recent: number, prior: number): number {
  if (recent <= 0) return 0;
  if (prior <= 0) return clamp01(recent / BUG_SPIKE_BASE);
  return clamp01((recent - prior) / prior);
}

/**
 * Payment-lag risk: a past_due retainer is maximal risk (1.0). Otherwise, when a
 * retainer is expected, lateness of the last paid invoice ramps from 35 days (0)
 * to 65 days (1.0). No retainer / no payments → not judged (0).
 */
export function paymentRisk(
  hasPastDue: boolean,
  hasActiveRetainer: boolean,
  daysSinceLastPayment: number | null,
): number {
  if (hasPastDue) return 1;
  if (!hasActiveRetainer || daysSinceLastPayment === null) return 0;
  return clamp01((daysSinceLastPayment - 35) / 30);
}

/**
 * Silence risk: days since the client's most recent event. Ramps from 7 days (0)
 * to 28 days (1.0). No events ever (null) → 0 (a brand-new client is not "silent").
 */
export function silenceRisk(daysSinceLastEvent: number | null): number {
  if (daysSinceLastEvent === null) return 0;
  return clamp01((daysSinceLastEvent - 7) / 21);
}

export function bandForScore(score: number): ChurnBand {
  if (score > 60) return "risk";
  if (score >= 25) return "watch";
  return "healthy";
}

/**
 * The pure composite. Combines the five pinned-weight factor risks into a 0-100
 * score + band + a short reason list naming the largest contributors.
 */
export function computeChurnScore(
  clientId: string,
  clientName: string,
  inputs: ChurnInputs,
): ChurnScore {
  const factors: ChurnFactorBreakdown = {
    engagement: round1(engagementRisk(inputs.engagementRecent, inputs.engagementPrior)),
    sentiment: round1(
      sentimentRisk(
        inputs.sentimentNegRecent,
        inputs.sentimentTotalRecent,
        inputs.sentimentNegPrior,
        inputs.sentimentTotalPrior,
      ),
    ),
    bugSpike: round1(bugSpikeRisk(inputs.bugRecent, inputs.bugPrior)),
    payment: round1(
      paymentRisk(inputs.hasPastDue, inputs.hasActiveRetainer, inputs.daysSinceLastPayment),
    ),
    silence: round1(silenceRisk(inputs.daysSinceLastEvent)),
  };

  const weighted =
    factors.engagement * CHURN_WEIGHTS.engagement +
    factors.sentiment * CHURN_WEIGHTS.sentiment +
    factors.bugSpike * CHURN_WEIGHTS.bugSpike +
    factors.payment * CHURN_WEIGHTS.payment +
    factors.silence * CHURN_WEIGHTS.silence;

  const score = Math.round(clamp01(weighted) * 100);
  const band = bandForScore(score);

  const reasons = buildReasons(inputs, factors);

  return { clientId, clientName, score, band, factors, reasons, inputs };
}

/** Order factors by weighted contribution and name the material ones (>0.15 risk). */
function buildReasons(inputs: ChurnInputs, f: ChurnFactorBreakdown): string[] {
  const items: { contribution: number; text: string }[] = [];

  if (f.engagement > 0.15) {
    const dropPct = Math.round(
      (1 - inputs.engagementRecent / Math.max(1, inputs.engagementPrior)) * 100,
    );
    items.push({
      contribution: f.engagement * CHURN_WEIGHTS.engagement,
      text: `Engagement down ${dropPct}% vs prior 30d`,
    });
  }
  if (f.sentiment > 0.15) {
    const pct =
      inputs.sentimentTotalRecent > 0
        ? Math.round((inputs.sentimentNegRecent / inputs.sentimentTotalRecent) * 100)
        : 0;
    items.push({
      contribution: f.sentiment * CHURN_WEIGHTS.sentiment,
      text: `${pct}% of conversations negative`,
    });
  }
  if (f.bugSpike > 0.15) {
    items.push({
      contribution: f.bugSpike * CHURN_WEIGHTS.bugSpike,
      text: `Bug reports up (${inputs.bugRecent} vs ${inputs.bugPrior})`,
    });
  }
  if (f.payment > 0.15) {
    items.push({
      contribution: f.payment * CHURN_WEIGHTS.payment,
      text: inputs.hasPastDue
        ? "Retainer past due"
        : `${inputs.daysSinceLastPayment} days since last payment`,
    });
  }
  if (f.silence > 0.15) {
    items.push({
      contribution: f.silence * CHURN_WEIGHTS.silence,
      text: `${inputs.daysSinceLastEvent} days silent`,
    });
  }

  return items
    .sort((a, b) => b.contribution - a.contribution)
    .map((i) => i.text);
}

// ── loader: read the signals per client, org-scoped, read-only ────────────────

interface EngagementRow {
  client_id: string;
  client_name: string;
  eng_recent: number;
  eng_prior: number;
  neg_recent: number;
  total_recent: number;
  neg_prior: number;
  total_prior: number;
  days_since_last_event: number | null;
}

interface BugRow {
  client_id: string;
  bug_recent: number;
  bug_prior: number;
}

interface PaymentRow {
  client_id: string;
  has_past_due: boolean;
  has_active_retainer: boolean;
  days_since_last_payment: number | null;
}

const num = (v: unknown): number => Number(v ?? 0);
const numOrNull = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v);

/**
 * Compute churn scores for every client in an org. Three grouped, read-only
 * queries (events+conversations+silence, bug feedback, payments/subscriptions),
 * stitched by clientId. Windows are the recent 30 London days and the prior 30,
 * derived in Postgres so they are DST-correct. Clients with no signals score 0
 * (healthy). Returned sorted highest-risk first.
 */
export async function getChurnScores(orgId: string): Promise<ChurnScore[]> {
  const client = db.$client;

  // Every client in the org (so a silent client with no events still appears).
  const clientRows = (await client`
    select id::text as id, name from clients where org_id = ${orgId}::uuid
  `) as unknown as { id: string; name: string }[];
  if (clientRows.length === 0) return [];

  // ── engagement + sentiment + silence, per client, from the events spine ──────
  const engRows = (await client`
    with b as (select date_trunc('day', now() at time zone 'Europe/London') as today_start),
    bounds as (
      select
        ((today_start - interval '30 days') at time zone 'Europe/London') at time zone 'UTC' as recent_from,
        (today_start at time zone 'Europe/London') at time zone 'UTC' as recent_to,
        ((today_start - interval '60 days') at time zone 'Europe/London') at time zone 'UTC' as prior_from
      from b
    )
    select
      c.id::text as client_id,
      c.name as client_name,
      count(e.id) filter (where e.occurred_at >= bounds.recent_from and e.occurred_at < bounds.recent_to)::int as eng_recent,
      count(e.id) filter (where e.occurred_at >= bounds.prior_from and e.occurred_at < bounds.recent_from)::int as eng_prior,
      count(e.id) filter (where e.type = 'llm.conversation' and e.data->>'sentiment' = 'negative' and e.occurred_at >= bounds.recent_from and e.occurred_at < bounds.recent_to)::int as neg_recent,
      count(e.id) filter (where e.type = 'llm.conversation' and e.occurred_at >= bounds.recent_from and e.occurred_at < bounds.recent_to)::int as total_recent,
      count(e.id) filter (where e.type = 'llm.conversation' and e.data->>'sentiment' = 'negative' and e.occurred_at >= bounds.prior_from and e.occurred_at < bounds.recent_from)::int as neg_prior,
      count(e.id) filter (where e.type = 'llm.conversation' and e.occurred_at >= bounds.prior_from and e.occurred_at < bounds.recent_from)::int as total_prior,
      -- Silence is measured over ALL of the client's events, NOT the 60-day
      -- window join above (which only feeds the trend counts). A windowed max
      -- would collapse to null past the window, inverting silence risk to 0 for
      -- the fully-dormant clients this factor exists to catch.
      floor(extract(epoch from (now() - (
        select max(e2.occurred_at)
        from events e2
        join projects p2 on p2.id = e2.project_id and p2.org_id = ${orgId}::uuid
        where p2.client_id = c.id and e2.org_id = ${orgId}::uuid
      ))) / 86400)::int as days_since_last_event
    from clients c
    cross join bounds
    left join projects p on p.client_id = c.id and p.org_id = ${orgId}::uuid
    left join events e on e.project_id = p.id and e.org_id = ${orgId}::uuid
      and e.occurred_at >= bounds.prior_from
    where c.org_id = ${orgId}::uuid
    group by c.id, c.name
  `) as unknown as EngagementRow[];
  const engById = new Map(engRows.map((r) => [r.client_id, r]));

  // ── bug feedback, per client ────────────────────────────────────────────────
  const bugRows = (await client`
    with b as (select date_trunc('day', now() at time zone 'Europe/London') as today_start),
    bounds as (
      select
        ((today_start - interval '30 days') at time zone 'Europe/London') at time zone 'UTC' as recent_from,
        (today_start at time zone 'Europe/London') at time zone 'UTC' as recent_to,
        ((today_start - interval '60 days') at time zone 'Europe/London') at time zone 'UTC' as prior_from
      from b
    )
    select
      p.client_id::text as client_id,
      count(*) filter (where f.created_at >= bounds.recent_from and f.created_at < bounds.recent_to)::int as bug_recent,
      count(*) filter (where f.created_at >= bounds.prior_from and f.created_at < bounds.recent_from)::int as bug_prior
    from feedback_items f
    cross join bounds
    join projects p on p.id = f.project_id
    where f.org_id = ${orgId}::uuid and f.kind = 'bug' and f.created_at >= bounds.prior_from
    group by p.client_id
  `) as unknown as BugRow[];
  const bugById = new Map(bugRows.map((r) => [r.client_id, r]));

  // ── payments + subscriptions, per client (separate to avoid a cartesian) ─────
  const subRows = (await client`
    select client_id::text as client_id,
      bool_or(status = 'past_due') as has_past_due,
      bool_or(status = 'active') as has_active_retainer
    from subscriptions where org_id = ${orgId}::uuid
    group by client_id
  `) as unknown as { client_id: string; has_past_due: boolean; has_active_retainer: boolean }[];
  const subById = new Map(subRows.map((r) => [r.client_id, r]));

  const payRows = (await client`
    select client_id::text as client_id,
      floor(extract(epoch from (now() - max(paid_at))) / 86400)::int as days_since_last_payment
    from payments where org_id = ${orgId}::uuid and status = 'paid' and paid_at is not null
    group by client_id
  `) as unknown as { client_id: string; days_since_last_payment: number | null }[];
  const payById = new Map(payRows.map((r) => [r.client_id, r]));

  const scores: ChurnScore[] = clientRows.map((c) => {
    const eng = engById.get(c.id);
    const bug = bugById.get(c.id);
    const sub = subById.get(c.id);
    const pay = payById.get(c.id);

    const inputs: ChurnInputs = {
      engagementRecent: num(eng?.eng_recent),
      engagementPrior: num(eng?.eng_prior),
      sentimentNegRecent: num(eng?.neg_recent),
      sentimentTotalRecent: num(eng?.total_recent),
      sentimentNegPrior: num(eng?.neg_prior),
      sentimentTotalPrior: num(eng?.total_prior),
      bugRecent: num(bug?.bug_recent),
      bugPrior: num(bug?.bug_prior),
      hasPastDue: Boolean(sub?.has_past_due),
      hasActiveRetainer: Boolean(sub?.has_active_retainer),
      daysSinceLastPayment: numOrNull(pay?.days_since_last_payment),
      daysSinceLastEvent: numOrNull(eng?.days_since_last_event ?? null),
    };
    return computeChurnScore(c.id, c.name, inputs);
  });

  return scores.sort((a, b) => b.score - a.score || a.clientName.localeCompare(b.clientName));
}

/** Churn score for a single client (or null when the client isn't in the org). */
export async function getClientChurn(
  orgId: string,
  clientId: string,
): Promise<ChurnScore | null> {
  const all = await getChurnScores(orgId);
  return all.find((s) => s.clientId === clientId) ?? null;
}
