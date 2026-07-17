"use client";

import { useEffect, useState } from "react";
import { COLORS, humanize } from "./ui";
import { StatGrid } from "./analytics/StatGrid";
import { StatTile } from "./analytics/StatTile";
import type { ApiErrorShape } from "./metrics-types";
import type { GoalPacingResult } from "../lib/server/pacing";

type State =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; goals: GoalPacingResult[] };

const PERIOD_LABEL: Record<GoalPacingResult["period"], string> = {
  day: "today",
  week: "this week",
  month: "this month",
};

/** Compact number formatter for pacing tile bodies — no long decimal tails. */
function paceNum(n: number): string {
  return n.toLocaleString("en-GB", { maximumFractionDigits: 1 });
}

/**
 * P9-PACK1 — goal pacing card for the project Overview (additive, sits
 * alongside GoalsList/ApiCostsCard). Numbers-first: one dense StatTile per
 * goal — pace % vs a good-direction-aware delta chip, actual/target to date
 * as the sub-line. No chart: pacing is a single number by design.
 */
export function GoalPacingCard({ projectId }: { projectId: string }) {
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    let alive = true;
    setState({ status: "loading" });
    fetch(`/api/projects/${projectId}/pacing`, { cache: "no-store" })
      .then(async (res) => {
        const json = (await res.json()) as
          | { goals: GoalPacingResult[] }
          | ApiErrorShape;
        if (!alive) return;
        if (!res.ok || "error" in json) {
          setState({ status: "error" });
          return;
        }
        setState({ status: "ready", goals: json.goals });
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
      <section className="card" style={{ padding: 0 }}>
        <div style={{ padding: "14px 18px 4px" }}>
          <h3 style={{ fontSize: 14 }}>Goal pacing</h3>
        </div>
        <div style={{ padding: 18, display: "grid", gap: 8 }}>
          <div className="skeleton" style={{ height: 62 }} />
        </div>
      </section>
    );
  }

  if (state.status === "error") {
    return (
      <section className="card" style={{ padding: 0 }}>
        <div style={{ padding: "14px 18px 4px" }}>
          <h3 style={{ fontSize: 14 }}>Goal pacing</h3>
        </div>
        <div className="empty" style={{ padding: "30px 24px" }}>
          <span className="empty-title">Pacing unavailable</span>
          <span style={{ fontSize: 13 }}>It&rsquo;ll reappear on the next refresh.</span>
        </div>
      </section>
    );
  }

  const { goals } = state;
  if (goals.length === 0) {
    return (
      <section className="card" style={{ padding: 0 }}>
        <div style={{ padding: "14px 18px 4px" }}>
          <h3 style={{ fontSize: 14 }}>Goal pacing</h3>
        </div>
        <div className="empty" style={{ padding: "30px 24px" }}>
          <span className="empty-title">No goals set</span>
          <span style={{ fontSize: 13 }}>
            On/off-pace tracking appears here once this project has goals.
          </span>
        </div>
      </section>
    );
  }

  return (
    <section className="card" style={{ padding: 0 }}>
      <div style={{ padding: "14px 18px 4px" }}>
        <h3 style={{ fontSize: 14 }}>Goal pacing</h3>
      </div>
      <div style={{ padding: 14 }}>
        <StatGrid minTileWidth={160}>
          {goals.map((g) => {
            const pctText = g.pacePct === null ? "—" : `${Math.round(g.pacePct)}%`;
            const tone = g.pacePct === null ? undefined : g.onPace ? COLORS.green : COLORS.red;
            return (
              <StatTile
                key={`${g.metric}-${g.period}`}
                label={`${humanize(g.metric)} · ${PERIOD_LABEL[g.period]}`}
                value={pctText}
                tone={tone}
                delta={g.pacePct === null ? null : g.onPace ? 1 : -1}
                deltaLabel={
                  g.pacePct === null ? "period just started" : g.onPace ? "on pace" : "behind pace"
                }
                sub={`${paceNum(g.actualToDate)} / ${paceNum(g.target)} to date`}
              />
            );
          })}
        </StatGrid>
      </div>
    </section>
  );
}
