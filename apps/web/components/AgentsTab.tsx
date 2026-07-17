"use client";

import { useEffect, useState } from "react";
import { RelativeTime } from "./RelativeTime";
import { COLORS, tint } from "./ui";
import { formatPence } from "../lib/format";

/**
 * Agents tab (docs/phase5/CONTRACTS.md §P5-AGENTS-TAB). Pure read view over
 * `GET /api/projects/[id]/agents` — a card per registered agent (from
 * heartbeats) with its status dot, run count, success rate, tokens/cost,
 * minutes saved and per-agent ROI. Fetches defensively: any error or empty set
 * degrades to a friendly empty state, never a crash.
 */

interface AgentRoi {
  minutesSaved: number;
  timeValuePence: number;
  costPence: number;
  roiMultiple: number | null;
  note: string;
}

interface AgentSummary {
  agentId: string;
  name: string | null;
  version: string | null;
  status: string;
  lastHeartbeatAt: string;
  runs: number;
  successRate: number | null;
  avgDurationMs: number | null;
  tokensTotal: number;
  costPence: number;
  minutesSaved: number;
  escalations: number;
  perAgentRoi: AgentRoi;
}

interface AgentsResponse {
  from: string;
  to: string;
  hourlyRatePence: number;
  agents: AgentSummary[];
}

type State =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; data: AgentsResponse };

const STATUS_COLOR: Record<string, string> = {
  ok: COLORS.green,
  degraded: COLORS.amber,
  down: COLORS.red,
};

function statusColor(status: string): string {
  return STATUS_COLOR[status] ?? COLORS.grey;
}

function compactNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}k`;
  return n.toLocaleString("en-GB");
}

function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
}

function formatMinutes(mins: number): string {
  if (mins <= 0) return "0m";
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

export function AgentsTab({ projectId }: { projectId: string }) {
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    let alive = true;
    setState({ status: "loading" });
    fetch(`/api/projects/${projectId}/agents`, { cache: "no-store" })
      .then(async (res) => {
        const json = (await res.json()) as AgentsResponse | { error: string };
        if (!alive) return;
        if (!res.ok || "error" in json) {
          setState({ status: "error" });
          return;
        }
        setState({ status: "ready", data: json });
      })
      .catch(() => {
        if (alive) setState({ status: "error" });
      });
    return () => {
      alive = false;
    };
  }, [projectId]);

  if (state.status === "loading") {
    return (
      <div style={{ display: "grid", gap: 14 }}>
        <div className="skeleton" style={{ height: 120 }} />
        <div className="skeleton" style={{ height: 120 }} />
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="card empty">
        <span className="empty-title">Couldn&apos;t load agents</span>
        <span style={{ fontSize: 13 }}>
          The event stream may still be catching up for this project.
        </span>
      </div>
    );
  }

  const { agents } = state.data;

  if (agents.length === 0) {
    return (
      <div className="card empty">
        <span className="empty-title">No agents reporting yet</span>
        <span style={{ fontSize: 13 }}>
          Agents appear here once they send an{" "}
          <code className="mono">agent.heartbeat</code> event. Run metrics and
          ROI fill in from <code className="mono">agent.run.completed</code>.
        </span>
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div className="faint" style={{ fontSize: 12 }}>
        {agents.length} agent{agents.length === 1 ? "" : "s"} · window{" "}
        {state.data.from} → {state.data.to}
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))",
          gap: 14,
        }}
      >
        {agents.map((a) => (
          <AgentCard key={a.agentId} agent={a} />
        ))}
      </div>
    </div>
  );
}

function AgentCard({ agent }: { agent: AgentSummary }) {
  const color = statusColor(agent.status);
  const successPct =
    agent.successRate === null ? null : Math.round(agent.successRate * 100);

  return (
    <section className="card" style={{ padding: 16, display: "grid", gap: 14 }}>
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 10,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span
              className="dot"
              title={agent.status}
              style={{ background: color, width: 9, height: 9, flex: "none" }}
            />
            <span
              style={{
                fontSize: 14.5,
                fontWeight: 650,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              title={agent.name ?? agent.agentId}
            >
              {agent.name ?? agent.agentId}
            </span>
          </div>
          <div className="faint mono" style={{ fontSize: 11, marginTop: 4 }}>
            {agent.agentId}
            {agent.version ? ` · v${agent.version}` : ""}
          </div>
        </div>
        <span
          className="badge"
          style={{
            color,
            background: tint(color, 0.13),
            flex: "none",
          }}
        >
          {agent.status}
        </span>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: 12,
        }}
      >
        <Stat label="Runs" value={compactNumber(agent.runs)} />
        <Stat
          label="Success"
          value={successPct === null ? "—" : `${successPct}%`}
          tone={
            successPct === null
              ? undefined
              : successPct >= 90
                ? COLORS.green
                : successPct >= 70
                  ? COLORS.amber
                  : COLORS.red
          }
        />
        <Stat label="Avg run" value={formatDuration(agent.avgDurationMs)} />
        <Stat label="Tokens" value={compactNumber(agent.tokensTotal)} />
        <Stat label="Cost" value={formatPence(agent.costPence)} />
        <Stat
          label="Escalations"
          value={agent.escalations.toLocaleString("en-GB")}
          tone={agent.escalations > 0 ? COLORS.amber : undefined}
        />
      </div>

      <div
        style={{
          paddingTop: 12,
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 10,
        }}
      >
        <div>
          <div className="faint" style={{ fontSize: 11 }}>
            Time saved
          </div>
          <div style={{ fontSize: 15, fontWeight: 600, marginTop: 2 }}>
            {formatMinutes(agent.minutesSaved)}
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div className="faint" style={{ fontSize: 11 }}>
            ROI
          </div>
          <div
            style={{
              fontSize: 15,
              fontWeight: 600,
              marginTop: 2,
              color:
                agent.perAgentRoi.roiMultiple !== null &&
                agent.perAgentRoi.roiMultiple >= 1
                  ? COLORS.green
                  : "var(--text)",
            }}
          >
            {agent.perAgentRoi.roiMultiple === null
              ? "—"
              : `${agent.perAgentRoi.roiMultiple}×`}
          </div>
        </div>
      </div>
      <div className="faint" style={{ fontSize: 11.5, lineHeight: 1.4 }}>
        {agent.perAgentRoi.note}
      </div>

      <div className="faint" style={{ fontSize: 11 }}>
        Last heartbeat <RelativeTime value={agent.lastHeartbeatAt} />
      </div>
    </section>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: string;
}) {
  return (
    <div>
      <div className="faint" style={{ fontSize: 10.5 }}>
        {label}
      </div>
      <div
        className="mono"
        style={{ fontSize: 14, fontWeight: 550, marginTop: 3, color: tone }}
      >
        {value}
      </div>
    </div>
  );
}
