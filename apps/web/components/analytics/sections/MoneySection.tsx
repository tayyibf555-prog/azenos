"use client";

import { formatPence } from "../../../lib/format";
import { COLORS, tint } from "../../ui";
import type { AnalyticsRange, MoneyResponse } from "../types";
import { Donut, Leaderboard, LineChart, topSegments } from "../charts";
import { StatGrid } from "../StatGrid";
import { StatTile } from "../StatTile";
import { ExpandableChart } from "../ExpandableChart";
import { Pill } from "../../system/Pill";
import { ComingOnline, SectionFrame, SectionSkeleton, useSectionData } from "./_shell";

/**
 * Client copy of the richer money wire shape the endpoint returns. It is a
 * structural superset of MoneyResponse (same `range`/`from`/`to`/`totalPence`/
 * `series`), so the fetch contract is unchanged — these are the ADDED fields.
 */
interface MoneyByType {
  type: string;
  label: string;
  pence: number;
  count: number;
}
interface MoneyValueEvent {
  id: string;
  type: string;
  label: string;
  occurredAt: string;
  pence: number;
}
/** P9-PACK3 additive: one point of the client's cumulative-revenue curve. */
interface LtvCurvePoint {
  month: string;
  pence: number;
  cumulativePence: number;
}
/** P9-PACK3 additive: agency-revenue concentration risk note. */
interface RevenueConcentration {
  clientPence: number;
  orgPence: number;
  pct: number;
  tone: "high" | "moderate" | "low";
}
interface MoneyData extends MoneyResponse {
  grossRevenuePence: number;
  netRevenuePence: number;
  refundsPence: number;
  refundsCount: number;
  transactions: number;
  aovPence: number | null;
  minutesSaved: number;
  hoursSaved: number;
  hourlyRatePence: number;
  timeValuePence: number;
  attributedValuePence: number;
  runCostPence: number;
  runCount: number;
  roiMultiple: number | null;
  revenueByType: MoneyByType[];
  topValueEvents: MoneyValueEvent[];
  buildFeePence: number;
  monthlyAttributedValuePence: number;
  paybackMonths: number | null;
  ltvCurve: LtvCurvePoint[];
  revenueConcentration: RevenueConcentration;
}

const RANGE_LABEL: Record<AnalyticsRange, string> = {
  "7d": "last 7 days",
  "30d": "last 30 days",
  "90d": "last 90 days",
};

const CONCENTRATION_COLOR: Record<RevenueConcentration["tone"], string> = {
  high: COLORS.red,
  moderate: COLORS.amber,
  low: COLORS.green,
};
const CONCENTRATION_LABEL: Record<RevenueConcentration["tone"], string> = {
  high: "High concentration",
  moderate: "Moderate concentration",
  low: "Diversified",
};

/**
 * Cumulative client-LTV curve — a plain axis-less area/line built directly
 * (no shared LineChart reuse: its x-axis expects daily/hourly period keys,
 * not the monthly 'YYYY-MM' labels an LTV curve naturally has). Lives behind
 * an ExpandableChart per the Numbers-first rule; the hero cumulative number
 * is the tile above it.
 */
function LtvCurveChart({ points }: { points: LtvCurvePoint[] }) {
  if (points.length < 2) {
    return (
      <span className="faint" style={{ fontSize: 12.5 }}>
        Not enough payment history yet to draw a curve — one point needs at least
        two paid months.
      </span>
    );
  }
  const w = 560;
  const h = 140;
  const padL = 8;
  const padR = 8;
  const padT = 10;
  const padB = 20;
  const max = Math.max(...points.map((p) => p.cumulativePence), 1);
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;
  const xAt = (i: number) => padL + (points.length === 1 ? 0 : (i / (points.length - 1)) * plotW);
  const yAt = (v: number) => padT + plotH - (v / max) * plotH;
  const linePath = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${xAt(i).toFixed(1)},${yAt(p.cumulativePence).toFixed(1)}`)
    .join(" ");
  const areaPath = `${linePath} L${xAt(points.length - 1).toFixed(1)},${(padT + plotH).toFixed(1)} L${xAt(0).toFixed(1)},${(padT + plotH).toFixed(1)} Z`;

  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} role="img" aria-label="Cumulative client revenue by month">
      <path d={areaPath} fill={tint(COLORS.green, 0.14)} stroke="none" />
      <path d={linePath} fill="none" stroke={COLORS.green} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      {points.map((p, i) => (
        <circle key={p.month} cx={xAt(i)} cy={yAt(p.cumulativePence)} r={2.5} fill={COLORS.green} />
      ))}
      <text x={padL} y={h - 4} fontSize={10} fill="var(--text-3)">{points[0]!.month}</text>
      <text x={w - padR} y={h - 4} fontSize={10} textAnchor="end" fill="var(--text-3)">
        {points[points.length - 1]!.month}
      </text>
    </svg>
  );
}

export function MoneySection({
  projectId,
  range,
}: {
  projectId: string;
  range: AnalyticsRange;
}) {
  const state = useSectionData<MoneyData>("money", projectId, range);

  if (state.status === "loading") {
    return (
      <SectionFrame
        title="Money & Value"
        subtitle="Revenue attributed to this project and its ROI."
      >
        <SectionSkeleton />
      </SectionFrame>
    );
  }

  if (state.status === "error") {
    return (
      <SectionFrame
        title="Money & Value"
        subtitle="Revenue attributed to this project and its ROI."
      >
        <ComingOnline note="Money & value couldn't load just now. It'll return once the data is reachable." />
      </SectionFrame>
    );
  }

  const d = state.data;
  const rangeLabel = RANGE_LABEL[range];
  const hasAnyValue =
    d.grossRevenuePence > 0 ||
    d.timeValuePence > 0 ||
    d.runCostPence > 0 ||
    d.refundsPence > 0;

  const trendValues = d.series.map((p) => p.value);
  const topRevenueSources = topSegments(
    d.revenueByType.map((t) => ({ label: t.label, value: t.pence })),
    3,
  );

  const roiDisplay =
    d.roiMultiple !== null ? `${d.roiMultiple.toLocaleString("en-GB")}×` : "—";

  return (
    <SectionFrame
      title="Money & Value"
      subtitle="What this project returned — attributed revenue, the value of time saved, and its honest ROI against agent run-cost."
    >
      {!hasAnyValue ? (
        <ComingOnline note="No money or time-saved value has landed for this project in this window yet. Revenue, ROI and the value leaderboard fill in as payment, invoice and time-saving events arrive." />
      ) : (
        <div style={{ display: "grid", gap: 16 }}>
          {/* the numbers — ROI hero + every value/cost aggregate the endpoint computes */}
          <StatGrid>
            <StatTile
              label={`Return on run-cost · ${rangeLabel}`}
              value={roiDisplay}
              sub={
                d.roiMultiple !== null
                  ? `${formatPence(d.attributedValuePence)} ÷ ${formatPence(d.runCostPence)}`
                  : "No run-cost recorded yet"
              }
              sparkline={trendValues}
              sparkColor={COLORS.teal}
              size="lg"
            />
            <StatTile
              label="Value returned"
              value={formatPence(d.attributedValuePence)}
              sub="net revenue + time-saved"
            />
            <StatTile
              label="Net revenue"
              value={formatPence(d.netRevenuePence)}
              tone={d.netRevenuePence < 0 ? COLORS.red : undefined}
              sub={
                d.refundsPence > 0
                  ? `${formatPence(d.grossRevenuePence)} gross − ${formatPence(d.refundsPence)} refunded`
                  : `${formatPence(d.grossRevenuePence)} gross`
              }
            />
            <StatTile
              label="Time-saved value"
              value={formatPence(d.timeValuePence)}
              sub={`${d.hoursSaved.toLocaleString("en-GB")} h @ ${formatPence(d.hourlyRatePence)}/h`}
            />
            <StatTile
              label="Average order value"
              value={d.aovPence !== null ? formatPence(d.aovPence) : "—"}
              sub={`${d.transactions.toLocaleString("en-GB")} transaction${d.transactions === 1 ? "" : "s"}`}
            />
            <StatTile
              label="Agent run-cost"
              value={formatPence(d.runCostPence)}
              sub={`${d.runCount.toLocaleString("en-GB")} run${d.runCount === 1 ? "" : "s"}`}
            />
            {d.refundsPence > 0 && (
              <StatTile
                label="Refunded"
                value={formatPence(d.refundsPence)}
                tone={COLORS.red}
                sub={`${d.refundsCount.toLocaleString("en-GB")} refund${d.refundsCount === 1 ? "" : "s"}`}
              />
            )}
          </StatGrid>

          {/* Revenue trend — numbers already above; line behind an expand. */}
          <div className="card" style={{ padding: 18, display: "grid", gap: 12 }}>
            <div>
              <span style={{ fontSize: 14, fontWeight: 620 }}>Revenue trend</span>
              <span className="faint" style={{ fontSize: 12, marginLeft: 8 }}>
                attributed revenue per day · {rangeLabel}
              </span>
            </div>
            <ExpandableChart label="daily trend">
              <LineChart points={d.series} color={COLORS.green} unit="pence" period={range} />
            </ExpandableChart>
          </div>

          {/* Revenue by source — top source + top-3, ring behind an expand. Top value events stay a leaderboard. */}
          <div
            style={{
              display: "grid",
              gap: 16,
              gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
            }}
          >
            <div className="card" style={{ padding: 18, display: "grid", gap: 14 }}>
              <div>
                <span style={{ fontSize: 14, fontWeight: 620 }}>Revenue by source</span>
                <span className="faint" style={{ fontSize: 12, marginLeft: 8 }}>
                  where the money came from
                </span>
              </div>
              {topRevenueSources.length === 0 ? (
                <span className="faint" style={{ fontSize: 12.5 }}>No attributed revenue in this window yet.</span>
              ) : (
                <>
                  <StatTile
                    label="Top source"
                    value={topRevenueSources[0]!.label}
                    deltaLabel={formatPence(topRevenueSources[0]!.value)}
                  />
                  <Leaderboard
                    rows={topRevenueSources}
                    formatValue={(v) => formatPence(v)}
                  />
                </>
              )}
              {d.refundsPence > 0 && (
                <span className="faint tnum" style={{ fontSize: 11.5 }}>
                  {formatPence(d.refundsPence)} refunded across{" "}
                  {d.refundsCount.toLocaleString("en-GB")} refund
                  {d.refundsCount === 1 ? "" : "s"} (not shown above).
                </span>
              )}
              <ExpandableChart label="source ring">
                <Donut
                  segments={d.revenueByType.map((t) => ({ label: t.label, value: t.pence }))}
                  formatValue={(v) => formatPence(v)}
                  centerLabel={formatPence(d.grossRevenuePence)}
                  emptyLabel="No attributed revenue in this window yet."
                />
              </ExpandableChart>
            </div>

            <div className="card" style={{ padding: 18, display: "grid", gap: 14 }}>
              <div>
                <span style={{ fontSize: 14, fontWeight: 620 }}>Top value events</span>
                <span className="faint" style={{ fontSize: 12, marginLeft: 8 }}>
                  biggest single transactions
                </span>
              </div>
              <Leaderboard
                rows={d.topValueEvents.map((e) => ({
                  label: e.label,
                  value: e.pence,
                }))}
                formatValue={(v) => formatPence(v)}
                emptyLabel="No revenue events to rank in this window yet."
              />
            </div>
          </div>

          {/* P9-PACK3 additive: payback period + client LTV curve + concentration note. */}
          <div className="card" style={{ padding: 18, display: "grid", gap: 14 }}>
            <div>
              <span style={{ fontSize: 14, fontWeight: 620 }}>Payback &amp; lifetime value</span>
              <span className="faint" style={{ fontSize: 12, marginLeft: 8 }}>
                how this client pays back its build fee, and how much they're worth over time
              </span>
            </div>
            <StatGrid minTileWidth={190}>
              <StatTile
                label="Payback period"
                value={d.paybackMonths !== null ? `${d.paybackMonths.toLocaleString("en-GB")} mo` : "—"}
                sub={
                  d.buildFeePence > 0
                    ? `${formatPence(d.buildFeePence)} build fee ÷ ${formatPence(d.monthlyAttributedValuePence)}/mo`
                    : "No build fee recorded"
                }
              />
              <StatTile
                label="Client lifetime value"
                value={formatPence(d.revenueConcentration.clientPence)}
                sub="agency revenue from this client, all time"
              />
              <StatTile
                label="Revenue concentration"
                value={`${d.revenueConcentration.pct.toLocaleString("en-GB")}%`}
                tone={CONCENTRATION_COLOR[d.revenueConcentration.tone]}
                sub={CONCENTRATION_LABEL[d.revenueConcentration.tone]}
              />
            </StatGrid>
            {d.revenueConcentration.tone === "high" && (
              <span style={{ width: "fit-content" }}>
                <Pill tone="rose">
                  Over half of agency revenue comes from this one client — a single-client risk.
                </Pill>
              </span>
            )}
            <ExpandableChart label="lifetime value curve">
              <LtvCurveChart points={d.ltvCurve} />
            </ExpandableChart>
          </div>
        </div>
      )}
    </SectionFrame>
  );
}
