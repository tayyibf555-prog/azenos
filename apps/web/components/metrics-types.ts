/**
 * JSON response shapes for the Phase 2 metrics / ROI / insights / costs
 * endpoints (workstream M2). M3 client components code against these exactly.
 *
 * Kept deliberately separate from the Phase 1 `components/types.ts` (owned by
 * workstream D) — this file is M3-owned. Pure types only, no runtime code.
 */

export type MetricAggregation =
  | "sum"
  | "count"
  | "avg"
  | "p95"
  | "last"
  | "rate";
export type MetricUnit = "count" | "pence" | "minutes" | "percent" | "ms";
export type GoodDirection = "up" | "down";
export type RollupPeriod = "hour" | "day" | "week" | "month";

/** Aggregation / unit option lists for the Add-metric form (contract enums). */
export const METRIC_AGGREGATIONS: readonly MetricAggregation[] = [
  "count",
  "sum",
  "avg",
  "p95",
  "last",
  "rate",
];
export const METRIC_UNITS: readonly MetricUnit[] = [
  "count",
  "pence",
  "minutes",
  "percent",
  "ms",
];

export interface MetricDefinition {
  key: string;
  name: string;
  description: string | null;
  unit: MetricUnit;
  aggregation: MetricAggregation;
  eventType: string;
  valuePath: string | null;
  whereEquals: Record<string, string | number | boolean> | null;
  goodDirection: GoodDirection;
  isKpi: boolean;
  sort: number;
  isCustom: boolean;
  /** virtual ratio metrics (agent_success_rate, …) — read-only, no delete */
  isDerived?: boolean;
}

export interface MetricsDefinitionsResponse {
  definitions: MetricDefinition[];
}

export interface SeriesPoint {
  periodStart: string;
  value: number;
}

export interface MetricMeta {
  name: string;
  unit: MetricUnit;
  goodDirection: GoodDirection;
  aggregation: MetricAggregation;
}

export interface SeriesResponse {
  series: Record<string, SeriesPoint[]>;
  compare?: Record<string, SeriesPoint[]>;
  meta: Record<string, MetricMeta>;
}

export interface PreviewSampleEvent {
  id: string;
  occurredAt: string;
  extracted: number | string | boolean | null;
}

export interface PreviewPoint {
  periodStart: string;
  value: number;
  sampleCount: number;
}

export interface MetricPreviewResponse {
  series: PreviewPoint[];
  total: number;
  sampleEvents: PreviewSampleEvent[];
}

export interface CreateMetricBody {
  key: string;
  name: string;
  description?: string;
  unit: MetricUnit;
  aggregation: MetricAggregation;
  eventType: string;
  valuePath?: string | null;
  whereEquals?: Record<string, string | number | boolean> | null;
  goodDirection?: GoodDirection;
  isKpi?: boolean;
}

export interface CreateMetricResponse {
  definition: MetricDefinition;
}

// ── metric discovery (§P9-W0B) ────────────────────────────────────────────────

/** A METRIC_CATALOG template resolved against this project's data. */
export interface DiscoveredMetricView {
  key: string;
  name: string;
  description: string;
  eventType: string;
  aggregation: MetricAggregation;
  unit: MetricUnit;
  valuePath: string | null;
  whereEquals: Record<string, string | number | boolean> | null;
  goodDirection: GoodDirection;
  isKpi: boolean;
  groupId: string;
  /** Human evidence, e.g. "payment.captured seen 214×". */
  why: string;
}

export interface CoverageItemView {
  type: string;
  required: boolean;
  present: boolean;
}

export interface MetricDiscoveryResponse {
  core: DiscoveredMetricView[];
  enabled: MetricDefinition[];
  available: DiscoveredMetricView[];
  missing: CoverageItemView[];
}

export interface RoiResponse {
  revenueAttributedPence: number;
  minutesSaved: number;
  timeValuePence: number;
  hourlyRatePence: number;
  retainerPence: number;
  runCostPence: number;
  roiMultiple: number | null;
  breakdown: Record<string, number | null>;
}

/** Lightweight evidence event for the Scout drill-down (§P6-SCOUT). */
export interface EvidenceEvent {
  id: string;
  type: string;
  occurredAt: string;
}

export interface InsightItem {
  id: string;
  kind: string;
  title: string;
  bodyMd: string;
  confidence: string;
  status: string;
  evidence: Record<string, unknown>;
  createdAt: string;
  /** Resolved from evidence.event_ids by the insights API (drill-down). */
  evidenceEvents?: EvidenceEvent[];
}

export interface InsightsResponse {
  insights: InsightItem[];
}

export interface SparklinePayload {
  metricKey: string;
  points: { day: string; value: number }[];
}

export interface SparklinesResponse {
  sparklines: Record<string, SparklinePayload>;
}

export interface ProjectCostRow {
  projectId: string;
  name: string;
  clientSystemAiPence: number;
  osAgentPence: number;
  totalPence: number;
}

export interface ClientCostRow {
  clientId: string;
  clientName: string;
  projects: ProjectCostRow[];
  totals: {
    clientSystemAiPence: number;
    osAgentPence: number;
    totalPence: number;
  };
}

export interface CostsResponse {
  clients: ClientCostRow[];
  orgOverheadPence: number;
}

/** Single-project cost view (addendum §B). Shape kept minimal + defensive. */
export interface ProjectCostsResponse {
  clientSystemAiPence: number;
  osAgentPence: number;
  totalPence: number;
  projectId?: string;
  name?: string;
  month?: string;
}

export interface ApiErrorShape {
  error: string;
}
