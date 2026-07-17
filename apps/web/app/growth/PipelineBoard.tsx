"use client";

import { Pill } from "../../components/system/Pill";
import type { SquircleTone } from "../../components/system/tokens";
import { formatPence, formatLondonDate } from "../../lib/format";
import type { PipelineItem } from "../../components/growth-types";

/** RECIPE §3: confidence reads as a tinted pill, not a bespoke hex badge. */
function confidenceTone(c: string): SquircleTone {
  switch (c) {
    case "high":
      return "mint";
    case "med":
    case "medium":
      return "butter";
    default:
      return "rose";
  }
}

/**
 * The opportunity pipeline (left): automation_opportunity / upsell insights in
 * play. Each card can be Reviewed (owner acknowledges), Converted (runs the
 * Upsell Engine → a draft proposal), or Dismissed. Reviewed cards get a subtle
 * marker; converting removes the card (it becomes a proposal).
 */
export function PipelineBoard({
  items,
  busy,
  onReview,
  onDismiss,
  onConvert,
}: {
  items: PipelineItem[];
  busy: Record<string, string | undefined>;
  onReview: (id: string) => void;
  onDismiss: (id: string) => void;
  onConvert: (id: string) => void;
}) {
  return (
    <section className="card" style={{ padding: 0 }}>
      <div
        style={{
          padding: "14px 18px",
          borderRadius: "var(--radius-card) var(--radius-card) 0 0",
          background: "var(--bg-well)",
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
        }}
      >
        <h3 style={{ fontSize: 14, fontWeight: 620 }}>
          Opportunity pipeline{" "}
          <span className="faint tnum" style={{ fontWeight: 400 }}>
            · {items.length} open
          </span>
        </h3>
        <span className="faint" style={{ fontSize: 11.5 }}>
          review → convert to proposal
        </span>
      </div>

      {items.length === 0 ? (
        <div className="empty" style={{ padding: "34px 24px" }}>
          <span className="empty-title">No open opportunities</span>
          <span style={{ fontSize: 13 }}>
            The Opportunity Scout surfaces automation opportunities here as it
            finds them.
          </span>
        </div>
      ) : (
        <div style={{ display: "grid", gap: 2, padding: "6px 6px" }}>
          {items.map((it, i) => {
            const tone = confidenceTone(it.confidence);
            const b = busy[it.id];
            const reviewed = it.status === "reviewed";
            return (
              <article
                key={it.id}
                style={{
                  padding: "12px 12px",
                  borderRadius: "var(--radius-tile)",
                  background: i % 2 === 1 ? "var(--bg-well)" : "transparent",
                  display: "grid",
                  gap: 8,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    justifyContent: "space-between",
                    gap: 12,
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 600 }}>{it.title}</div>
                    <div className="faint" style={{ fontSize: 11.5, marginTop: 2 }}>
                      {it.clientName} · {it.projectName} · {formatLondonDate(it.createdAt)}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 6, flex: "none" }}>
                    {reviewed && <Pill tone="sky">reviewed</Pill>}
                    <Pill tone={tone}>{it.confidence}</Pill>
                  </div>
                </div>

                {it.bodyMd && (
                  <p
                    className="muted"
                    style={{ fontSize: 12.5, lineHeight: 1.5, whiteSpace: "pre-wrap" }}
                  >
                    {it.bodyMd}
                  </p>
                )}

                <div className="mono faint tnum" style={{ fontSize: 11 }}>
                  {it.estimatedValuePence !== null &&
                    `~${formatPence(it.estimatedValuePence)}/mo value`}
                  {it.estimatedHoursSavedMonthly !== null &&
                    ` · ~${it.estimatedHoursSavedMonthly}h/mo saved`}
                  {it.evidenceEventCount > 0 &&
                    ` · ${it.evidenceEventCount} evidence event${it.evidenceEventCount === 1 ? "" : "s"}`}
                </div>

                <div style={{ display: "flex", gap: 8, marginTop: 2 }}>
                  <button
                    type="button"
                    className="btn btn-sm btn-primary"
                    disabled={Boolean(b)}
                    onClick={() => onConvert(it.id)}
                  >
                    {b === "convert" ? "Converting…" : "Convert to proposal"}
                  </button>
                  {!reviewed && (
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      disabled={Boolean(b)}
                      onClick={() => onReview(it.id)}
                    >
                      {b === "review" ? "…" : "Review"}
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    disabled={Boolean(b)}
                    onClick={() => onDismiss(it.id)}
                  >
                    Dismiss
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
