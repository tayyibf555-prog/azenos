/**
 * The Agency Daily data pack (docs/phase3/CONTRACTS.md §P3-RUNNER — EXACT
 * shape). The §9 rule: agents never query the DB, they receive this curated,
 * deterministic JSON. This shape is the contract between buildAgencyDailyPack
 * and the Daily Brief agent, and is what lands in briefs.dataSnapshot for
 * auditability (every number the agent saw).
 */

export interface DailyPackKpi {
  key: string;
  name: string;
  unit: string;
  /** yesterday's day-rollup value, or null if there is no bucket */
  value: number | null;
  /** mean of the prior 7 complete London days, or null with no history */
  avg7: number | null;
  /** mean of the prior 28 complete London days, or null with no history */
  avg28: number | null;
  /** value vs avg7 as a percentage, or null when it cannot be computed */
  deltaPct: number | null;
  goodDirection: string;
}

export interface DailyPackAnomaly {
  metricKey: string;
  title: string;
}

/** yesterday's feedback_items counts by kind for one project. */
export interface DailyPackFeedbackCounts {
  bug: number;
  feature: number;
  question: number;
  praise: number;
  other: number;
}

export interface DailyPackNotableFeedback {
  kind: string;
  /** truncated to <= 140 chars (see FEEDBACK_MESSAGE_CAP) */
  message: string;
  severity: number | null;
}

/** Phase 7 §B3 — yesterday's feedback for one project (docs/phase7/PLAN.md). */
export interface DailyPackFeedback {
  yesterday: DailyPackFeedbackCounts;
  /** up to 3 items, severity desc (nulls last) then most-recent first */
  notable: DailyPackNotableFeedback[];
}

export interface DailyPackProject {
  id: string;
  name: string;
  clientName: string;
  health: string;
  kpis: DailyPackKpi[];
  revenueYesterdayPence: number;
  minutesSavedYesterday: number;
  /** most recent event's occurred_at (ISO UTC), or null if the project is silent */
  lastEventAt: string | null;
  /** hours since lastEventAt — the silence flag; null when there are no events */
  hoursSinceLastEvent: number | null;
  openAnomalies: DailyPackAnomaly[];
  errorCountYesterday: number;
  feedback: DailyPackFeedback;
}

export interface DailyPackAgency {
  mrrPence: number;
  liveProjects: number;
  activeClients: number;
  healthSummary: { green: number; amber: number; red: number };
  clientBookingsYesterday: number;
}

export interface DailyPackInsight {
  projectName: string;
  kind: string;
  title: string;
  confidence: string;
}

export interface DailyPack {
  /** the London calendar day being summarized (YYYY-MM-DD) */
  forDay: string;
  /** when the pack was built (ISO UTC) */
  generatedAt: string;
  agency: DailyPackAgency;
  projects: DailyPackProject[];
  openInsights: DailyPackInsight[];
  /** a precomputed, factual headline delta the agent can lead with */
  yesterdayVsBaseline: { note: string };
}
