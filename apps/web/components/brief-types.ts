/**
 * Shared brief shapes for the Briefs screen + Command Center inline brief.
 * Mirrors the `briefs` row (packages/db schema/agents.ts) the P3-BRIEF agent
 * writes. Client-safe: pure types + tiny display helper, no server imports.
 */

export type BriefStatus = "generated" | "sent" | "failed";
export type BriefPeriod = "daily" | "weekly" | "monthly";
export type BriefScope = "agency" | "project";

/** The subset of a `briefs` row the UI reads. All timestamps are ISO strings. */
export interface BriefSummary {
  id: string;
  scope: BriefScope;
  period: BriefPeriod;
  periodStart: string;
  headline: string;
  status: BriefStatus;
  sentEmailAt: string | null;
  sentWhatsappAt: string | null;
  createdAt: string;
}

export interface BriefDetail extends BriefSummary {
  bodyMd: string;
  bodyWhatsapp: string | null;
  dataSnapshot: Record<string, unknown>;
  model: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
}

/** Response of GET /api/briefs/latest — most recent agency daily brief or null. */
export interface LatestBriefResponse {
  brief: BriefDetail | null;
}
