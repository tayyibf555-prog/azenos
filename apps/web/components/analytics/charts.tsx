"use client";

import { useId, useState } from "react";
import type { ReactNode } from "react";
import { COLORS, tint } from "../ui";

/**
 * Chart primitive kit for the Analytics screen (Soft-Light, on white cards).
 * All marks are COLORS-based (slate → royal ramp for intensity),
 * label-clear, and quietly interactive. The full line chart lives in
 * components/charts/LineChart — re-exported here so sections import from one
 * place — these primitives cover the shapes it does not.
 */
export { LineChart } from "../charts/LineChart";
export type { BandPoint, ChartPoint } from "../charts/LineChart";

// ── colour helpers ───────────────────────────────────────────────────────────

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

/** Interpolate between two hex colours (t in 0..1) → rgb() string. */
function mix(from: string, to: string, t: number): string {
  const a = hexToRgb(from);
  const b = hexToRgb(to);
  const k = Math.max(0, Math.min(1, t));
  const c = a.map((v, i) => Math.round(v + (b[i]! - v) * k));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

/** The signature ice→royal ramp used across the kit for intensity. */
export function intensityColor(t: number): string {
  return mix(COLORS.teal, COLORS.blue, t);
}

const DEFAULT_PALETTE: readonly string[] = [
  COLORS.blue,
  COLORS.teal,
  COLORS.violet,
  COLORS.green,
  COLORS.amber,
  COLORS.magenta,
  COLORS.orange,
  COLORS.red,
];

function paletteColor(i: number): string {
  return DEFAULT_PALETTE[i % DEFAULT_PALETTE.length]!;
}

function EmptyNote({ label }: { label: string }) {
  return (
    <div
      className="faint"
      style={{
        display: "grid",
        placeItems: "center",
        minHeight: 96,
        fontSize: 12.5,
        textAlign: "center",
        padding: 12,
      }}
    >
      {label}
    </div>
  );
}

// ── BigStat ──────────────────────────────────────────────────────────────────

export interface BigStatProps {
  label: string;
  value: ReactNode;
  /** signed change; sign drives the colour, `deltaLabel` overrides the text */
  delta?: number | null;
  deltaLabel?: string;
  /** direction that counts as good — flips the delta colour (default "up") */
  goodDirection?: "up" | "down";
  sub?: ReactNode;
}

/** The one signature number per view: label + near-black→royal gradient value. */
export function BigStat({
  label,
  value,
  delta = null,
  deltaLabel,
  goodDirection = "up",
  sub,
}: BigStatProps) {
  let deltaColor: string = COLORS.grey;
  if (delta !== null && delta !== 0) {
    const positive = delta > 0;
    const good = goodDirection === "up" ? positive : !positive;
    deltaColor = good ? COLORS.green : COLORS.red;
  }
  const deltaText =
    deltaLabel ??
    (delta !== null
      ? `${delta > 0 ? "+" : ""}${delta.toLocaleString("en-GB")}`
      : null);
  return (
    <div style={{ display: "grid", gap: 6 }}>
      <span className="muted" style={{ fontSize: 12.5, fontWeight: 550 }}>
        {label}
      </span>
      <span
        className="accent-num tnum"
        style={{ fontSize: 34, fontWeight: 680, lineHeight: 1.05 }}
      >
        {value}
      </span>
      {(deltaText || sub) && (
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {deltaText && (
            <span
              className="tnum"
              style={{ fontSize: 12.5, fontWeight: 600, color: deltaColor }}
            >
              {deltaText}
            </span>
          )}
          {sub && (
            <span className="faint" style={{ fontSize: 12 }}>
              {sub}
            </span>
          )}
        </span>
      )}
    </div>
  );
}

// ── MiniTrend (tiny sparkline) ────────────────────────────────────────────────

export function MiniTrend({
  values,
  color = COLORS.teal,
  width = 96,
  height = 28,
}: {
  values: number[];
  color?: string;
  width?: number;
  height?: number;
}) {
  const gradId = useId();
  if (values.length < 2) {
    return (
      <svg width={width} height={height} aria-hidden style={{ display: "block" }} />
    );
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const stepX = width / (values.length - 1);
  const y = (v: number) => height - 2 - ((v - min) / span) * (height - 4);
  const pts = values.map((v, i) => `${(i * stepX).toFixed(1)},${y(v).toFixed(1)}`);
  const line = `M${pts.join(" L")}`;
  const area = `${line} L${width},${height} L0,${height} Z`;
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label="trend sparkline"
      style={{ display: "block", overflow: "visible" }}
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.24} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gradId})`} stroke="none" />
      <path
        d={line}
        fill="none"
        stroke={color}
        strokeWidth={1.6}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

// ── HBars (horizontal distribution) ───────────────────────────────────────────

export interface HBarItem {
  label: string;
  value: number;
  color?: string;
}

export function HBars({
  items,
  formatValue = (v) => v.toLocaleString("en-GB"),
  emptyLabel = "No data in this range yet.",
  labelWidth = 150,
}: {
  items: HBarItem[];
  formatValue?: (v: number) => string;
  emptyLabel?: string;
  labelWidth?: number;
}) {
  if (items.length === 0) return <EmptyNote label={emptyLabel} />;
  const max = items.reduce((m, i) => Math.max(m, i.value), 0) || 1;
  return (
    <div style={{ display: "grid", gap: 9 }}>
      {items.map((it, i) => {
        const color = it.color ?? paletteColor(i);
        return (
          <div key={`${it.label}-${i}`} style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span
              className="muted"
              style={{
                flex: "none",
                width: labelWidth,
                fontSize: 12.5,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
              title={it.label}
            >
              {it.label}
            </span>
            <div
              style={{
                flex: 1,
                height: 8,
                borderRadius: 4,
                background: "var(--card-2)",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  width: `${(it.value / max) * 100}%`,
                  height: "100%",
                  background: color,
                  opacity: 0.85,
                  borderRadius: 4,
                }}
              />
            </div>
            <span
              className="tnum"
              style={{ flex: "none", width: 64, textAlign: "right", fontSize: 12.5 }}
            >
              {formatValue(it.value)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ── Leaderboard (ranked rows with bars) ───────────────────────────────────────

export interface LeaderboardRow {
  label: string;
  value: number;
  sub?: string;
  color?: string;
}

export function Leaderboard({
  rows,
  formatValue = (v) => v.toLocaleString("en-GB"),
  emptyLabel = "Nothing to rank yet.",
}: {
  rows: LeaderboardRow[];
  formatValue?: (v: number) => string;
  emptyLabel?: string;
}) {
  if (rows.length === 0) return <EmptyNote label={emptyLabel} />;
  const max = rows.reduce((m, r) => Math.max(m, r.value), 0) || 1;
  return (
    <div style={{ display: "grid", gap: 4 }}>
      {rows.map((r, i) => {
        const color = r.color ?? intensityColor(1 - i / Math.max(1, rows.length - 1));
        return (
          <div
            key={`${r.label}-${i}`}
            style={{
              position: "relative",
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: "8px 10px",
              borderRadius: 8,
              overflow: "hidden",
            }}
          >
            <div
              style={{
                position: "absolute",
                inset: 0,
                width: `${(r.value / max) * 100}%`,
                background: tint(color, 0.12),
                borderRight: `1px solid ${tint(color, 0.3)}`,
              }}
            />
            <span
              className="tnum faint"
              style={{ position: "relative", flex: "none", width: 20, fontSize: 12 }}
            >
              {i + 1}
            </span>
            <span
              style={{
                position: "relative",
                flex: 1,
                fontSize: 13,
                fontWeight: 540,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
              title={r.label}
            >
              {r.label}
            </span>
            {r.sub && (
              <span className="faint" style={{ position: "relative", fontSize: 11.5 }}>
                {r.sub}
              </span>
            )}
            <span
              className="tnum"
              style={{ position: "relative", flex: "none", fontSize: 13, fontWeight: 600 }}
            >
              {formatValue(r.value)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ── Funnel (stacked stages with conversion %) ─────────────────────────────────

export interface FunnelStage {
  label: string;
  value: number;
  color?: string;
}

export function Funnel({
  stages,
  formatValue = (v) => v.toLocaleString("en-GB"),
  emptyLabel = "No funnel data in this range yet.",
}: {
  stages: FunnelStage[];
  formatValue?: (v: number) => string;
  emptyLabel?: string;
}) {
  if (stages.length === 0) return <EmptyNote label={emptyLabel} />;
  // The first stage is the "% of top" denominator. When it is 0 (e.g. no leads
  // in range) an `|| 1` fallback would print nonsense like 48900% for later
  // non-zero stages; instead suppress the ratio and size bars off the largest
  // stage so the funnel still renders sensibly.
  const top = stages[0]?.value ?? 0;
  const widthBasis =
    top > 0 ? top : Math.max(1, ...stages.map((st) => st.value));
  return (
    <div style={{ display: "grid", gap: 8 }}>
      {stages.map((s, i) => {
        const prev = i > 0 ? stages[i - 1]!.value : null;
        const widthPct = Math.max(2, (s.value / widthBasis) * 100);
        const conv =
          prev && prev > 0 ? Math.round((s.value / prev) * 100) : null;
        const overall = top > 0 ? Math.round((s.value / top) * 100) : null;
        const color = s.color ?? intensityColor(i / Math.max(1, stages.length - 1));
        return (
          <div key={`${s.label}-${i}`} style={{ display: "grid", gap: 4 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
              <span style={{ fontSize: 12.5, fontWeight: 540 }}>{s.label}</span>
              <span className="tnum muted" style={{ fontSize: 12.5 }}>
                {formatValue(s.value)}
                {overall !== null && (
                  <span className="faint"> · {overall}%</span>
                )}
              </span>
            </div>
            <div
              style={{
                height: 26,
                borderRadius: 7,
                background: "var(--card-2)",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  width: `${widthPct}%`,
                  height: "100%",
                  background: `linear-gradient(90deg, ${tint(color, 0.9)}, ${tint(color, 0.55)})`,
                  borderRadius: 7,
                }}
              />
            </div>
            {conv !== null && i > 0 && (
              <span className="faint tnum" style={{ fontSize: 11 }}>
                {conv}% from previous
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Donut (category mix) ──────────────────────────────────────────────────────

export interface DonutSegment {
  label: string;
  value: number;
  color?: string;
}

/**
 * Numbers-first companion to Donut (§Numbers first — donuts render as the top
 * value headline + a ranked top-N list first, with the ring itself behind an
 * expand). Pure: sorts descending, drops zeros, caps at n.
 */
export function topSegments<T extends { label: string; value: number }>(
  segments: readonly T[],
  n = 3,
): T[] {
  return segments
    .filter((s) => s.value > 0)
    .slice()
    .sort((a, b) => b.value - a.value)
    .slice(0, n);
}

export function Donut({
  segments,
  size = 132,
  thickness = 18,
  formatValue = (v) => v.toLocaleString("en-GB"),
  centerLabel,
  emptyLabel = "No mix to show yet.",
}: {
  segments: DonutSegment[];
  size?: number;
  thickness?: number;
  formatValue?: (v: number) => string;
  centerLabel?: ReactNode;
  emptyLabel?: string;
}) {
  const total = segments.reduce((s, x) => s + x.value, 0);
  if (segments.length === 0 || total <= 0) return <EmptyNote label={emptyLabel} />;
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  let offset = 0;
  const arcs = segments.map((seg, i) => {
    const frac = seg.value / total;
    const color = seg.color ?? paletteColor(i);
    const dash = `${(frac * c).toFixed(2)} ${(c - frac * c).toFixed(2)}`;
    const arc = { color, dash, off: -offset * c, seg, frac };
    offset += frac;
    return arc;
  });
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 18, flexWrap: "wrap" }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label="category mix">
        <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke="var(--card-2)"
            strokeWidth={thickness}
          />
          {arcs.map((a, i) => (
            <circle
              key={i}
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              stroke={a.color}
              strokeWidth={thickness}
              strokeDasharray={a.dash}
              strokeDashoffset={a.off}
              strokeLinecap="butt"
              opacity={0.9}
            />
          ))}
        </g>
        {centerLabel && (
          <text
            x="50%"
            y="50%"
            textAnchor="middle"
            dominantBaseline="central"
            fontSize={15}
            fontWeight={650}
            fill="var(--text)"
          >
            {typeof centerLabel === "string" ? centerLabel : ""}
          </text>
        )}
      </svg>
      <div style={{ display: "grid", gap: 6, minWidth: 120 }}>
        {arcs.map((a, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5 }}>
            <span
              style={{
                width: 9,
                height: 9,
                borderRadius: 3,
                background: a.color,
                flex: "none",
              }}
            />
            <span className="muted" style={{ flex: 1 }}>{a.seg.label}</span>
            <span className="tnum" style={{ fontWeight: 600 }}>
              {formatValue(a.seg.value)}
            </span>
            <span className="faint tnum" style={{ width: 38, textAlign: "right" }}>
              {Math.round(a.frac * 100)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Heatmap (hour × weekday intensity) ────────────────────────────────────────

const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export interface HeatmapCell {
  /** 1=Mon … 7=Sun */
  weekday: number;
  /** 0 … 23 */
  hour: number;
  value: number;
}

/**
 * Numbers-first companion to Heatmap (§Numbers first — heatmaps render as a
 * ranked number list first, with the grid itself behind an expand): collapse
 * cells sharing a weekday×hour key, then return the top N as
 * `{ label: "Tue 14:00", value }`, ready for HBars/Leaderboard.
 */
export function topHeatmapCells(
  cells: HeatmapCell[],
  n = 3,
): { label: string; value: number }[] {
  const grid = new Map<string, number>();
  for (const cell of cells) {
    const key = `${cell.weekday}-${cell.hour}`;
    grid.set(key, (grid.get(key) ?? 0) + cell.value);
  }
  return [...grid.entries()]
    .map(([key, value]) => {
      const [wd, hour] = key.split("-").map(Number);
      const label = `${WEEKDAY_LABELS[(wd ?? 1) - 1]} ${String(hour ?? 0).padStart(2, "0")}:00`;
      return { label, value };
    })
    .filter((row) => row.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, n);
}

export function Heatmap({
  cells,
  emptyLabel = "No activity to map in this range yet.",
}: {
  cells: HeatmapCell[];
  emptyLabel?: string;
}) {
  const [hover, setHover] = useState<string | null>(null);
  if (cells.length === 0) return <EmptyNote label={emptyLabel} />;
  const grid = new Map<string, number>();
  let max = 0;
  for (const cell of cells) {
    const key = `${cell.weekday}-${cell.hour}`;
    const next = (grid.get(key) ?? 0) + cell.value;
    grid.set(key, next);
    if (next > max) max = next;
  }
  const denom = max || 1;
  return (
    <div style={{ display: "grid", gap: 6 }}>
      <div style={{ overflowX: "auto", maxWidth: "100%" }}>
        <div style={{ display: "grid", gap: 4, minWidth: 560 }}>
          {WEEKDAY_LABELS.map((wd, wi) => (
            <div key={wd} style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span
                className="faint"
                style={{ flex: "none", width: 30, fontSize: 10.5, textAlign: "right" }}
              >
                {wd}
              </span>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(24, 1fr)", gap: 3, flex: 1 }}>
                {Array.from({ length: 24 }, (_, h) => {
                  const key = `${wi + 1}-${h}`;
                  const v = grid.get(key) ?? 0;
                  const t = v / denom;
                  const bg = v === 0 ? "var(--card-2)" : intensityColor(t);
                  return (
                    <div
                      key={h}
                      onMouseEnter={() => setHover(`${wd} ${String(h).padStart(2, "0")}:00 · ${v.toLocaleString("en-GB")}`)}
                      onMouseLeave={() => setHover(null)}
                      title={`${wd} ${String(h).padStart(2, "0")}:00 — ${v.toLocaleString("en-GB")}`}
                      aria-label={`${wd} ${h}:00, ${v}`}
                      style={{
                        aspectRatio: "1 / 1",
                        borderRadius: 3,
                        background: bg,
                        opacity: v === 0 ? 0.5 : 0.35 + t * 0.65,
                      }}
                    />
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span className="faint tnum" style={{ fontSize: 11, minHeight: 14 }}>
          {hover ?? " "}
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span className="faint" style={{ fontSize: 10.5 }}>less</span>
          {[0, 0.25, 0.5, 0.75, 1].map((t) => (
            <span
              key={t}
              style={{ width: 12, height: 12, borderRadius: 3, background: intensityColor(t), opacity: 0.35 + t * 0.65 }}
            />
          ))}
          <span className="faint" style={{ fontSize: 10.5 }}>more</span>
        </div>
      </div>
    </div>
  );
}
