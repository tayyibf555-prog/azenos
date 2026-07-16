"use client";

import type { ReactNode } from "react";
import { formatPence, relativeTime } from "../../../lib/format";
import { COLORS, tint } from "../../ui";
import { HBars, LineChart } from "../charts";
import type { AgentDevResponse, AnalyticsRange, LabelledValue, SeriesPoint } from "../types";
import { StatGrid } from "../StatGrid";
import { StatTile } from "../StatTile";
import { ExpandableChart } from "../ExpandableChart";
import { SectionFrame, SectionSkeleton, useSectionData } from "./_shell";

/**
 * Agent & Dev — the developer / operational read on the project's agents.
 * Consumes the superset the endpoint returns (kept in lock-step with
 * app/api/projects/[projectId]/analytics/agent-dev/route.ts). Every panel
 * degrades to a calm zero/empty state, never a crash.
 */

interface AgentLeaderRow {
  agentId: string;
  name: string;
  runs: number;
  completed: number;
  failed: number;
  successRate: number | null;
  escalations: number;
  avgLatencyMs: number | null;
  p95LatencyMs: number | null;
  tokensIn: number;
  tokensOut: number;
  costPence: number;
  feedbackAvg: number | null;
  feedbackCount: number;
}

interface ComponentIssueRow {
  component: string;
  errors: number;
  warnings: number;
}

interface OsAgentRow {
  agent: string;
  runs: number;
  succeeded: number;
  failed: number;
  successRate: number | null;
  avgLatencyMs: number | null;
  p95LatencyMs: number | null;
  tokensIn: number;
  tokensOut: number;
  costPence: number;
}

interface HeartbeatSummary {
  total: number;
  agentsReporting: number;
  okCount: number;
  degradedCount: number;
  downCount: number;
  maxGapMinutes: number | null;
  lastSeen: string | null;
}

interface AgentDevData extends AgentDevResponse {
  totalCompleted: number;
  totalFailed: number;
  totalEscalations: number;
  errorRate: number | null;
  longestFailureStreak: number;
  avgLatencyMs: number | null;
  p95LatencyMs: number | null;
  tokensIn: number;
  tokensOut: number;
  costPence: number;
  feedbackAvg: number | null;
  feedbackCount: number;
  agents: AgentLeaderRow[];
  throughput: SeriesPoint[];
  systemErrors: number;
  systemWarnings: number;
  issuesByComponent: ComponentIssueRow[];
  errorsBySeverity: LabelledValue[];
  integrationDisconnects: LabelledValue[];
  integrationDisconnectTotal: number;
  heartbeat: HeartbeatSummary;
  osAgents: OsAgentRow[];
  osTotalRuns: number;
  osCostPence: number;
}

// ── formatters ────────────────────────────────────────────────────────────────

const int = (n: number): string => n.toLocaleString("en-GB");

function pct(x: number | null): string {
  return x === null ? "—" : `${Math.round(x * 100)}%`;
}

function ms(x: number | null): string {
  if (x === null) return "—";
  if (x < 1000) return `${Math.round(x)}ms`;
  const s = x / 1000;
  return `${s.toFixed(s < 10 ? 2 : 1)}s`;
}

function tokensCompact(n: number): string {
  if (n < 1000) return int(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function rating(avg: number | null, count: number): string {
  if (avg === null || count === 0) return "—";
  return `${avg.toFixed(1)} ★`;
}

const SEVERITY_COLOR: Record<string, string> = {
  critical: COLORS.red,
  error: COLORS.red,
  warning: COLORS.amber,
  info: COLORS.blue,
  unspecified: COLORS.grey,
};

// ── small presentational helpers ──────────────────────────────────────────────

function Card({
  title,
  hint,
  children,
  strong = false,
}: {
  title?: string;
  hint?: string;
  children: ReactNode;
  strong?: boolean;
}) {
  return (
    <div
      className={strong ? "glass-strong" : "card"}
      style={{ padding: 18, display: "grid", gap: 14 }}
    >
      {(title || hint) && (
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
          {title && <h3 style={{ fontSize: 13.5, fontWeight: 620, letterSpacing: 0.1 }}>{title}</h3>}
          {hint && <span className="faint" style={{ fontSize: 11.5 }}>{hint}</span>}
        </div>
      )}
      {children}
    </div>
  );
}

function Pill({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "3px 9px",
        borderRadius: 999,
        fontSize: 11.5,
        background: tint(color, 0.12),
        border: `1px solid ${tint(color, 0.28)}`,
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: 3, background: color }} />
      <span className="muted">{label}</span>
      <span className="tnum" style={{ fontWeight: 620 }}>{int(value)}</span>
    </span>
  );
}

// ── generic agent table (client agents + OS agents) ───────────────────────────

interface Column<T> {
  head: string;
  align?: "left" | "right";
  render: (row: T) => ReactNode;
}

function DataTable<T>({
  rows,
  columns,
  keyOf,
  emptyLabel,
}: {
  rows: T[];
  columns: Column<T>[];
  keyOf: (row: T) => string;
  emptyLabel: string;
}) {
  if (rows.length === 0) {
    return (
      <div className="faint" style={{ fontSize: 12.5, padding: "18px 0", textAlign: "center" }}>
        {emptyLabel}
      </div>
    );
  }
  return (
    <div style={{ overflowX: "auto", maxWidth: "100%" }}>
      <table style={{ width: "100%", minWidth: 560, borderCollapse: "collapse", fontSize: 12.5 }}>
        <thead>
          <tr>
            {columns.map((c, i) => (
              <th
                key={c.head}
                className="faint"
                style={{
                  textAlign: c.align ?? (i === 0 ? "left" : "right"),
                  fontWeight: 550,
                  fontSize: 11,
                  padding: "0 10px 8px",
                  whiteSpace: "nowrap",
                }}
              >
                {c.head}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={keyOf(row)} style={{ borderTop: "1px solid var(--border)" }}>
              {columns.map((c, i) => (
                <td
                  key={c.head}
                  className={i === 0 ? undefined : "tnum"}
                  style={{
                    textAlign: c.align ?? (i === 0 ? "left" : "right"),
                    padding: "9px 10px",
                    whiteSpace: "nowrap",
                    borderTop: "1px solid var(--border)",
                  }}
                >
                  {c.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── section ───────────────────────────────────────────────────────────────────

export function AgentDevSection({
  projectId,
  range,
}: {
  projectId: string;
  range: AnalyticsRange;
}) {
  const state = useSectionData<AgentDevData>("agent-dev", projectId, range);

  if (state.status === "loading") {
    return (
      <SectionFrame title="Agent & Dev" subtitle="Agent-run reliability, latency, and cost.">
        <SectionSkeleton />
      </SectionFrame>
    );
  }
  if (state.status === "error") {
    return (
      <SectionFrame title="Agent & Dev" subtitle="Agent-run reliability, latency, and cost.">
        <Card>
          <div className="faint" style={{ fontSize: 12.5, textAlign: "center", padding: "14px 0" }}>
            Couldn&apos;t load agent metrics for this window.
          </div>
        </Card>
      </SectionFrame>
    );
  }

  const d = state.data;
  const trend = d.throughput.map((p) => p.value);
  const successTone =
    d.successRate === null ? undefined : d.successRate >= 0.9 ? COLORS.green : d.successRate >= 0.7 ? COLORS.amber : COLORS.red;
  const errorTone =
    d.errorRate === null || d.errorRate === 0 ? undefined : d.errorRate >= 0.1 ? COLORS.red : COLORS.amber;
  const hb = d.heartbeat;
  const nothingYet =
    d.totalRuns === 0 &&
    hb.total === 0 &&
    d.systemErrors === 0 &&
    d.systemWarnings === 0 &&
    d.integrationDisconnectTotal === 0 &&
    d.osTotalRuns === 0;

  const chartPoints = d.throughput.map((p) => ({ periodStart: p.periodStart, value: p.value }));

  return (
    <SectionFrame title="Agent & Dev" subtitle="Agent-run reliability, latency, cost, and system health.">
      {nothingYet && (
        <div className="faint" style={{ fontSize: 12.5, marginTop: -4 }}>
          No agent telemetry in this window yet — panels below fill in as
          <span className="mono"> agent.* </span>, <span className="mono">system.*</span> and heartbeat events arrive.
        </div>
      )}

      {/* the numbers — every headline aggregate the endpoint computes */}
      <StatGrid minTileWidth={128}>
        <StatTile
          label="Agent runs"
          value={int(d.totalRuns)}
          sub={`${int(d.totalCompleted)} completed · ${int(d.totalFailed)} failed`}
          sparkline={trend}
          size="lg"
        />
        <StatTile label="Success rate" value={pct(d.successRate)} tone={successTone} sub={`${int(d.totalEscalations)} escalations`} />
        <StatTile label="Error rate" value={pct(d.errorRate)} tone={errorTone} sub={`streak ${int(d.longestFailureStreak)}`} />
        <StatTile label="Avg latency" value={ms(d.avgLatencyMs)} sub="per run" />
        <StatTile label="p95 latency" value={ms(d.p95LatencyMs)} sub="per run" />
        <StatTile label="Cost" value={formatPence(d.costPence)} sub="run cost" />
        <StatTile
          label="Tokens"
          value={tokensCompact(d.tokensIn + d.tokensOut)}
          sub={`${tokensCompact(d.tokensIn)} in · ${tokensCompact(d.tokensOut)} out`}
        />
        <StatTile
          label="Feedback"
          value={rating(d.feedbackAvg, d.feedbackCount)}
          sub={d.feedbackCount > 0 ? `${int(d.feedbackCount)} ratings` : "no ratings"}
        />
        <StatTile
          label="Escalations"
          value={int(d.totalEscalations)}
          tone={d.totalEscalations > 0 ? COLORS.amber : undefined}
          sub="to human"
        />
      </StatGrid>

      {/* throughput — numbers already above; line behind an expand */}
      <Card title="Throughput" hint={`runs / day · ${range}`}>
        <ExpandableChart label="daily trend">
          <LineChart points={chartPoints} color={COLORS.teal} unit="count" period={range} />
        </ExpandableChart>
      </Card>

      {/* per-agent leaderboard */}
      <Card title="Per-agent leaderboard" hint={`${int(d.agents.length)} agents`}>
        <DataTable<AgentLeaderRow>
          rows={d.agents}
          keyOf={(a) => a.agentId}
          emptyLabel="No agent runs in this window yet."
          columns={[
            { head: "Agent", render: (a) => <span style={{ fontWeight: 560 }} title={a.agentId}>{a.name}</span> },
            { head: "Runs", render: (a) => int(a.runs) },
            {
              head: "Success",
              render: (a) => (
                <span style={{ color: a.successRate === null ? undefined : a.successRate >= 0.9 ? COLORS.green : a.successRate >= 0.7 ? COLORS.amber : COLORS.red }}>
                  {pct(a.successRate)}
                </span>
              ),
            },
            { head: "Failed", render: (a) => <span style={{ color: a.failed > 0 ? COLORS.red : undefined }}>{int(a.failed)}</span> },
            { head: "Escal.", render: (a) => <span style={{ color: a.escalations > 0 ? COLORS.amber : undefined }}>{int(a.escalations)}</span> },
            { head: "Avg", render: (a) => ms(a.avgLatencyMs) },
            { head: "p95", render: (a) => ms(a.p95LatencyMs) },
            { head: "Tokens", render: (a) => tokensCompact(a.tokensIn + a.tokensOut) },
            { head: "Cost", render: (a) => formatPence(a.costPence) },
            { head: "Rating", render: (a) => rating(a.feedbackAvg, a.feedbackCount) },
          ]}
        />
      </Card>

      {/* system health + heartbeat */}
      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))" }}>
        <Card title="Errors by component" hint={`${int(d.systemErrors)} errors · ${int(d.systemWarnings)} warnings`}>
          <HBars
            items={d.issuesByComponent.map((c) => ({
              label: c.component,
              value: c.errors + c.warnings,
              color: c.errors > 0 ? COLORS.red : COLORS.amber,
            }))}
            emptyLabel="No system errors or warnings in this window."
            labelWidth={130}
          />
          {d.errorsBySeverity.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, paddingTop: 2 }}>
              {d.errorsBySeverity.map((s) => (
                <Pill key={s.label} label={s.label} value={s.value} color={SEVERITY_COLOR[s.label] ?? COLORS.grey} />
              ))}
            </div>
          )}
        </Card>

        <Card title="Heartbeat & uptime" hint={hb.lastSeen ? `last seen ${relativeTime(hb.lastSeen)}` : "no heartbeats"}>
          <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(96px, 1fr))" }}>
            <StatTile label="Heartbeats" value={int(hb.total)} sub={`${int(hb.agentsReporting)} agents`} />
            <StatTile
              label="Max gap"
              value={hb.maxGapMinutes === null ? "—" : hb.maxGapMinutes < 60 ? `${Math.round(hb.maxGapMinutes)}m` : `${(hb.maxGapMinutes / 60).toFixed(1)}h`}
              tone={hb.maxGapMinutes !== null && hb.maxGapMinutes >= 60 ? COLORS.amber : undefined}
              sub="between beats"
            />
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            <Pill label="ok" value={hb.okCount} color={COLORS.green} />
            <Pill label="degraded" value={hb.degradedCount} color={COLORS.amber} />
            <Pill label="down" value={hb.downCount} color={COLORS.red} />
          </div>
          {(d.integrationDisconnectTotal > 0 || d.integrationDisconnects.length > 0) && (
            <div style={{ display: "grid", gap: 8, paddingTop: 2 }}>
              <span className="faint" style={{ fontSize: 11 }}>
                Integration disconnects · {int(d.integrationDisconnectTotal)}
              </span>
              <HBars
                items={d.integrationDisconnects.map((i) => ({ label: i.label, value: i.value, color: COLORS.red }))}
                emptyLabel="No integrations dropped in this window."
                labelWidth={110}
              />
            </div>
          )}
        </Card>
      </div>

      {/* agency's own OS agents */}
      <Card title="Azen OS agents" hint={`${int(d.osTotalRuns)} runs · ${formatPence(d.osCostPence)}`}>
        <DataTable<OsAgentRow>
          rows={d.osAgents}
          keyOf={(o) => o.agent}
          emptyLabel="No OS agent runs attributed to this project yet."
          columns={[
            { head: "OS agent", render: (o) => <span style={{ fontWeight: 560 }}>{o.agent.replace(/_/g, " ")}</span> },
            { head: "Runs", render: (o) => int(o.runs) },
            {
              head: "Success",
              render: (o) => (
                <span style={{ color: o.successRate === null ? undefined : o.successRate >= 0.9 ? COLORS.green : o.successRate >= 0.7 ? COLORS.amber : COLORS.red }}>
                  {pct(o.successRate)}
                </span>
              ),
            },
            { head: "Failed", render: (o) => <span style={{ color: o.failed > 0 ? COLORS.red : undefined }}>{int(o.failed)}</span> },
            { head: "Avg", render: (o) => ms(o.avgLatencyMs) },
            { head: "p95", render: (o) => ms(o.p95LatencyMs) },
            { head: "Tokens", render: (o) => tokensCompact(o.tokensIn + o.tokensOut) },
            { head: "Cost", render: (o) => formatPence(o.costPence) },
          ]}
        />
      </Card>
    </SectionFrame>
  );
}
