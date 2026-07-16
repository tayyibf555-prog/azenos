"use client";

import { useEffect, useState } from "react";
import { formatPence } from "../lib/format";
import { COLORS, tint } from "./ui";
import { currentLondonMonth } from "./charts/util";
import type { ApiErrorShape, ProjectCostsResponse } from "./metrics-types";

type State =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; costs: ProjectCostsResponse };

/**
 * ADDENDUM §B — API-costs card (project Overview). Surfaces the two per-project
 * cost streams (client-system AI spend already rolled up from
 * agent.run.completed, plus OS-side agent_runs spend) and their total, framed
 * as the source of truth for what's billable to the client. Defensive on empty.
 */
export function ApiCostsCard({
  projectId,
  month = currentLondonMonth(),
}: {
  projectId: string;
  month?: string;
}) {
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    let alive = true;
    setState({ status: "loading" });
    fetch(`/api/projects/${projectId}/costs?month=${month}`, {
      cache: "no-store",
    })
      .then(async (res) => {
        const json = (await res.json()) as ProjectCostsResponse | ApiErrorShape;
        if (!alive) return;
        if (!res.ok || "error" in json) {
          setState({ status: "error" });
          return;
        }
        setState({ status: "ready", costs: json });
      })
      .catch(() => {
        if (alive) setState({ status: "error" });
      });
    return () => {
      alive = false;
    };
  }, [projectId, month]);

  if (state.status === "loading") {
    return (
      <section className="card" style={{ padding: 20 }}>
        <div className="skeleton" style={{ height: 16, width: 120 }} />
        <div className="skeleton" style={{ height: 34, width: 160, marginTop: 12 }} />
      </section>
    );
  }

  if (state.status === "error") {
    return (
      <section className="card" style={{ padding: 20, borderStyle: "dashed" }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>API costs</div>
        <div className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>
          Cost tracking appears once this month&apos;s agent-cost events and OS
          runs are rolled up.
        </div>
      </section>
    );
  }

  const clientSystem = state.costs.clientSystemAiPence ?? 0;
  const osAgent = state.costs.osAgentPence ?? 0;
  const total = state.costs.totalPence ?? clientSystem + osAgent;

  return (
    <section className="card" style={{ padding: "18px 20px" }}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 600 }}>API costs this month</div>
        <span className="chip">billable to client</span>
      </div>

      <div
        style={{
          fontSize: 30,
          fontWeight: 700,
          letterSpacing: "-0.02em",
          marginTop: 10,
          color: "var(--text)",
        }}
      >
        {formatPence(total)}
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 12 }}>
        <Cell
          label="Client-system AI"
          value={formatPence(clientSystem)}
          tone={COLORS.teal}
        />
        <Cell label="OS agents" value={formatPence(osAgent)} tone={COLORS.grey} />
      </div>

      <p className="faint" style={{ fontSize: 11.5, marginTop: 10, lineHeight: 1.45 }}>
        Tracked source of truth for API spend on this project — client-system
        model spend plus Azen OS agent runs. Invoicing &amp; markup land with
        Money (Phase 4).
      </p>
    </section>
  );
}

function Cell({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div
      style={{
        background: "var(--card-2)",
        border: `1px solid ${tint(tone, 0.26)}`,
        borderRadius: "var(--radius-sm)",
        padding: "7px 11px",
        minWidth: 120,
      }}
    >
      <div className="faint" style={{ fontSize: 10.5, marginBottom: 2 }}>
        {label}
      </div>
      <div style={{ fontSize: 14, fontWeight: 600, color: tone }}>{value}</div>
    </div>
  );
}
