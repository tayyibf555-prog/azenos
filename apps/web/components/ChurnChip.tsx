/**
 * Churn-risk chip (docs/phase9/CONTRACTS.md §P9-KB). A numbers-first pill: the
 * 0-100 churn score + its band, coloured green/amber/red. Additive presentation
 * over lib/server/churn.ts — the maths lives there, this only renders. Reasons
 * (top contributors) become the tooltip so the owner sees WHY at a glance.
 */

import type { ChurnBand } from "../lib/server/churn";
import { TINTS, type SquircleTone } from "./system";

const BAND_TONE: Record<ChurnBand, SquircleTone> = {
  healthy: "mint",
  watch: "butter",
  risk: "rose",
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
  const t = TINTS[BAND_TONE[band]];
  const title =
    reasons.length > 0
      ? `Churn risk ${score}/100 — ${reasons.join(" · ")}`
      : `Churn risk ${score}/100 — ${BAND_LABEL[band]}`;
  const fontSize = size === "sm" ? 11.5 : 12.5;
  return (
    <span
      title={title}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        height: 22,
        padding: "0 10px",
        borderRadius: "var(--radius-pill)",
        color: t.fg,
        background: t.bg,
        fontSize,
        fontWeight: 600,
        flex: "none",
      }}
    >
      <span
        aria-hidden
        style={{ width: 6, height: 6, borderRadius: "50%", background: t.fg }}
      />
      <span className="tnum">{score}</span>
      <span style={{ fontWeight: 500, opacity: 0.85 }}>{BAND_LABEL[band]}</span>
    </span>
  );
}
