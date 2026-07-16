"use client";

import { useState } from "react";
import { formatPence } from "../../lib/format";
import { COLORS } from "../ui";

/**
 * Value-vs-cost quadrant (P9-PACK3 — app/portfolio/page.tsx). Lives behind an
 * ExpandableChart per the Numbers-first rule — the ranked ROI table above it
 * carries the numbers; this is the visual. x = OS+emitted cost MTD, y =
 * attributed value MTD, dot size = events MTD (sqrt-scaled), colour =
 * objective health (green/amber/red). The two axes are scaled INDEPENDENTLY
 * (cost and value ranges differ by orders of magnitude — a shared scale would
 * collapse every dot onto the y-axis), so the value=cost (1× ROI) reference is
 * drawn from the real data mapping rather than a fixed 45° line — dots above it
 * are in profit this month, below it aren't.
 */

export interface QuadrantPoint {
  projectId: string;
  projectName: string;
  clientName: string;
  costPence: number;
  valuePence: number;
  eventsMtd: number;
  health: "green" | "amber" | "red";
}

const HEALTH_COLOR: Record<QuadrantPoint["health"], string> = {
  green: COLORS.green,
  amber: COLORS.amber,
  red: COLORS.red,
};

const W = 600;
const H = 340;
const PAD = { top: 16, right: 20, bottom: 34, left: 60 };
const PLOT_W = W - PAD.left - PAD.right;
const PLOT_H = H - PAD.top - PAD.bottom;

export function PortfolioQuadrant({ points }: { points: QuadrantPoint[] }) {
  const [hoverId, setHoverId] = useState<string | null>(null);

  if (points.length === 0) {
    return (
      <span className="faint" style={{ fontSize: 12.5 }}>
        No live projects with cost or value activity this month yet.
      </span>
    );
  }

  const maxCost = Math.max(...points.map((p) => p.costPence), 1);
  const maxValue = Math.max(...points.map((p) => p.valuePence), 1);
  const maxEvents = Math.max(...points.map((p) => p.eventsMtd), 1);
  // Independent axes: cost (x) and value (y) can differ by orders of magnitude,
  // so each gets its own scale — a shared scale collapses every dot onto the
  // low-cost edge and makes per-project cost position unreadable.
  const xAxisMax = maxCost * 1.08;
  const yAxisMax = maxValue * 1.08;

  const xAt = (pence: number) => PAD.left + (pence / xAxisMax) * PLOT_W;
  const yAt = (pence: number) => PAD.top + PLOT_H - (pence / yAxisMax) * PLOT_H;
  const rAt = (events: number) => 4 + Math.sqrt(Math.max(events, 0) / maxEvents) * 12;

  // The value=cost (1× ROI) reference runs from the origin to the largest pence
  // value visible on BOTH axes, mapped through each axis's own scale.
  const diagCap = Math.min(xAxisMax, yAxisMax);
  const hovered = points.find((p) => p.projectId === hoverId) ?? null;

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label="Value versus cost, one dot per live project">
        {/* gridlines */}
        {[0.25, 0.5, 0.75, 1].map((f) => (
          <line
            key={f}
            x1={PAD.left}
            x2={W - PAD.right}
            y1={PAD.top + PLOT_H * (1 - f)}
            y2={PAD.top + PLOT_H * (1 - f)}
            stroke="var(--border)"
            strokeWidth={1}
          />
        ))}
        {/* ROI=1 diagonal (value = cost) */}
        <line
          x1={xAt(0)}
          y1={yAt(0)}
          x2={xAt(diagCap)}
          y2={yAt(diagCap)}
          stroke={COLORS.teal}
          strokeWidth={1.5}
          strokeDasharray="4 4"
        />
        {/* axes */}
        <line x1={PAD.left} y1={PAD.top} x2={PAD.left} y2={PAD.top + PLOT_H} stroke="var(--border)" />
        <line x1={PAD.left} y1={PAD.top + PLOT_H} x2={W - PAD.right} y2={PAD.top + PLOT_H} stroke="var(--border)" />
        <text x={PAD.left} y={H - 8} fontSize={10.5} fill="var(--text-3)">
          cost MTD →
        </text>
        <text x={12} y={PAD.top + 8} fontSize={10.5} fill="var(--text-3)" transform={`rotate(-90 12 ${PAD.top + 8})`}>
          value MTD →
        </text>
        {/* value-axis top (y) and cost-axis end (x) — separate scales, labelled */}
        <text x={PAD.left} y={PAD.top - 4} fontSize={10} fill="var(--text-3)">
          {formatPence(yAxisMax)}
        </text>
        <text x={W - PAD.right} y={H - 8} fontSize={10} textAnchor="end" fill="var(--text-3)">
          {formatPence(xAxisMax)}
        </text>

        {points.map((p) => (
          <circle
            key={p.projectId}
            cx={xAt(p.costPence)}
            cy={yAt(p.valuePence)}
            r={rAt(p.eventsMtd)}
            fill={HEALTH_COLOR[p.health]}
            fillOpacity={hoverId === null || hoverId === p.projectId ? 0.8 : 0.25}
            stroke="var(--card)"
            strokeWidth={1.5}
            style={{ cursor: "pointer" }}
            onMouseEnter={() => setHoverId(p.projectId)}
            onMouseLeave={() => setHoverId(null)}
          >
            <title>
              {p.projectName} · {formatPence(p.valuePence)} value ÷ {formatPence(p.costPence)} cost ·{" "}
              {p.eventsMtd.toLocaleString("en-GB")} events
            </title>
          </circle>
        ))}
      </svg>
      <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <span className="faint" style={{ fontSize: 11 }}>
          dashed line = value equals cost (1× ROI) · axes scaled independently · dot size = events this month
        </span>
        <span className="faint tnum" style={{ fontSize: 11.5, minHeight: 14 }}>
          {hovered ? `${hovered.projectName} — ${hovered.clientName}` : " "}
        </span>
      </div>
    </div>
  );
}
