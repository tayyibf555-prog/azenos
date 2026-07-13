/**
 * JSON shapes for the Growth screen client components (P6-GROWTH). Mirrors the
 * return types in apps/web/lib/server/growth.ts. Pure types — no runtime code,
 * safe in client bundles.
 */

export interface EvidenceEvent {
  id: string;
  type: string;
  occurredAt: string;
}

export interface PipelineItem {
  id: string;
  kind: string;
  title: string;
  bodyMd: string;
  confidence: string;
  status: string;
  estimatedValuePence: number | null;
  estimatedHoursSavedMonthly: number | null;
  clientId: string;
  clientName: string;
  projectId: string;
  projectName: string;
  evidenceEventCount: number;
  createdAt: string;
}

export interface ProposalItem {
  id: string;
  clientId: string;
  clientName: string;
  projectId: string | null;
  projectName: string | null;
  title: string;
  problemMd: string;
  proposalMd: string;
  suggestedPricePence: number | null;
  status: string;
  insightIds: string[];
  expectedRoiNote: string | null;
  evidenceEvents: EvidenceEvent[];
  createdAt: string;
}

export interface GrowthSummary {
  /** revenue attributed to the OS: sum of WON proposals' suggested prices. */
  wonRevenuePence: number;
  wonCount: number;
  openProposals: number;
  openOpportunities: number;
}

export interface PipelineResponse {
  pipeline: PipelineItem[];
}

export interface ProposalsResponse {
  proposals: ProposalItem[];
}

export interface ApiErrorShape {
  error: string;
}

/** The proposal lifecycle columns, in board order. */
export const PROPOSAL_STATUSES = [
  "draft",
  "ready",
  "sent",
  "won",
  "lost",
] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];
