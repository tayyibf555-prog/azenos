"use client";

import { useEffect, useMemo, useState } from "react";
import { AddMetricModal } from "./AddMetricModal";
import { MetricDiscoveryPanel } from "./MetricDiscoveryPanel";
import { LineChart } from "./charts/LineChart";
import {
  deltaColor,
  formatDelta,
  formatMetricValue,
  londonDayKey,
  metricColor,
  rangeToDates,
  recommendedGranularity,
} from "./charts/util";
import { COLORS, tint } from "./ui";
import { StatTile } from "./analytics/StatTile";
import { ExpandableChart } from "./analytics/ExpandableChart";
import type {
  ApiErrorShape,
  MetricDefinition,
  MetricsDefinitionsResponse,
  RollupPeriod,
  SeriesResponse,
} from "./metrics-types";

type Range = "7d" | "30d" | "90d" | "custom";

interface KpiValue {
  value: number | null;
  delta: number | null;
}

const GRANULARITIES: RollupPeriod[] = ["hour", "day", "week", "month"];
const MAX_CHARTS = 4;

function windowFor(
  range: Range,
  customFrom: string,
  customTo: string,
): { from: string; to: string; days: number } {
  if (range === "custom") {
    if (customFrom && customTo) {
      const fromMs = Date.parse(`${customFrom}T00:00:00Z`);
      const toMs = Date.parse(`${customTo}T00:00:00Z`);
      const days = Math.round((toMs - fromMs) / 86_400_000) + 1;
      if (Number.isFinite(days) && days > 0) {
        return { from: customFrom, to: customTo, days };
      }
    }
    const fallback = rangeToDates(30);
    return { from: fallback.from, to: fallback.to, days: 30 };
  }
  const days = range === "7d" ? 7 : range === "30d" ? 30 : 90;
  const r = rangeToDates(days);
  return { from: r.from, to: r.to, days };
}

/** Calendar day before a "YYYY-MM-DD" London day key. */
function previousDayKey(dayKey: string): string {
  const [y, m, d] = dayKey.split("-").map(Number);
  if (!y || !m || !d) return "";
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - 1);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(
    dt.getUTCDate(),
  ).padStart(2, "0")}`;
}

/**
 * Latest complete-day value + Δ vs the previous CALENDAR day from a day series.
 * The M1 rollup engine writes no row for a zero-activity day, so adjacent array
 * elements are not necessarily adjacent days: if the calendar day immediately
 * before the latest point is missing, that day genuinely had zero activity and
 * the delta is measured against 0 (keeping the "vs prev day" label honest).
 */
function deriveKpi(points: { periodStart: string; value: number }[]): KpiValue {
  if (points.length === 0) return { value: null, delta: null };
  const today = londonDayKey(Date.now());
  const complete = points.filter((p) => londonDayKey(p.periodStart) < today);
  const src = complete.length > 0 ? complete : points;
  const last = src[src.length - 1];
  if (!last) return { value: null, delta: null };
  const prev = src.length >= 2 ? src[src.length - 2] : null;
  if (!prev) return { value: last.value, delta: null };
  const expectedPrevKey = previousDayKey(londonDayKey(last.periodStart));
  // Adjacent day present → compare to it; gap → previous day had no row (= 0).
  const prevValue =
    londonDayKey(prev.periodStart) === expectedPrevKey ? prev.value : 0;
  return { value: last.value, delta: last.value - prevValue };
}

/**
 * Metrics tab (§Metrics UI). KPI strip + configurable multi-metric line charts
 * with range / granularity / compare controls and an Add-metric flow. Every
 * fetch fails quietly to a skeleton or inline note — the tab never crashes on a
 * 404 or empty rollup set.
 */
export function MetricsTab({ projectId }: { projectId: string }) {
  const [defsState, setDefsState] = useState<
    | { status: "loading" }
    | { status: "error" }
    | { status: "ready"; definitions: MetricDefinition[] }
  >({ status: "loading" });
  const [refreshKey, setRefreshKey] = useState(0);

  const [range, setRange] = useState<Range>("30d");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [granOverride, setGranOverride] = useState<RollupPeriod | null>(null);
  const [compare, setCompare] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);

  const [kpi, setKpi] = useState<Record<string, KpiValue>>({});
  const [chartState, setChartState] = useState<
    | { status: "idle" }
    | { status: "loading" }
    | { status: "error" }
    | { status: "ready"; data: SeriesResponse }
  >({ status: "idle" });

  const [addOpen, setAddOpen] = useState(false);
  const [deleting, setDeleting] = useState<Record<string, boolean>>({});

  const win = useMemo(
    () => windowFor(range, customFrom, customTo),
    [range, customFrom, customTo],
  );
  const granularity: RollupPeriod =
    granOverride ?? recommendedGranularity(win.days);

  // ── load definitions ──
  useEffect(() => {
    let alive = true;
    setDefsState({ status: "loading" });
    fetch(`/api/projects/${projectId}/metrics`, { cache: "no-store" })
      .then(async (res) => {
        const json = (await res.json()) as
          | MetricsDefinitionsResponse
          | ApiErrorShape;
        if (!alive) return;
        if (!res.ok || "error" in json) {
          setDefsState({ status: "error" });
          return;
        }
        const definitions = json.definitions ?? [];
        setDefsState({ status: "ready", definitions });
        setSelected((prev) => {
          const valid = prev.filter((k) =>
            definitions.some((d) => d.key === k),
          );
          if (valid.length > 0) return valid;
          const firstKpi = definitions.find((d) => d.isKpi);
          const first = firstKpi ?? definitions[0];
          return first ? [first.key] : [];
        });
      })
      .catch(() => {
        if (alive) setDefsState({ status: "error" });
      });
    return () => {
      alive = false;
    };
  }, [projectId, refreshKey]);

  const definitions =
    defsState.status === "ready" ? defsState.definitions : [];
  const kpiDefs = useMemo(
    () => definitions.filter((d) => d.isKpi),
    [definitions],
  );
  const kpiKeys = useMemo(() => kpiDefs.map((d) => d.key).join(","), [kpiDefs]);

  // ── KPI strip series (day, compare=previous) ──
  useEffect(() => {
    if (!kpiKeys) {
      setKpi({});
      return;
    }
    let alive = true;
    // The series route rejects >12 keys per request, so batch the KPI keys —
    // a project can accumulate arbitrarily many isKpi defs and one oversized
    // request would 400 and blank the entire strip.
    const allKeys = kpiKeys.split(",");
    const chunks: string[][] = [];
    for (let i = 0; i < allKeys.length; i += 12) {
      chunks.push(allKeys.slice(i, i + 12));
    }
    Promise.all(
      chunks.map((chunk) => {
        const params = new URLSearchParams({
          keys: chunk.join(","),
          period: "day",
          compare: "previous",
        });
        return fetch(
          `/api/projects/${projectId}/metrics/series?${params.toString()}`,
          { cache: "no-store" },
        )
          .then(async (res) => {
            const json = (await res.json()) as SeriesResponse | ApiErrorShape;
            if (!res.ok || "error" in json) return null;
            return json;
          })
          .catch(() => null);
      }),
    )
      .then((results) => {
        if (!alive) return;
        const next: Record<string, KpiValue> = {};
        results.forEach((json, ci) => {
          for (const key of chunks[ci] ?? []) {
            next[key] = deriveKpi(json?.series?.[key] ?? []);
          }
        });
        setKpi(next);
      })
      .catch(() => {
        /* KPI strip degrades to em-dashes */
      });
    return () => {
      alive = false;
    };
  }, [projectId, kpiKeys]);

  // ── chart series ──
  const selectedKey = selected.join(",");
  useEffect(() => {
    if (!selectedKey) {
      setChartState({ status: "idle" });
      return;
    }
    let alive = true;
    setChartState({ status: "loading" });
    const params = new URLSearchParams({
      keys: selectedKey,
      period: granularity,
      from: win.from,
      to: win.to,
      compare: compare ? "previous" : "none",
    });
    fetch(
      `/api/projects/${projectId}/metrics/series?${params.toString()}`,
      { cache: "no-store" },
    )
      .then(async (res) => {
        const json = (await res.json()) as SeriesResponse | ApiErrorShape;
        if (!alive) return;
        if (!res.ok || "error" in json) {
          setChartState({ status: "error" });
          return;
        }
        setChartState({ status: "ready", data: json });
      })
      .catch(() => {
        if (alive) setChartState({ status: "error" });
      });
    return () => {
      alive = false;
    };
  }, [projectId, selectedKey, granularity, win.from, win.to, compare]);

  function toggleSelect(key: string) {
    setSelected((prev) => {
      if (prev.includes(key)) return prev.filter((k) => k !== key);
      if (prev.length >= MAX_CHARTS) return prev;
      return [...prev, key];
    });
  }

  async function remove(key: string) {
    if (deleting[key]) return;
    setDeleting((d) => ({ ...d, [key]: true }));
    try {
      const res = await fetch(`/api/projects/${projectId}/metrics/${key}`, {
        method: "DELETE",
        cache: "no-store",
      });
      if (res.ok) {
        setSelected((prev) => prev.filter((k) => k !== key));
        setRefreshKey((n) => n + 1);
      }
    } catch {
      /* leave the metric in place on failure */
    } finally {
      setDeleting((d) => {
        const next = { ...d };
        delete next[key];
        return next;
      });
    }
  }

  if (defsState.status === "loading") {
    return (
      <div style={{ display: "grid", gap: 22 }}>
        <div className="skeleton" style={{ height: 74 }} />
        <div className="skeleton" style={{ height: 260 }} />
      </div>
    );
  }
  if (defsState.status === "error") {
    return (
      <div className="card empty">
        <span className="empty-title">Couldn&apos;t load metrics</span>
        <span style={{ fontSize: 13 }}>
          The metrics engine may still be rolling up this project.
        </span>
      </div>
    );
  }

  const readyData = chartState.status === "ready" ? chartState.data : null;
  const meta = readyData?.meta ?? {};

  return (
    <div style={{ display: "grid", gap: 22 }}>
      {/* ── KPI strip ── */}
      {kpiDefs.length > 0 && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
            gap: 14,
          }}
        >
          {kpiDefs.map((def) => {
            const kv = kpi[def.key] ?? { value: null, delta: null };
            return (
              <div className="card" key={def.key} style={{ padding: "14px 16px" }}>
                <div className="faint" style={{ fontSize: 11.5 }}>
                  {def.name}
                </div>
                <div
                  style={{
                    fontSize: 24,
                    fontWeight: 660,
                    letterSpacing: "-0.02em",
                    marginTop: 6,
                  }}
                >
                  {formatMetricValue(kv.value ?? undefined, def.unit)}
                </div>
                {kv.delta !== null && (
                  <div
                    style={{
                      fontSize: 12,
                      marginTop: 4,
                      color: deltaColor(kv.delta, def.goodDirection),
                    }}
                  >
                    {formatDelta(kv.delta, def.unit)}{" "}
                    <span className="faint">vs prev day</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ── controls ── */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 10,
        }}
      >
        <div
          className="card"
          style={{
            display: "inline-flex",
            padding: 3,
            gap: 2,
            borderRadius: "var(--radius-pill)",
          }}
          role="group"
          aria-label="Date range"
        >
          {(["7d", "30d", "90d", "custom"] as Range[]).map((r) => (
            <button
              key={r}
              type="button"
              className={range === r ? "nav-item nav-item-active" : "nav-item"}
              style={{
                padding: "5px 12px",
                cursor: "pointer",
                background: range === r ? undefined : "transparent",
                fontSize: 12.5,
              }}
              aria-pressed={range === r}
              onClick={() => {
                setRange(r);
                setGranOverride(null);
              }}
            >
              {r === "custom" ? "Custom" : r}
            </button>
          ))}
        </div>

        {range === "custom" && (
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <input
              type="date"
              className="input"
              style={{ width: 150 }}
              value={customFrom}
              onChange={(e) => setCustomFrom(e.target.value)}
              aria-label="From date"
            />
            <span className="faint">→</span>
            <input
              type="date"
              className="input"
              style={{ width: 150 }}
              value={customTo}
              onChange={(e) => setCustomTo(e.target.value)}
              aria-label="To date"
            />
          </div>
        )}

        <select
          className="input"
          style={{ width: 110 }}
          value={granularity}
          onChange={(e) => setGranOverride(e.target.value as RollupPeriod)}
          aria-label="Granularity"
        >
          {GRANULARITIES.map((g) => (
            <option key={g} value={g}>
              {g}
            </option>
          ))}
        </select>

        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            fontSize: 12.5,
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={compare}
            onChange={(e) => setCompare(e.target.checked)}
          />
          Compare to previous
        </label>

        <button
          type="button"
          className="btn btn-sm"
          style={{ marginLeft: "auto" }}
          onClick={() => setAddOpen(true)}
        >
          + Add metric
        </button>
      </div>

      {/* ── available-to-add (§P9-W0B) ── */}
      <MetricDiscoveryPanel
        projectId={projectId}
        onAdded={() => setRefreshKey((n) => n + 1)}
      />

      {/* ── metric chips ── */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
        {definitions.map((def, i) => {
          const active = selected.includes(def.key);
          const colorIdx = active ? selected.indexOf(def.key) : i;
          const color = metricColor(colorIdx);
          const canDelete = def.isCustom && !def.isDerived;
          const atLimit = !active && selected.length >= MAX_CHARTS;
          return (
            <span
              key={def.key}
              style={{ display: "inline-flex", alignItems: "center" }}
            >
              <button
                type="button"
                className="badge"
                onClick={() => toggleSelect(def.key)}
                disabled={atLimit}
                title={atLimit ? "Up to 4 charts at once" : def.name}
                style={{
                  cursor: atLimit ? "not-allowed" : "pointer",
                  height: 24,
                  color: active ? color : "var(--text-2)",
                  background: active ? tint(color, 0.14) : "var(--card-2)",
                  borderColor: active ? tint(color, 0.4) : "var(--border)",
                  opacity: atLimit ? 0.5 : 1,
                  borderTopRightRadius: canDelete ? 0 : 6,
                  borderBottomRightRadius: canDelete ? 0 : 6,
                }}
              >
                {active && (
                  <span
                    className="dot"
                    style={{ background: color, width: 6, height: 6 }}
                  />
                )}
                {def.name}
                {def.isDerived && (
                  <span className="faint" style={{ fontSize: 9 }}>
                    ratio
                  </span>
                )}
              </button>
              {canDelete && (
                <button
                  type="button"
                  className="badge"
                  aria-label={`Delete ${def.name}`}
                  disabled={deleting[def.key]}
                  onClick={() => remove(def.key)}
                  style={{
                    cursor: "pointer",
                    height: 24,
                    padding: "0 7px",
                    color: "var(--text-3)",
                    background: "var(--card-2)",
                    borderColor: "var(--border)",
                    borderLeft: "none",
                    borderTopLeftRadius: 0,
                    borderBottomLeftRadius: 0,
                  }}
                >
                  ×
                </button>
              )}
            </span>
          );
        })}
      </div>

      {/* ── charts ── */}
      {selected.length === 0 ? (
        <div className="card empty">
          <span className="empty-title">Pick a metric to chart</span>
          <span style={{ fontSize: 13 }}>
            Select up to {MAX_CHARTS} metrics above to plot them.
          </span>
        </div>
      ) : chartState.status === "loading" ? (
        <div
          style={{
            display: "grid",
            gridTemplateColumns:
              selected.length > 1 ? "repeat(auto-fit, minmax(320px, 1fr))" : "1fr",
            gap: 14,
          }}
        >
          {selected.map((k) => (
            <div key={k} className="skeleton" style={{ height: 260 }} />
          ))}
        </div>
      ) : chartState.status === "error" ? (
        <div className="card empty">
          <span className="empty-title">Couldn&apos;t load these series</span>
          <span style={{ fontSize: 13 }}>Adjust the range and try again.</span>
        </div>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns:
              selected.length > 1 ? "repeat(auto-fit, minmax(340px, 1fr))" : "1fr",
            gap: 14,
          }}
        >
          {selected.map((key, i) => {
            const m = meta[key];
            const points = readyData?.series?.[key] ?? [];
            const cmp = readyData?.compare?.[key] ?? null;
            const color = metricColor(i);
            // Numbers first (§Numbers first): the card's own headline is the
            // latest bucket + its Δ vs the previous bucket in THIS series (the
            // selected range/granularity/compare window) — not the day-only KPI
            // strip's number above, which is a different, fixed window.
            const last = points[points.length - 1] ?? null;
            const prior = points.length >= 2 ? points[points.length - 2] : null;
            const latestDelta = last && prior ? last.value - prior.value : null;
            return (
              <section className="card" key={key} style={{ padding: 16, display: "grid", gap: 12 }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                  }}
                >
                  <span className="dot" style={{ background: color }} />
                  <span style={{ fontSize: 13.5, fontWeight: 600 }}>
                    {m?.name ?? key}
                  </span>
                  <span className="faint" style={{ fontSize: 11.5 }}>
                    {m?.aggregation} · {granularity}
                  </span>
                </div>
                <StatTile
                  label="Latest"
                  value={formatMetricValue(last?.value, m?.unit ?? "count")}
                  delta={latestDelta}
                  deltaLabel={latestDelta !== null ? formatDelta(latestDelta, m?.unit ?? "count") : undefined}
                  goodDirection={m?.goodDirection ?? "up"}
                  sub={`vs prior ${granularity}`}
                  sparkline={points.map((p) => p.value)}
                  sparkColor={color}
                />
                <ExpandableChart label="chart">
                  <LineChart
                    points={points}
                    comparePoints={compare ? cmp : null}
                    color={color}
                    unit={m?.unit ?? "count"}
                    period={granularity}
                  />
                </ExpandableChart>
              </section>
            );
          })}
        </div>
      )}

      <AddMetricModal
        projectId={projectId}
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onCreated={() => setRefreshKey((n) => n + 1)}
      />
    </div>
  );
}
