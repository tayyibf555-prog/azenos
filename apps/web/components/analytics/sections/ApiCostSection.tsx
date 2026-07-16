"use client";

import { formatPence } from "../../../lib/format";
import { COLORS } from "../../ui";
import type { AnalyticsRange } from "../types";
import { LineChart, Leaderboard } from "../charts";
import { StatGrid } from "../StatGrid";
import { StatTile } from "../StatTile";
import { ExpandableChart } from "../ExpandableChart";
import { ComingOnline, SectionFrame, SectionSkeleton, useSectionData } from "./_shell";

/** Client copy of the api-cost wire shape (see lib/server/analytics/api-cost.ts). */
interface CostStreamPoint {
  periodStart: string;
  osPence: number;
  emittedPence: number;
}
interface ProviderCost {
  provider: string;
  label: string;
  pence: number;
  runs: number;
  tokensIn: number;
  tokensOut: number;
}
interface AgentCost {
  agent: string;
  label: string;
  pence: number;
  runs: number;
  tokensIn: number;
  tokensOut: number;
}
interface TopCostRun {
  id: string;
  stream: "os" | "client";
  label: string;
  provider: string | null;
  occurredAt: string;
  pence: number;
}
interface ApiCostData {
  range: AnalyticsRange;
  from: string;
  to: string;
  totalPence: number;
  osPence: number;
  emittedPence: number;
  osRuns: number;
  emittedRuns: number;
  osTokensIn: number;
  osTokensOut: number;
  emittedTokensIn: number;
  emittedTokensOut: number;
  series: CostStreamPoint[];
  byProvider: ProviderCost[];
  byAgent: AgentCost[];
  conversations: number;
  costPerConversationPence: number | null;
  resolutions: number;
  costPerResolutionPence: number | null;
  outcomes: number;
  costPerOutcomePence: number | null;
  topRuns: TopCostRun[];
}

const RANGE_LABEL: Record<AnalyticsRange, string> = {
  "7d": "last 7 days",
  "30d": "last 30 days",
  "90d": "last 90 days",
};

const fmtTokens = (n: number): string =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toLocaleString("en-GB", { maximumFractionDigits: 1 })}M`
    : n >= 1_000
      ? `${(n / 1_000).toLocaleString("en-GB", { maximumFractionDigits: 1 })}k`
      : n.toLocaleString("en-GB");

export function ApiCostSection({
  projectId,
  range,
}: {
  projectId: string;
  range: AnalyticsRange;
}) {
  const state = useSectionData<ApiCostData>("api-cost", projectId, range);

  if (state.status === "loading") {
    return (
      <SectionFrame
        title="API Cost & Usage"
        subtitle="What this project costs to run — our OS agents and the client's own systems."
      >
        <SectionSkeleton />
      </SectionFrame>
    );
  }

  if (state.status === "error") {
    return (
      <SectionFrame
        title="API Cost & Usage"
        subtitle="What this project costs to run — our OS agents and the client's own systems."
      >
        <ComingOnline note="API cost couldn't load just now. It'll return once the data is reachable." />
      </SectionFrame>
    );
  }

  const d = state.data;
  const rangeLabel = RANGE_LABEL[range];
  const hasAny = d.totalPence > 0 || d.osRuns > 0 || d.emittedRuns > 0;

  const osSeries = d.series.map((p) => ({ periodStart: p.periodStart, value: p.osPence }));
  const emittedSeries = d.series.map((p) => ({
    periodStart: p.periodStart,
    value: p.emittedPence,
  }));
  const totalSpark = d.series.map((p) => p.osPence + p.emittedPence);

  return (
    <SectionFrame
      title="API Cost & Usage"
      subtitle="Two cost streams, kept separate: OS agents we run for the client, and the client's own system spend they report to us. Efficiency ratios divide total spend by outcomes."
    >
      {!hasAny ? (
        <ComingOnline note="No API cost has landed for this project in this window yet. OS agent-run cost fills in automatically; client-emitted cost appears once their systems send agent.run.completed events with data.provider + data.cost_pence." />
      ) : (
        <div style={{ display: "grid", gap: 16 }}>
          {/* headline — total then the two clearly-labelled streams */}
          <StatGrid>
            <StatTile
              label={`Total spend · ${rangeLabel}`}
              value={formatPence(d.totalPence)}
              sub="OS + client-emitted"
              sparkline={totalSpark}
              sparkColor={COLORS.blue}
              size="lg"
            />
            <StatTile
              label="OS cost"
              value={formatPence(d.osPence)}
              sub={`${d.osRuns.toLocaleString("en-GB")} run${d.osRuns === 1 ? "" : "s"} · we run these`}
              sparkline={osSeries.map((p) => p.value)}
              sparkColor={COLORS.teal}
            />
            <StatTile
              label="Client-emitted cost"
              value={formatPence(d.emittedPence)}
              sub={`${d.emittedRuns.toLocaleString("en-GB")} run${d.emittedRuns === 1 ? "" : "s"} · their own systems`}
              sparkline={emittedSeries.map((p) => p.value)}
              sparkColor={COLORS.violet}
            />
            <StatTile
              label="Cost / conversation"
              value={
                d.costPerConversationPence !== null
                  ? formatPence(d.costPerConversationPence)
                  : "—"
              }
              goodDirection="down"
              sub={`${d.conversations.toLocaleString("en-GB")} conversation${d.conversations === 1 ? "" : "s"}`}
            />
            <StatTile
              label="Cost / resolution"
              value={
                d.costPerResolutionPence !== null
                  ? formatPence(d.costPerResolutionPence)
                  : "—"
              }
              goodDirection="down"
              sub={`${d.resolutions.toLocaleString("en-GB")} resolved`}
            />
            <StatTile
              label="Cost / outcome"
              value={
                d.costPerOutcomePence !== null
                  ? formatPence(d.costPerOutcomePence)
                  : "—"
              }
              goodDirection="down"
              sub={`${d.outcomes.toLocaleString("en-GB")} attributed`}
            />
            <StatTile
              label="OS tokens"
              value={fmtTokens(d.osTokensIn + d.osTokensOut)}
              sub={`${fmtTokens(d.osTokensIn)} in · ${fmtTokens(d.osTokensOut)} out`}
            />
            <StatTile
              label="Client-emitted tokens"
              value={fmtTokens(d.emittedTokensIn + d.emittedTokensOut)}
              sub={`${fmtTokens(d.emittedTokensIn)} in · ${fmtTokens(d.emittedTokensOut)} out`}
            />
          </StatGrid>

          {/* Spend over time — both streams, lines behind an expand. */}
          <div className="card" style={{ padding: 18, display: "grid", gap: 12 }}>
            <div>
              <span style={{ fontSize: 14, fontWeight: 620 }}>Spend over time</span>
              <span className="faint" style={{ fontSize: 12, marginLeft: 8 }}>
                per day · {rangeLabel}
              </span>
            </div>
            <ExpandableChart label="OS cost trend">
              <LineChart points={osSeries} color={COLORS.teal} unit="pence" period={range} />
            </ExpandableChart>
            <ExpandableChart label="client-emitted trend">
              <LineChart points={emittedSeries} color={COLORS.violet} unit="pence" period={range} />
            </ExpandableChart>
          </div>

          {/* By stream: providers (client-emitted) + agents (OS) side by side. */}
          <div
            style={{
              display: "grid",
              gap: 16,
              gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
            }}
          >
            <div className="card" style={{ padding: 18, display: "grid", gap: 12 }}>
              <div>
                <span style={{ fontSize: 14, fontWeight: 620 }}>Client-emitted by provider</span>
                <span className="faint" style={{ fontSize: 12, marginLeft: 8 }}>
                  their own key spend
                </span>
              </div>
              <Leaderboard
                rows={d.byProvider.map((p) => ({
                  label: p.label,
                  value: p.pence,
                  sub: `${p.runs.toLocaleString("en-GB")} run${p.runs === 1 ? "" : "s"}`,
                }))}
                formatValue={(v) => formatPence(v)}
                emptyLabel="No client-emitted cost in this window. Send agent.run.completed with data.provider + data.cost_pence to populate this."
              />
            </div>

            <div className="card" style={{ padding: 18, display: "grid", gap: 12 }}>
              <div>
                <span style={{ fontSize: 14, fontWeight: 620 }}>OS cost by agent</span>
                <span className="faint" style={{ fontSize: 12, marginLeft: 8 }}>
                  what we ran
                </span>
              </div>
              <Leaderboard
                rows={d.byAgent.map((a) => ({
                  label: a.label,
                  value: a.pence,
                  sub: `${a.runs.toLocaleString("en-GB")} run${a.runs === 1 ? "" : "s"}`,
                }))}
                formatValue={(v) => formatPence(v)}
                emptyLabel="No OS agent runs for this project in this window yet."
              />
            </div>
          </div>

          {/* Top costly runs — leaderboard across both streams. */}
          <div className="card" style={{ padding: 18, display: "grid", gap: 12 }}>
            <div>
              <span style={{ fontSize: 14, fontWeight: 620 }}>Top costly runs</span>
              <span className="faint" style={{ fontSize: 12, marginLeft: 8 }}>
                biggest single runs across both streams
              </span>
            </div>
            <Leaderboard
              rows={d.topRuns.map((run) => ({
                label: run.label,
                value: run.pence,
                sub: run.stream === "os" ? "OS" : run.provider ?? "client",
              }))}
              formatValue={(v) => formatPence(v)}
              emptyLabel="No costed runs to rank in this window yet."
            />
          </div>
        </div>
      )}
    </SectionFrame>
  );
}
