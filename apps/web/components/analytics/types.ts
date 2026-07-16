/**
 * Wire contracts for the deep per-project Analytics screen.
 *
 * These are the EXACT shapes the foundation guarantees: every section stub
 * fetches `/api/projects/${projectId}/analytics/<slug>?range=${range}` and the
 * matching endpoint returns the interface below. Wave-1 agents flesh out the
 * bodies but MUST keep `range` / `from` / `to` and never break these fields
 * (they may ADD fields). Pure types only — no runtime code.
 */

export type AnalyticsRange = "7d" | "30d" | "90d";

/** Slugs → path segments; the section→component map lives in AnalyticsWorkspace. */
export type SectionSlug =
  | "pulse"
  | "engagement"
  | "conversations-ai"
  | "funnel"
  | "bookings"
  | "money"
  | "agent-dev"
  | "custom"
  | "feedback";

/** Every analytics endpoint echoes its resolved window. */
export interface AnalyticsMeta {
  range: AnalyticsRange;
  /** inclusive London calendar day, YYYY-MM-DD */
  from: string;
  /** inclusive London calendar day, YYYY-MM-DD */
  to: string;
}

/** Error envelope shared with the rest of the dashboard API. */
export interface AnalyticsError {
  error: string;
}

/**
 * Client-safe projection of the project the workspace renders around. Matches
 * `AnalyticsProject` from lib/server/analytics/base structurally, but lives
 * here so client components never import the server module.
 */
export interface AnalyticsProjectView {
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
}

export interface SeriesPoint {
  periodStart: string;
  value: number;
}

export interface LabelledValue {
  label: string;
  value: number;
}

// ── per-section response contracts (minimal foundation shape) ────────────────

export interface PulseResponse extends AnalyticsMeta {
  totalEvents: number;
  activeDays: number;
  series: SeriesPoint[];
}

export interface EngagementResponse extends AnalyticsMeta {
  totalEvents: number;
  /** weekday: 1=Mon..7=Sun, hour: 0..23 */
  heatmap: { weekday: number; hour: number; value: number }[];
  topEvents: LabelledValue[];
}

export interface ConversationsAiResponse extends AnalyticsMeta {
  totalConversations: number;
  resolutionRate: number | null;
  escalationRate: number | null;
  topQuestions: LabelledValue[];
}

export interface FunnelResponse extends AnalyticsMeta {
  stages: LabelledValue[];
}

export interface BookingsResponse extends AnalyticsMeta {
  totalBookings: number;
  series: SeriesPoint[];
}

export interface MoneyResponse extends AnalyticsMeta {
  totalPence: number;
  series: SeriesPoint[];
}

export interface AgentDevResponse extends AnalyticsMeta {
  totalRuns: number;
  successRate: number | null;
  leaderboard: LabelledValue[];
}

export interface CustomResponse extends AnalyticsMeta {
  eventTypes: { type: string; count: number }[];
}

/** Phase 7 §B — the Feedback section (feedback.submitted taxonomy + feedback_items). */
export interface FeedbackResponse extends AnalyticsMeta {
  totalThisRange: number;
  series: SeriesPoint[];
}

/** Section-slug → response type, for the wave-1 agents' reference. */
export interface SectionResponseMap {
  pulse: PulseResponse;
  engagement: EngagementResponse;
  "conversations-ai": ConversationsAiResponse;
  funnel: FunnelResponse;
  bookings: BookingsResponse;
  money: MoneyResponse;
  "agent-dev": AgentDevResponse;
  custom: CustomResponse;
  feedback: FeedbackResponse;
}
