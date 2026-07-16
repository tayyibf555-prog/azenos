"use client";

import type { ReactNode } from "react";
import { COLORS } from "../ui";
import { MiniTrend } from "./charts";

/**
 * Numbers-first primitive #1 (APPLE-THEME.md §Numbers first): a dense stat
 * tile — big `tnum` value, quiet label, a good-direction-aware delta chip,
 * and an optional ≤48px axis-less sparkline hint. This is the atom every
 * analytics section's StatGrid is built from; sections read as NUMBERS, with
 * the full chart moved behind ExpandableChart.
 */

export type StatGoodDirection = "up" | "down";
export type StatDeltaTone = "good" | "bad" | "neutral";

/** Pure: which way a signed delta reads given which direction is "good". */
export function deltaTone(
  delta: number | null | undefined,
  goodDirection: StatGoodDirection = "up",
): StatDeltaTone {
  if (delta === null || delta === undefined || !Number.isFinite(delta) || delta === 0) {
    return "neutral";
  }
  const positive = delta > 0;
  const good = goodDirection === "up" ? positive : !positive;
  return good ? "good" : "bad";
}

/** Pure: tone → the token colour that paints it. */
export function deltaToneColor(tone: StatDeltaTone): string {
  if (tone === "good") return COLORS.green;
  if (tone === "bad") return COLORS.red;
  return COLORS.grey;
}

/** Pure: signed, thousands-separated default delta text ("+12", "−4", "±0"). */
export function formatSignedDelta(delta: number | null | undefined): string | null {
  if (delta === null || delta === undefined || !Number.isFinite(delta)) return null;
  const sign = delta > 0 ? "+" : delta < 0 ? "−" : "±";
  return `${sign}${Math.abs(delta).toLocaleString("en-GB")}`;
}

export interface StatTileProps {
  label: ReactNode;
  value: ReactNode;
  /** signed change vs the prior equal window; drives the delta chip colour */
  delta?: number | null;
  /** override the auto-formatted delta text (e.g. a % or £ delta) */
  deltaLabel?: string;
  /** which direction of `delta` counts as good — flips the chip colour (default "up") */
  goodDirection?: StatGoodDirection;
  sub?: ReactNode;
  /** ≤48px axis-less sparkline hint; omit for a plain tile */
  sparkline?: number[];
  sparkColor?: string;
  /** override the value's colour (e.g. a severity tone) */
  tone?: string;
  size?: "md" | "lg";
}

export function StatTile({
  label,
  value,
  delta = null,
  deltaLabel,
  goodDirection = "up",
  sub,
  sparkline,
  sparkColor,
  tone,
  size = "md",
}: StatTileProps) {
  const tint = deltaTone(delta, goodDirection);
  const dColor = deltaToneColor(tint);
  const deltaText = deltaLabel ?? formatSignedDelta(delta);
  const big = size === "lg";

  return (
    <div
      className="card"
      style={{ padding: big ? 18 : 14, display: "grid", gap: 6, minWidth: 0 }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
        <span className="muted" style={{ fontSize: 12, fontWeight: 550, minWidth: 0 }}>
          {label}
        </span>
        {sparkline && sparkline.length > 1 && (
          <MiniTrend values={sparkline} color={sparkColor ?? COLORS.teal} width={44} height={18} />
        )}
      </div>
      <span
        className="tnum"
        style={{
          fontSize: big ? 28 : 21,
          fontWeight: 660,
          lineHeight: 1.08,
          color: tone ?? "var(--text)",
        }}
      >
        {value}
      </span>
      {(deltaText || sub) && (
        <span style={{ display: "flex", alignItems: "baseline", gap: 6, flexWrap: "wrap" }}>
          {deltaText && (
            <span className="tnum" style={{ fontSize: 11.5, fontWeight: 600, color: dColor }}>
              {deltaText}
            </span>
          )}
          {sub && (
            <span className="faint" style={{ fontSize: 11 }}>
              {sub}
            </span>
          )}
        </span>
      )}
    </div>
  );
}
