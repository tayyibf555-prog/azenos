"use client";

import { useState } from "react";
import type { MouseEvent } from "react";
import type { MetricUnit } from "../metrics-types";
import { tint } from "../ui";
import {
  formatMetricValue,
  londonHourLabel,
  londonShortDate,
} from "./util";

export interface ChartPoint {
  periodStart: string;
  /** null = no value for this bucket (e.g. derived ratio ÷0) — drawn as a gap. */
  value: number | null;
}

/**
 * P9-PACK1 additive: a forecast band point continuing past the series'
 * last point (lib/server/forecast.ts computeForecastBand output shape).
 */
export interface BandPoint {
  periodStart: string;
  low: number;
  high: number;
}

const VIEW_W = 640;
const VIEW_H = 220;
const PAD = { top: 14, right: 16, bottom: 26, left: 54 };
const PLOT_W = VIEW_W - PAD.left - PAD.right;
const PLOT_H = VIEW_H - PAD.top - PAD.bottom;

/**
 * Dependency-free line chart (§Metrics UI): 640×220 viewBox, 3 y-gridlines
 * with labels, first/mid/last x date labels, nearest-point hover dot +
 * tooltip, and an optional dashed "compare" series.
 */
export function LineChart({
  points,
  comparePoints,
  color,
  unit,
  period,
  band,
}: {
  points: ChartPoint[];
  comparePoints?: ChartPoint[] | null;
  color: string;
  unit: MetricUnit;
  period: string;
  /**
   * P9-PACK1 additive: an optional forecast band continuing past the last
   * real point — dashed low/high outline + a light fill, labelled
   * "projection". Purely additive: omit (the default) for byte-identical
   * output to before this prop existed.
   */
  band?: BandPoint[] | null;
}) {
  const [hover, setHover] = useState<number | null>(null);

  if (points.length < 2) {
    return (
      <div
        className="faint"
        style={{ height: VIEW_H, display: "grid", placeItems: "center", fontSize: 13 }}
      >
        Not enough data to plot yet.
      </div>
    );
  }

  const bandPts = band && band.length > 0 ? band : null;
  // Total point count used for the x-scale: when a band is present the chart
  // continues the SAME timeline into the projected days, so every x position
  // (including the already-plotted real points) is scaled against the
  // combined length. When band is omitted this is exactly points.length —
  // identical to pre-band behaviour.
  const totalN = points.length + (bandPts ? bandPts.length : 0);

  // null-valued buckets are excluded from the y-domain (they're gaps, not 0s).
  const isNum = (v: number | null): v is number => v !== null && Number.isFinite(v);
  const values = points.map((p) => p.value).filter(isNum);
  const compareValues = (comparePoints ?? []).map((p) => p.value).filter(isNum);
  const bandValues = bandPts ? bandPts.flatMap((b) => [b.low, b.high]) : [];
  const combined = [...values, ...compareValues, ...bandValues];
  const dataMin = combined.length > 0 ? Math.min(...combined) : 0;
  const dataMax = combined.length > 0 ? Math.max(...combined) : 0;
  let min = dataMin;
  let max = dataMax;
  if (min === max) {
    const pad = Math.abs(min) || 1;
    min -= pad;
    max += pad;
  }
  const span = max - min || 1;
  max += span * 0.08; // headroom so the peak isn't clipped by the top gridline
  // a little context below the low point, but never past 0 for non-negative data
  min = dataMin >= 0 ? Math.max(0, min - span * 0.08) : min - span * 0.08;
  const yScale = max - min || 1;

  // x is normalised by the series' OWN length so the compare (previous-window)
  // series — which routinely has a different point count than the current
  // window — spans the same plot width instead of overshooting/undershooting.
  const xAt = (i: number, n: number): number =>
    PAD.left + (n > 1 ? i / (n - 1) : 0) * PLOT_W;
  const xFor = (i: number): number => xAt(i, totalN);
  const yFor = (v: number): number =>
    PAD.top + PLOT_H - ((v - min) / yScale) * PLOT_H;

  // Skip null buckets: a null lifts the pen so the next real point starts a new
  // subpath (a visible gap) rather than being coerced to a spurious 0 vertex.
  const buildPath = (pts: ChartPoint[], n: number): string => {
    let d = "";
    let penUp = true;
    pts.forEach((p, i) => {
      if (!isNum(p.value)) {
        penUp = true;
        return;
      }
      d += `${d ? " " : ""}${penUp ? "M" : "L"}${xAt(i, n).toFixed(1)} ${yFor(p.value).toFixed(1)}`;
      penUp = false;
    });
    return d;
  };

  // buildPath is called with totalN (not points.length) so the real series
  // shares exactly the same x-scale as the appended band when one is present
  // — with band omitted, totalN === points.length and this is byte-identical
  // to the pre-band behaviour.
  const linePath = buildPath(points, totalN);
  const areaPath = linePath
    ? `${linePath} L ${xFor(points.length - 1).toFixed(1)} ${(
        PAD.top + PLOT_H
      ).toFixed(1)} L ${xFor(0).toFixed(1)} ${(PAD.top + PLOT_H).toFixed(1)} Z`
    : "";
  const comparePath =
    comparePoints && comparePoints.length >= 2
      ? buildPath(comparePoints, comparePoints.length)
      : null;

  // Forecast band geometry: a dashed ribbon continuing from the last REAL
  // point (so it reads as one unbroken line picking up a projection, not a
  // disconnected shape) out through each band point's low/high.
  const lastRealValue = (() => {
    for (let i = points.length - 1; i >= 0; i--) {
      if (isNum(points[i]!.value)) return points[i]!.value as number;
    }
    return null;
  })();
  const bandGeom =
    bandPts && lastRealValue !== null
      ? (() => {
          const anchor: [number, number] = [
            xFor(points.length - 1),
            yFor(lastRealValue),
          ];
          const lowPts: [number, number][] = [
            anchor,
            ...bandPts.map((b, j): [number, number] => [
              xAt(points.length + j, totalN),
              yFor(b.low),
            ]),
          ];
          const highPts: [number, number][] = [
            anchor,
            ...bandPts.map((b, j): [number, number] => [
              xAt(points.length + j, totalN),
              yFor(b.high),
            ]),
          ];
          const midPts: [number, number][] = [
            anchor,
            ...bandPts.map((b, j): [number, number] => [
              xAt(points.length + j, totalN),
              yFor((b.low + b.high) / 2),
            ]),
          ];
          const toPath = (pts: [number, number][]): string =>
            pts
              .map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`)
              .join(" ");
          const areaPts = [...highPts, ...[...lowPts].reverse()];
          return {
            low: toPath(lowPts),
            high: toPath(highPts),
            mid: toPath(midPts),
            area: `${toPath(areaPts)} Z`,
            labelX: highPts[highPts.length - 1]![0],
            labelY: Math.min(...highPts.map(([, y]) => y)),
          };
        })()
      : null;

  const gridVals = [max, (max + min) / 2, min];
  const xLabelIdx = [0, Math.floor((points.length - 1) / 2), points.length - 1];

  const labelFor = (iso: string): string =>
    period === "hour" ? londonHourLabel(iso) : londonShortDate(iso);

  function onMove(e: MouseEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width === 0) return;
    const svgX = ((e.clientX - rect.left) / rect.width) * VIEW_W;
    const rel = (svgX - PAD.left) / PLOT_W;
    // Scaled by totalN (matches xFor) then clamped to the real-point range —
    // hovering into the projected region shows the last real point rather
    // than indexing past the end of `points`.
    const idx = Math.round(rel * (totalN - 1));
    setHover(Math.max(0, Math.min(points.length - 1, idx)));
  }

  const hv = hover !== null ? points[hover] : null;
  const hvValue = hv && isNum(hv.value) ? hv.value : null;
  const hoverCompareRaw =
    hover !== null && comparePoints && comparePoints[hover]
      ? comparePoints[hover]
      : null;
  const hoverCompareValue =
    hoverCompareRaw && isNum(hoverCompareRaw.value)
      ? hoverCompareRaw.value
      : null;
  const hx = hover !== null ? xFor(hover) : 0;
  const hy = hvValue !== null ? yFor(hvValue) : 0;

  const tipW = 116;
  const tipH = hoverCompareValue !== null ? 46 : 32;
  const tipX = Math.max(
    PAD.left,
    Math.min(hx - tipW / 2, VIEW_W - PAD.right - tipW),
  );
  const tipY = Math.max(PAD.top, hy - tipH - 10);

  return (
    <svg
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      width="100%"
      role="img"
      preserveAspectRatio="none"
      style={{ display: "block", overflow: "visible" }}
      onMouseMove={onMove}
      onMouseLeave={() => setHover(null)}
    >
      {/* gridlines + y labels */}
      {gridVals.map((v, i) => {
        const y = yFor(v);
        return (
          <g key={i}>
            <line
              x1={PAD.left}
              x2={VIEW_W - PAD.right}
              y1={y}
              y2={y}
              stroke="var(--border)"
              strokeWidth={1}
            />
            <text
              x={PAD.left - 8}
              y={y + 3.5}
              textAnchor="end"
              fontSize={10.5}
              fill="var(--text-2)"
            >
              {formatMetricValue(v, unit)}
            </text>
          </g>
        );
      })}

      {/* x labels */}
      {xLabelIdx.map((idx, i) => (
        <text
          key={idx}
          x={xFor(idx)}
          y={VIEW_H - 8}
          textAnchor={i === 0 ? "start" : i === xLabelIdx.length - 1 ? "end" : "middle"}
          fontSize={10.5}
          fill="var(--text-3)"
        >
          {(() => {
            const p = points[idx];
            if (!p) return "";
            return period === "hour"
              ? londonHourLabel(p.periodStart)
              : londonShortDate(p.periodStart);
          })()}
        </text>
      ))}

      {/* compare (dashed) */}
      {comparePath && (
        <path
          d={comparePath}
          fill="none"
          stroke={color}
          strokeOpacity={0.45}
          strokeWidth={1.6}
          strokeDasharray="4 4"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      )}

      {/* primary series — RECIPE §5: flat deep-hue wash, no gradient */}
      {areaPath && <path d={areaPath} fill={color} fillOpacity={0.08} stroke="none" />}
      <path
        d={linePath}
        fill="none"
        stroke={color}
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
      />

      {/* forecast band (P9-PACK1 additive) — dashed, continuing off the last
          real point; only ever rendered when the `band` prop is passed. */}
      {bandGeom && (
        <g>
          <path d={bandGeom.area} fill={color} fillOpacity={0.1} stroke="none" />
          <path
            d={bandGeom.high}
            fill="none"
            stroke={color}
            strokeOpacity={0.5}
            strokeWidth={1.3}
            strokeDasharray="3 3"
          />
          <path
            d={bandGeom.low}
            fill="none"
            stroke={color}
            strokeOpacity={0.5}
            strokeWidth={1.3}
            strokeDasharray="3 3"
          />
          <path
            d={bandGeom.mid}
            fill="none"
            stroke={color}
            strokeOpacity={0.85}
            strokeWidth={1.6}
            strokeDasharray="5 3"
            strokeLinecap="round"
          />
          <text
            x={bandGeom.labelX}
            y={Math.max(PAD.top + 9, bandGeom.labelY - 6)}
            textAnchor="end"
            fontSize={10}
            fontStyle="italic"
            fill="var(--text-3)"
          >
            projection
          </text>
        </g>
      )}

      {/* hover (only over a real, non-null point) */}
      {hv && hvValue !== null && (
        <g>
          <line
            x1={hx}
            x2={hx}
            y1={PAD.top}
            y2={PAD.top + PLOT_H}
            stroke="var(--border-3)"
            strokeWidth={1}
          />
          {hoverCompareValue !== null && (
            <circle
              cx={hx}
              cy={yFor(hoverCompareValue)}
              r={3}
              fill="var(--card)"
              stroke={color}
              strokeOpacity={0.5}
              strokeWidth={1.5}
            />
          )}
          <circle cx={hx} cy={hy} r={3.6} fill={color} stroke="var(--card)" strokeWidth={1.6} />
          <g>
            <rect
              x={tipX}
              y={tipY}
              width={tipW}
              height={tipH}
              rx={6}
              fill="var(--card-2)"
              stroke="var(--border-2)"
              strokeWidth={1}
            />
            <text x={tipX + 9} y={tipY + 14} fontSize={10.5} fill="var(--text-3)">
              {labelFor(hv.periodStart)}
            </text>
            <text
              x={tipX + 9}
              y={tipY + 27}
              fontSize={12}
              fontWeight={600}
              fill="var(--text)"
            >
              {formatMetricValue(hvValue, unit)}
            </text>
            {hoverCompareValue !== null && (
              <text x={tipX + 9} y={tipY + 40} fontSize={10.5} fill={tint(color, 0.9)}>
                prev {formatMetricValue(hoverCompareValue, unit)}
              </text>
            )}
          </g>
        </g>
      )}
    </svg>
  );
}
