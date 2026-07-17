"use client";

import { useEffect, useState } from "react";
import { COLORS, humanize } from "./ui";
import { formatMetricValue, rangeToDates } from "./charts/util";
import type {
  ApiErrorShape,
  MetricUnit,
  RollupPeriod,
  SeriesResponse,
} from "./metrics-types";

interface Goal {
  metric: string;
  target: number;
  period: "day" | "week" | "month";
}

interface Actual {
  value: number;
  unit: MetricUnit;
}

const PERIOD_LABEL: Record<Goal["period"], string> = {
  day: "today",
  week: "this week",
  month: "this month",
};

const PERIOD_WINDOW_DAYS: Record<Goal["period"], number> = {
  day: 2,
  week: 21,
  month: 100,
};

/**
 * Goals vs actuals (§Metrics UI Overview upgrade). Each goal's current-period
 * actual is read from the series API at the goal's own period granularity — the
 * rollup already aggregates per bucket, so the latest bucket IS the current
 * period-to-date value. Batched one fetch per distinct period.
 */
export function GoalsList({
  projectId,
  goals,
}: {
  projectId: string;
  goals: Goal[];
}) {
  const [actuals, setActuals] = useState<Record<string, Actual>>({});

  useEffect(() => {
    if (goals.length === 0) return;
    let alive = true;
    const periods = Array.from(new Set(goals.map((g) => g.period)));

    Promise.all(
      periods.map(async (period) => {
        const keys = Array.from(
          new Set(goals.filter((g) => g.period === period).map((g) => g.metric)),
        );
        if (keys.length === 0) return;
        const { from, to } = rangeToDates(PERIOD_WINDOW_DAYS[period]);
        const params = new URLSearchParams({
          keys: keys.join(","),
          period: period as RollupPeriod,
          from,
          to,
          compare: "none",
        });
        try {
          const res = await fetch(
            `/api/projects/${projectId}/metrics/series?${params.toString()}`,
            { cache: "no-store" },
          );
          const json = (await res.json()) as SeriesResponse | ApiErrorShape;
          if (!alive || !res.ok || "error" in json) return;
          const next: Record<string, Actual> = {};
          for (const key of keys) {
            const points = json.series?.[key] ?? [];
            const last = points.length > 0 ? points[points.length - 1] : null;
            next[key] = {
              value: last ? last.value : 0,
              unit: json.meta?.[key]?.unit ?? "count",
            };
          }
          if (alive) setActuals((prev) => ({ ...prev, ...next }));
        } catch {
          /* leave goals showing 0 / pending on failure */
        }
      }),
    ).catch(() => {
      /* handled per-period above */
    });

    return () => {
      alive = false;
    };
  }, [projectId, goals]);

  if (goals.length === 0) {
    return (
      <section className="card" style={{ padding: 0 }}>
        <div style={{ padding: "14px 18px 4px" }}>
          <h3 style={{ fontSize: 14 }}>Goals</h3>
        </div>
        <div className="empty" style={{ padding: "30px 24px" }}>
          <span className="empty-title">No goals set</span>
          <span style={{ fontSize: 13 }}>
            Goals captured at project intake show progress against target here.
          </span>
        </div>
      </section>
    );
  }

  return (
    <section className="card" style={{ padding: 0 }}>
      <div style={{ padding: "14px 18px 4px" }}>
        <h3 style={{ fontSize: 14 }}>Goals vs actuals</h3>
      </div>
      <div style={{ display: "grid", gap: 0 }}>
        {goals.map((goal, i) => {
          const actual = actuals[goal.metric];
          const unit = actual?.unit ?? "count";
          const value = actual?.value ?? 0;
          const pct =
            goal.target > 0
              ? Math.max(0, Math.min(100, (value / goal.target) * 100))
              : 0;
          const hit = goal.target > 0 && value >= goal.target;
          const barColor = hit ? COLORS.green : COLORS.blue;
          return (
            <div
              key={`${goal.metric}-${goal.period}-${i}`}
              style={{
                padding: "13px 18px",
                display: "grid",
                gap: 7,
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  justifyContent: "space-between",
                  gap: 10,
                }}
              >
                <span style={{ fontSize: 13, fontWeight: 550 }}>
                  {humanize(goal.metric)}
                  <span className="faint" style={{ fontWeight: 400 }}>
                    {" "}
                    · {PERIOD_LABEL[goal.period]}
                  </span>
                </span>
                <span style={{ fontSize: 12.5 }}>
                  <span style={{ fontWeight: 600, color: hit ? COLORS.green : "var(--text)" }}>
                    {formatMetricValue(value, unit)}
                  </span>
                  <span className="faint">
                    {" "}
                    / {formatMetricValue(goal.target, unit)}
                  </span>
                </span>
              </div>
              <div
                style={{
                  height: 7,
                  borderRadius: "var(--radius-pill)",
                  background: "var(--card-2)",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    width: `${pct}%`,
                    height: "100%",
                    background: barColor,
                    opacity: 0.85,
                    transition: "width 0.3s ease",
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
