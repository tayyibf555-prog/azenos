"use client";

import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { formatDelta, formatMetricValue } from "../../charts/util";
import { formatLondonTime, formatPence, relativeTime } from "../../../lib/format";
import type { GoodDirection, MetricAggregation, MetricUnit } from "../../metrics-types";
import { COLORS, eventCategory, tint } from "../../ui";
import type { AnalyticsRange, CustomResponse } from "../types";
import { HBars } from "../charts";
import { StatGrid } from "../StatGrid";
import { StatTile } from "../StatTile";
import { ComingOnline, SectionFrame, SectionSkeleton, useSectionData } from "./_shell";

/**
 * Rich Custom & Raw wire contract. Extends the foundation-guaranteed
 * `CustomResponse` (range / from / to / eventTypes preserved — eventTypes IS
 * the range-scoped by-type breakdown) with the metric + raw-explorer payload
 * the endpoint computes. Defined here so both the endpoint (`import type`)
 * and this section read from one source of truth (see PulseData for the same
 * pattern).
 */
export interface CustomMetricPoint {
  periodStart: string;
  /** null when the rollup has no value for that bucket yet. */
  value: number | null;
}

export interface CustomMetricData {
  key: string;
  name: string;
  unit: MetricUnit;
  aggregation: MetricAggregation;
  goodDirection: GoodDirection;
  /** true when this key is a project-level override/addition, not an org default. */
  isCustom: boolean;
  /** most recent non-null bucket in the window; null when the metric has no data yet. */
  latestValue: number | null;
  /** window aggregate − prior equal-length window aggregate; null when either side is empty. */
  delta: number | null;
  series: CustomMetricPoint[];
}

export interface RawEventRow {
  id: string;
  type: string;
  occurredAt: string;
  /** actor.kind: "ai_agent" | "human" | "system", or null when no actor was attached. */
  actorKind: string | null;
  actorId: string | null;
  subjectId: string | null;
  valuePence: number | null;
}

export interface CustomData extends CustomResponse {
  /** every metric_definition this project resolves to (org defaults + overrides). */
  metrics: CustomMetricData[];
  /** actor.kind counts over the selected window. */
  roleBreakdown: { role: string; count: number }[];
  /** the 50 most-recent raw events — a live tail, unbounded by the range control. */
  recentEvents: RawEventRow[];
  /** P9-PACK3 additive: ingest + tracking-plan health card. */
  dataQuality: DataQualityData;
}

/** Client copy of lib/server/analytics/data-quality.ts's DataQualitySummary. */
export interface DataQualityData {
  windowDays: number;
  deliveries: {
    total: number;
    rejectedRate: number;
    failedRate: number;
    duplicateRate: number;
  };
  unknownTypeShare: number;
  unknownTypeCount: number;
  totalEvents: number;
  coveragePct: number;
  requiredPresent: number;
  requiredTotal: number;
  isClean: boolean;
}

const RANGE_LABEL: Record<AnalyticsRange, string> = {
  "7d": "last 7 days",
  "30d": "last 30 days",
  "90d": "last 90 days",
};

const ROLE_LABEL: Record<string, { label: string; color: string }> = {
  ai_agent: { label: "AI agent", color: COLORS.teal },
  human: { label: "Human", color: COLORS.blue },
  system: { label: "System", color: COLORS.grey },
  unknown: { label: "Unknown", color: COLORS.grey },
};

/** 0..1 fraction → a 1dp percentage string ("4.2%"). */
function pct1(fraction: number): string {
  return `${(fraction * 100).toLocaleString("en-GB", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
}

// ── data-quality card (P9-PACK3): ingest health + tracking-plan coverage ─────

function DataQualityCard({ dq }: { dq: DataQualityData }) {
  if (dq.isClean) {
    return (
      <div className="card" style={{ padding: 18, display: "grid", gap: 6 }}>
        <CardTitle sub={`last ${dq.windowDays} days`}>Data quality</CardTitle>
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: COLORS.green, flex: "none" }} />
          <span className="muted" style={{ fontSize: 12.5 }}>
            All clean — no rejected, failed or duplicate deliveries, every event type is
            recognised, and every required tracking-plan type has been seen.
          </span>
        </span>
      </div>
    );
  }

  return (
    <div className="card" style={{ padding: 18, display: "grid", gap: 14 }}>
      <CardTitle sub={`ingest health over the last ${dq.windowDays} days · coverage all-time`}>
        Data quality
      </CardTitle>
      <StatGrid minTileWidth={150}>
        <StatTile
          label="Rejected deliveries"
          value={pct1(dq.deliveries.rejectedRate)}
          tone={dq.deliveries.rejectedRate > 0 ? COLORS.red : undefined}
          sub={`of ${dq.deliveries.total.toLocaleString("en-GB")} delivered`}
        />
        <StatTile
          label="Failed deliveries"
          value={pct1(dq.deliveries.failedRate)}
          tone={dq.deliveries.failedRate > 0 ? COLORS.red : undefined}
          sub={`of ${dq.deliveries.total.toLocaleString("en-GB")} delivered`}
        />
        <StatTile
          label="Duplicate rate"
          value={pct1(dq.deliveries.duplicateRate)}
          tone={dq.deliveries.duplicateRate > 0 ? COLORS.amber : undefined}
          sub={`of ${dq.deliveries.total.toLocaleString("en-GB")} delivered`}
        />
        <StatTile
          label="Unknown event types"
          value={pct1(dq.unknownTypeShare)}
          tone={dq.unknownTypeShare > 0 ? COLORS.amber : undefined}
          sub={`${dq.unknownTypeCount.toLocaleString("en-GB")} of ${dq.totalEvents.toLocaleString("en-GB")} events`}
        />
        <StatTile
          label="Tracking-plan coverage"
          value={`${dq.coveragePct.toLocaleString("en-GB")}%`}
          tone={dq.coveragePct < 100 ? COLORS.amber : COLORS.green}
          sub={`${dq.requiredPresent}/${dq.requiredTotal} required types seen`}
        />
      </StatGrid>
    </div>
  );
}

function CardTitle({ children, sub }: { children: ReactNode; sub?: ReactNode }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
      <span style={{ fontSize: 14, fontWeight: 620 }}>{children}</span>
      {sub && (
        <span className="faint" style={{ fontSize: 11.5 }}>
          {sub}
        </span>
      )}
    </div>
  );
}

// ── one white card per custom metric: label, tnum value, delta chip, sparkline ──

/**
 * Aggregate a metric's window buckets on the SAME basis the delta uses
 * (route: additive kinds sum, point-in-time / statistical kinds average).
 * Keeps the hero number and the "vs prior window" delta on one scale — the
 * single most-recent bucket (latestValue) is a different, smaller population
 * for additive metrics, so a 30-day-sum delta could dwarf a one-day hero.
 */
function windowAggregate(values: number[], aggregation: MetricAggregation): number | null {
  if (values.length === 0) return null;
  const total = values.reduce((a, b) => a + b, 0);
  return aggregation === "sum" || aggregation === "count"
    ? total
    : total / values.length;
}

function MetricCard({ metric, rangeLabel }: { metric: CustomMetricData; rangeLabel: string }) {
  const trendValues = metric.series
    .map((p) => p.value)
    .filter((v): v is number => v !== null);
  const heroValue = windowAggregate(trendValues, metric.aggregation);

  return (
    <StatTile
      label={
        <>
          {metric.name}
          {metric.isCustom && (
            <span
              className="badge"
              style={{
                marginLeft: 7,
                color: COLORS.teal,
                background: tint(COLORS.teal, 0.13),
                borderColor: tint(COLORS.teal, 0.28),
                fontSize: 10,
                padding: "1px 6px",
              }}
            >
              custom
            </span>
          )}
        </>
      }
      value={formatMetricValue(heroValue, metric.unit)}
      delta={metric.delta}
      deltaLabel={metric.delta !== null ? formatDelta(metric.delta, metric.unit) : undefined}
      goodDirection={metric.goodDirection}
      sub={`vs prior ${rangeLabel}`}
      sparkline={trendValues}
    />
  );
}

// ── recent-events table (bespoke, matches the AgentDevSection DataTable pattern) ──

function EventTypeBadge({ type }: { type: string }) {
  const { label, color } = eventCategory(type);
  return (
    <span
      className="badge"
      style={{
        color,
        background: tint(color, 0.13),
        borderColor: tint(color, 0.28),
        fontSize: 11,
      }}
      title={label}
    >
      {type}
    </span>
  );
}

function RecentEventsTable({ rows }: { rows: RawEventRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="faint" style={{ fontSize: 12.5, padding: "18px 0", textAlign: "center" }}>
        No events match this filter.
      </div>
    );
  }
  return (
    <div style={{ overflowX: "auto", maxWidth: "100%" }}>
      <table style={{ width: "100%", minWidth: 640, borderCollapse: "collapse", fontSize: 12.5 }}>
        <thead>
          <tr>
            {["Time", "Type", "Actor", "Subject", "Value"].map((h, i) => (
              <th
                key={h}
                className="faint"
                style={{
                  textAlign: i === 0 ? "left" : i === 4 ? "right" : "left",
                  fontWeight: 550,
                  fontSize: 11,
                  padding: "0 10px 8px",
                  whiteSpace: "nowrap",
                }}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const role = ROLE_LABEL[row.actorKind ?? "unknown"] ?? ROLE_LABEL.unknown!;
            return (
              <tr key={row.id} style={{ borderTop: "1px solid var(--border)" }}>
                <td className="tnum faint" style={{ padding: "9px 10px", whiteSpace: "nowrap" }} title={formatLondonTime(row.occurredAt)}>
                  {relativeTime(row.occurredAt)}
                </td>
                <td style={{ padding: "9px 10px", whiteSpace: "nowrap" }}>
                  <EventTypeBadge type={row.type} />
                </td>
                <td style={{ padding: "9px 10px", whiteSpace: "nowrap" }}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <span style={{ width: 7, height: 7, borderRadius: "50%", background: role.color, flex: "none" }} />
                    <span className="muted">{role.label}</span>
                    {row.actorId && (
                      <span className="faint tnum" style={{ fontSize: 11 }}>
                        {row.actorId}
                      </span>
                    )}
                  </span>
                </td>
                <td className="faint tnum" style={{ padding: "9px 10px", whiteSpace: "nowrap" }}>
                  {row.subjectId ?? "—"}
                </td>
                <td className="tnum" style={{ padding: "9px 10px", whiteSpace: "nowrap", textAlign: "right" }}>
                  {row.valuePence !== null ? formatPence(row.valuePence) : "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function CustomSection({
  projectId,
  range,
}: {
  projectId: string;
  range: AnalyticsRange;
}) {
  const state = useSectionData<CustomData>("custom", projectId, range);
  return (
    <SectionFrame
      title="Custom & Raw"
      subtitle="Every metric configured for this project, plus a live tail of the raw event spine."
    >
      {state.status === "loading" ? (
        <SectionSkeleton />
      ) : state.status === "error" ? (
        <ComingOnline note="Custom & Raw couldn't load just now. It'll return once the data is reachable." />
      ) : (
        <CustomBody data={state.data} range={range} />
      )}
    </SectionFrame>
  );
}

function CustomBody({ data, range }: { data: CustomData; range: AnalyticsRange }) {
  const rangeLabel = RANGE_LABEL[range];
  const [typeFilter, setTypeFilter] = useState<string | null>(null);

  const availableTypes = useMemo(() => {
    const seen = new Set<string>();
    for (const e of data.recentEvents) seen.add(e.type);
    return [...seen].sort();
  }, [data.recentEvents]);

  const filteredEvents = useMemo(
    () => (typeFilter ? data.recentEvents.filter((e) => e.type === typeFilter) : data.recentEvents),
    [data.recentEvents, typeFilter],
  );

  const roleItems = data.roleBreakdown.map((r) => {
    const meta = ROLE_LABEL[r.role] ?? ROLE_LABEL.unknown!;
    return { label: meta.label, value: r.count, color: meta.color };
  });
  const typeItems = data.eventTypes.map((t) => ({
    label: t.type,
    value: t.count,
    color: eventCategory(t.type).color,
  }));

  return (
    <div style={{ display: "grid", gap: 16 }}>
      {/* ── custom metrics ─────────────────────────────────────────────────── */}
      {data.metrics.length === 0 ? (
        <ComingOnline note="No custom metrics yet — define one in the Metrics tab." />
      ) : (
        <StatGrid minTileWidth={190}>
          {data.metrics.map((m) => (
            <MetricCard key={m.key} metric={m} rangeLabel={rangeLabel} />
          ))}
        </StatGrid>
      )}

      {/* ── data quality (P9-PACK3) ─────────────────────────────────────────── */}
      <DataQualityCard dq={data.dataQuality} />

      {/* ── raw event explorer ─────────────────────────────────────────────── */}
      <div className="glass-strong" style={{ padding: 18, display: "grid", gap: 16 }}>
        <CardTitle
          sub={`${data.recentEvents.length.toLocaleString("en-GB")} most-recent · breakdowns over the ${rangeLabel}`}
        >
          Raw event explorer
        </CardTitle>

        <div
          style={{
            display: "grid",
            gap: 16,
            gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
          }}
        >
          <div className="card" style={{ padding: 14, display: "grid", gap: 10, minWidth: 0 }}>
            <span className="muted" style={{ fontSize: 12, fontWeight: 550 }}>
              By event type
            </span>
            <HBars items={typeItems} emptyLabel={`No events in the ${rangeLabel}.`} />
          </div>
          <div className="card" style={{ padding: 14, display: "grid", gap: 10, minWidth: 0 }}>
            <span className="muted" style={{ fontSize: 12, fontWeight: 550 }}>
              By actor role
            </span>
            <HBars items={roleItems} emptyLabel={`No events in the ${rangeLabel}.`} />
          </div>
        </div>

        <div style={{ display: "grid", gap: 10 }}>
          {availableTypes.length > 0 && (
            <div
              className="card"
              style={{ display: "inline-flex", flexWrap: "wrap", padding: 3, gap: 2, borderRadius: 10, width: "fit-content" }}
              role="group"
              aria-label="Filter by event type"
            >
              <button
                type="button"
                onClick={() => setTypeFilter(null)}
                className={typeFilter === null ? "nav-item nav-item-active" : "nav-item"}
                style={{ padding: "5px 12px", cursor: "pointer", fontSize: 12 }}
                aria-pressed={typeFilter === null}
              >
                All
              </button>
              {availableTypes.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTypeFilter(t)}
                  className={typeFilter === t ? "nav-item nav-item-active" : "nav-item"}
                  style={{ padding: "5px 12px", cursor: "pointer", fontSize: 12 }}
                  aria-pressed={typeFilter === t}
                >
                  {t}
                </button>
              ))}
            </div>
          )}
          <RecentEventsTable rows={filteredEvents} />
        </div>
      </div>
    </div>
  );
}
