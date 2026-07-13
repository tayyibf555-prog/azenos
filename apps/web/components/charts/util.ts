/**
 * Shared runtime helpers for the M3 metrics UI: colour palette, London
 * day/month keys, range→date math, granularity heuristics, and unit-aware
 * value formatting. Pure and client-safe.
 */

import { formatPence } from "../../lib/format";
import { COLORS } from "../ui";
import type { GoodDirection, MetricUnit } from "../metrics-types";

/** Distinct, ordered colours for up-to-4 concurrently rendered charts. */
export const METRIC_PALETTE: readonly string[] = [
  COLORS.blue,
  COLORS.violet,
  COLORS.green,
  COLORS.teal,
  COLORS.amber,
  COLORS.magenta,
  COLORS.orange,
  COLORS.red,
];

export function metricColor(index: number): string {
  return METRIC_PALETTE[index % METRIC_PALETTE.length] ?? COLORS.blue;
}

const londonDayFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/London",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const londonShortFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  day: "2-digit",
  month: "short",
});

const londonHourFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** "2026-07-12" in Europe/London — lexicographically comparable day key. */
export function londonDayKey(input: string | number | Date): string {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return "";
  return londonDayFmt.format(d);
}

/** "12 Jul" for x-axis labels. */
export function londonShortDate(input: string | number | Date): string {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return "—";
  return londonShortFmt.format(d);
}

/** "12 Jul 14:00" for hour-granularity tooltips. */
export function londonHourLabel(input: string | number | Date): string {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return "—";
  return londonHourFmt.format(d);
}

/** Current London month as "YYYY-MM" (default month for ROI + costs). */
export function currentLondonMonth(): string {
  return londonDayKey(Date.now()).slice(0, 7);
}

/** from/to (inclusive) London day keys for a trailing N-day window. */
export function rangeToDates(days: number): { from: string; to: string } {
  const now = Date.now();
  return {
    from: londonDayKey(now - (days - 1) * 86_400_000),
    to: londonDayKey(now),
  };
}

/** §Metrics UI: day default, hour for ≤7d, week for ≥60d. */
export function recommendedGranularity(days: number): "hour" | "day" | "week" {
  if (days <= 7) return "hour";
  if (days >= 60) return "week";
  return "day";
}

function fmtNumber(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const rounded = Math.round(value);
  if (Math.abs(value - rounded) < 1e-9) return rounded.toLocaleString("en-GB");
  return value.toLocaleString("en-GB", { maximumFractionDigits: 2 });
}

/** Unit-aware value rendering shared by KPI strip, charts, goals, previews. */
export function formatMetricValue(
  value: number | null | undefined,
  unit: MetricUnit,
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "—";
  }
  switch (unit) {
    case "pence":
      return formatPence(Math.round(value));
    case "percent":
      return `${fmtNumber(value)}%`;
    case "minutes":
      return `${fmtNumber(value)} min`;
    case "ms":
      return `${fmtNumber(value)} ms`;
    default:
      return fmtNumber(value);
  }
}

/** Colour a delta by whether it moves in the metric's good direction. */
export function deltaColor(delta: number, goodDirection: GoodDirection): string {
  if (delta === 0) return "var(--text-3)";
  const improving = goodDirection === "up" ? delta > 0 : delta < 0;
  return improving ? COLORS.green : COLORS.red;
}

/** Signed, unit-aware delta label, e.g. "+3", "−£12.00". */
export function formatDelta(delta: number, unit: MetricUnit): string {
  if (!Number.isFinite(delta) || delta === 0) return "±0";
  const sign = delta > 0 ? "+" : "−";
  return `${sign}${formatMetricValue(Math.abs(delta), unit)}`;
}
