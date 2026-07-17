"use client";

import type { ReactNode } from "react";
import type {
  AnalyticsRange,
  FunnelResponse,
  LabelledValue,
  SeriesPoint,
} from "../types";
import {
  Funnel,
  HBars,
  LineChart,
} from "../charts";
import type { ChartPoint } from "../charts";
import { COLORS } from "../../ui";
import { StatGrid } from "../StatGrid";
import { StatTile } from "../StatTile";
import { ExpandableChart } from "../ExpandableChart";
import { SectionFrame, SectionSkeleton, useSectionData } from "./_shell";

/**
 * Funnel & Conversion. Mirrors the richer `FunnelData` the endpoint returns
 * (types.ts owns only the flat `stages` contract, so the extra fields are
 * declared here). Every number is labelled; empty ranges render calm zeros.
 */

interface FunnelStageDetail {
  key: string;
  label: string;
  count: number;
  fromPrevPct: number | null;
  fromTopPct: number | null;
  dropFromPrev: number;
  avgLagHoursFromPrev: number | null;
}

interface FunnelStagePercentile {
  key: string;
  fromLabel: string;
  toLabel: string;
  sampleSize: number;
  p50Hours: number | null;
  p90Hours: number | null;
}

interface FunnelData extends FunnelResponse {
  stageDetail: FunnelStageDetail[];
  leadTotal: number;
  paidTotal: number;
  overallConversionPct: number | null;
  biggestDrop: { fromLabel: string; toLabel: string; dropPct: number } | null;
  sources: LabelledValue[];
  leadsSeries: SeriesPoint[];
  stagePercentiles: FunnelStagePercentile[];
  abandonedIntents: LabelledValue[];
}

function Card({ children, style }: { children: ReactNode; style?: React.CSSProperties }) {
  return (
    <div className="card" style={{ padding: 20, display: "grid", gap: 14, ...style }}>
      {children}
    </div>
  );
}

function CardTitle({ children }: { children: ReactNode }) {
  return (
    <span className="muted" style={{ fontSize: 12.5, fontWeight: 600 }}>
      {children}
    </span>
  );
}

const pct = (v: number | null): string => (v === null ? "—" : `${v}%`);

/** Human lag: hours under a day, else days. */
function lag(hours: number | null): string {
  if (hours === null) return "—";
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 48) return `${hours}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

function ConversionTable({ rows }: { rows: FunnelStageDetail[] }) {
  return (
    <div style={{ overflowX: "auto", maxWidth: "100%" }}>
      {/* RECIPE — the sanctioned .table class (globals.css): row separation is
          hover-highlight only, never a hairline divider. */}
      <table className="table" style={{ minWidth: 520 }}>
        <thead>
          <tr style={{ textAlign: "right" }}>
            <th style={{ textAlign: "left" }}>Stage</th>
            <th>Count</th>
            <th>From prev</th>
            <th>Of leads</th>
            <th>Drop-off</th>
            <th>Avg lag</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} style={{ textAlign: "right" }}>
              <td style={{ textAlign: "left", fontWeight: 540 }}>
                {row.label}
              </td>
              <td className="tnum">
                {row.count.toLocaleString("en-GB")}
              </td>
              <td className="tnum muted">
                {pct(row.fromPrevPct)}
              </td>
              <td className="tnum muted">
                {pct(row.fromTopPct)}
              </td>
              <td className="tnum faint">
                {row.dropFromPrev > 0
                  ? `-${row.dropFromPrev.toLocaleString("en-GB")}`
                  : "—"}
              </td>
              <td className="tnum faint">
                {lag(row.avgLagHoursFromPrev)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FunnelReady({ data }: { data: FunnelData }) {
  const stages = data.stageDetail.map((st) => ({
    label: st.label,
    value: st.count,
  }));
  const leadPoints: ChartPoint[] = data.leadsSeries.map((p) => ({
    periodStart: p.periodStart,
    value: p.value,
  }));

  return (
    <div style={{ display: "grid", gap: 16 }}>
      {/* headline stats — every top-line funnel number the endpoint computes */}
      <StatGrid minTileWidth={160}>
        <StatTile
          label="Lead → paid conversion"
          value={data.overallConversionPct === null ? "—" : `${data.overallConversionPct}%`}
          sub={
            data.leadTotal === 0
              ? `${data.paidTotal.toLocaleString("en-GB")} paid · no leads tracked`
              : `${data.paidTotal.toLocaleString("en-GB")} of ${data.leadTotal.toLocaleString("en-GB")} leads`
          }
          size="lg"
        />
        <StatTile
          label="Leads in range"
          value={data.leadTotal.toLocaleString("en-GB")}
          sub="lead.created events"
        />
        <StatTile
          label="Paid outcomes"
          value={data.paidTotal.toLocaleString("en-GB")}
          sub="reached the final stage"
        />
        <StatTile
          label="Steepest drop-off"
          value={data.biggestDrop ? `${data.biggestDrop.fromLabel} → ${data.biggestDrop.toLabel}` : "—"}
          tone={data.biggestDrop ? COLORS.red : undefined}
          sub={data.biggestDrop ? `-${data.biggestDrop.dropPct}% lost at this step` : "No drop-off to flag yet."}
        />
      </StatGrid>

      {/* funnel + conversion table */}
      <div
        style={{
          display: "grid",
          gap: 16,
          gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
        }}
      >
        <Card>
          <CardTitle>Stage funnel</CardTitle>
          <Funnel stages={stages} />
        </Card>
        <Card>
          <CardTitle>Stage-to-stage conversion</CardTitle>
          <ConversionTable rows={data.stageDetail} />
          <span className="faint" style={{ fontSize: 11 }}>
            Avg lag is an approximate mean-time gap between stages.
          </span>
        </Card>
      </div>

      {/* sources + leads trend */}
      <div
        style={{
          display: "grid",
          gap: 16,
          gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
        }}
      >
        <Card>
          <CardTitle>Leads by source</CardTitle>
          <HBars
            items={data.sources.map((sourceItem) => ({
              label: sourceItem.label,
              value: sourceItem.value,
            }))}
            emptyLabel="No lead sources in this range yet."
          />
        </Card>
        <Card>
          <CardTitle>Leads over time</CardTitle>
          <ExpandableChart label="daily trend">
            {leadPoints.length >= 2 ? (
              <LineChart points={leadPoints} color={COLORS.blue} unit="count" period="day" />
            ) : (
              <div
                className="faint"
                style={{
                  minHeight: 140,
                  display: "grid",
                  placeItems: "center",
                  fontSize: 12.5,
                }}
              >
                Not enough days to plot a trend yet.
              </div>
            )}
          </ExpandableChart>
        </Card>
      </div>

      {/* P9-PACK2 additive — real stage-to-stage time percentiles + drop-off reasons */}
      <div
        style={{
          display: "grid",
          gap: 16,
          gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
        }}
      >
        <Card>
          <CardTitle>Stage-to-stage time (p50 / p90)</CardTitle>
          <StagePercentileTable rows={data.stagePercentiles} />
          <span className="faint" style={{ fontSize: 11 }}>
            Real per-entity time-to-next-stage, matched by end-user identity — only
            counts entities seen at both stages in this range.
          </span>
        </Card>
        <Card>
          <CardTitle>Drop-off reasons</CardTitle>
          <span className="faint" style={{ fontSize: 11.5 }}>
            Top intents of conversations that ended abandoned
          </span>
          <HBars
            items={data.abandonedIntents.map((i) => ({ label: i.label, value: i.value }))}
            emptyLabel="No abandoned conversations in this range yet."
            labelWidth={150}
          />
        </Card>
      </div>
    </div>
  );
}

function StagePercentileTable({ rows }: { rows: FunnelStagePercentile[] }) {
  const anyData = rows.some((r) => r.sampleSize > 0);
  if (!anyData) {
    return (
      <p className="faint" style={{ fontSize: 12.5 }}>
        No end-users could be matched across adjacent stages in this range yet
        (needs a consistent <span className="mono">subject.id</span> on both events).
      </p>
    );
  }
  return (
    <div style={{ overflowX: "auto", maxWidth: "100%" }}>
      {/* RECIPE — the sanctioned .table class (globals.css): row separation is
          hover-highlight only, never a hairline divider. */}
      <table className="table" style={{ minWidth: 420 }}>
        <thead>
          <tr style={{ textAlign: "right" }}>
            <th style={{ textAlign: "left" }}>Stage gap</th>
            <th>Matched</th>
            <th>p50</th>
            <th>p90</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} style={{ textAlign: "right" }}>
              <td style={{ textAlign: "left", fontWeight: 540 }}>
                {row.fromLabel} → {row.toLabel}
              </td>
              <td className="tnum muted">
                {row.sampleSize.toLocaleString("en-GB")}
              </td>
              <td className="tnum">
                {lag(row.p50Hours)}
              </td>
              <td className="tnum">
                {lag(row.p90Hours)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function FunnelSection({
  projectId,
  range,
}: {
  projectId: string;
  range: AnalyticsRange;
}) {
  const state = useSectionData<FunnelData>("funnel", projectId, range);
  return (
    <SectionFrame
      title="Funnel & Conversion"
      subtitle="Stage-to-stage flow from first touch to paid outcome."
    >
      {state.status === "loading" ? (
        <SectionSkeleton />
      ) : state.status === "error" ? (
        <div className="card" style={{ padding: 24, textAlign: "center" }}>
          <span className="faint" style={{ fontSize: 12.5 }}>
            Funnel data is unavailable right now.
          </span>
        </div>
      ) : (
        <FunnelReady data={state.data} />
      )}
    </SectionFrame>
  );
}
