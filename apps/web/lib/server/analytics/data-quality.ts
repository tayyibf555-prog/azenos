import { sql } from "drizzle-orm";
import { db } from "@azen/db";
import { EVENT_TYPES, coveragePlan, getTrackingPlan } from "../../tracking-presets";
import { listEventTypesSeen } from "../queries";

/**
 * Data-quality card (P9-PACK3 — Custom & Raw section). READ-ONLY over
 * webhook_deliveries + events, scoped to (org_id, project_id). Ingest health
 * (rejected/failed/duplicate rates) is a fixed trailing-7-day window — always
 * 7d, independent of the section's range control, so the card reads as "how
 * is ingest doing lately" rather than shifting under the user's range picker.
 * Tracking-plan coverage is ALL-TIME presence (same convention as the Setup
 * tab's TrackingPlanCard — "have we ever sent this type", not windowed).
 */

const DATA_QUALITY_WINDOW_DAYS = 7;

export interface DeliveryCounts {
  accepted: number;
  duplicate: number;
  rejected: number;
  failed: number;
}

export interface DeliveryRates {
  total: number;
  rejectedRate: number;
  failedRate: number;
  duplicateRate: number;
}

/** Pure: per-status counts → rates (0 when there were no deliveries at all). */
export function computeDeliveryRates(counts: DeliveryCounts): DeliveryRates {
  const total = counts.accepted + counts.duplicate + counts.rejected + counts.failed;
  const rate = (n: number): number => (total > 0 ? n / total : 0);
  return {
    total,
    rejectedRate: rate(counts.rejected),
    failedRate: rate(counts.failed),
    duplicateRate: rate(counts.duplicate),
  };
}

/** Pure: share of events in the window whose type isn't in the known taxonomy. */
export function computeUnknownTypeShare(
  totalEvents: number,
  unknownTypeEvents: number,
): number {
  return totalEvents > 0 ? unknownTypeEvents / totalEvents : 0;
}

/** Pure: "N/M required types ever seen" → a percentage; 100 when nothing is required. */
export function computeCoveragePct(requiredPresent: number, requiredTotal: number): number {
  return requiredTotal > 0 ? Math.round((requiredPresent / requiredTotal) * 1000) / 10 : 100;
}

export interface DataQualitySummary {
  windowDays: number;
  deliveries: DeliveryRates;
  unknownTypeShare: number;
  unknownTypeCount: number;
  totalEvents: number;
  coveragePct: number;
  requiredPresent: number;
  requiredTotal: number;
  /** true when there is nothing to flag — the calm "all clean" state. */
  isClean: boolean;
}

/** Pure: the "nothing to see here" gate — every rate is exactly 0 and coverage is full. */
export function isDataQualityClean(
  s: Pick<DataQualitySummary, "deliveries" | "unknownTypeShare" | "coveragePct">,
): boolean {
  return (
    s.deliveries.rejectedRate === 0 &&
    s.deliveries.failedRate === 0 &&
    s.deliveries.duplicateRate === 0 &&
    s.unknownTypeShare === 0 &&
    s.coveragePct >= 100
  );
}

interface DeliveryStatusRow {
  status: string;
  cnt: number | string;
}

const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Compute the full data-quality summary for one project. Deterministic in
 * (orgId, projectId, now); never throws on an empty project — every rate
 * falls back to 0 and coverage falls back to 100% (nothing required, nothing
 * missing).
 */
export async function getDataQualitySummary(
  orgId: string,
  projectId: string,
  projectType: string,
): Promise<DataQualitySummary> {
  // ── ingest health: webhook_deliveries for this project's keys, trailing 7d ──
  const deliveryRows = (await db.execute(sql`
    select d.status as status, count(*)::int as cnt
    from webhook_deliveries d
    join project_keys k on k.id = d.project_key_id
    where d.org_id = ${orgId}::uuid
      and k.project_id = ${projectId}::uuid
      and d.received_at >= now() - make_interval(days => ${DATA_QUALITY_WINDOW_DAYS})
    group by d.status
  `)) as unknown as DeliveryStatusRow[];

  const counts: DeliveryCounts = { accepted: 0, duplicate: 0, rejected: 0, failed: 0 };
  for (const row of deliveryRows) {
    const n = num(row.cnt);
    if (row.status === "accepted") counts.accepted = n;
    else if (row.status === "duplicate") counts.duplicate = n;
    else if (row.status === "rejected") counts.rejected = n;
    else if (row.status === "failed") counts.failed = n;
  }
  const deliveries = computeDeliveryRates(counts);

  // ── unknown-event-type share: same trailing 7d window, over events ─────────
  const knownTypes = new Set<string>(EVENT_TYPES as readonly string[]);
  const eventRows = (await db.execute(sql`
    select e.type as type, count(*)::int as cnt
    from events e
    where e.org_id = ${orgId}::uuid
      and e.project_id = ${projectId}::uuid
      and e.occurred_at >= now() - make_interval(days => ${DATA_QUALITY_WINDOW_DAYS})
    group by e.type
  `)) as unknown as { type: string; cnt: number | string }[];

  let totalEvents = 0;
  let unknownTypeCount = 0;
  for (const row of eventRows) {
    const n = num(row.cnt);
    totalEvents += n;
    if (!knownTypes.has(row.type)) unknownTypeCount += n;
  }
  const unknownTypeShare = computeUnknownTypeShare(totalEvents, unknownTypeCount);

  // ── tracking-plan coverage: all-time presence, same as the Setup tab ───────
  const seen = await listEventTypesSeen(orgId, projectId);
  const plan = getTrackingPlan(projectType);
  const { requiredPresent, requiredTotal } = coveragePlan(
    plan,
    seen.map((s) => s.type),
  );
  const coveragePct = computeCoveragePct(requiredPresent, requiredTotal);

  const base = { deliveries, unknownTypeShare, coveragePct };
  return {
    windowDays: DATA_QUALITY_WINDOW_DAYS,
    deliveries,
    unknownTypeShare,
    unknownTypeCount,
    totalEvents,
    coveragePct,
    requiredPresent,
    requiredTotal,
    isClean: isDataQualityClean(base),
  };
}
