/**
 * Churn-risk chip (docs/phase9/CONTRACTS.md §P9-KB). A numbers-first pill: the
 * 0-100 churn score + its band, coloured green/amber/red. Additive presentation
 * over lib/server/churn.ts — the maths lives there, this only renders. Reasons
 * (top contributors) become the tooltip so the owner sees WHY at a glance.
 */

import type { ChurnBand } from "../lib/server/churn";
import { COLORS, tint } from "./ui";

const BAND_COLOR: Record<ChurnBand, string> = {
  healthy: COLORS.green,
  watch: COLORS.amber,
  risk: COLORS.red,
};

const BAND_LABEL: Record<ChurnBand, string> = {
  healthy: "Healthy",
  watch: "Watch",
  risk: "At risk",
};

export function ChurnChip({
  score,
  band,
  reasons = [],
  size = "md",
}: {
  score: number;
  band: ChurnBand;
  reasons?: string[];
  size?: "sm" | "md";
}) {
  const color = BAND_COLOR[band];
  const title =
    reasons.length > 0
      ? `Churn risk ${score}/100 — ${reasons.join(" · ")}`
      : `Churn risk ${score}/100 — ${BAND_LABEL[band]}`;
  const fontSize = size === "sm" ? 11.5 : 12.5;
  return (
    <span
      className="badge"
      title={title}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        color,
        background: tint(color, 0.12),
        borderColor: tint(color, 0.28),
        fontSize,
        fontWeight: 600,
        flex: "none",
      }}
    >
      <span
        className="dot"
        aria-hidden
        style={{ width: 6, height: 6, background: color }}
      />
      <span className="tnum">{score}</span>
      <span style={{ fontWeight: 500, opacity: 0.85 }}>{BAND_LABEL[band]}</span>
    </span>
  );
}
