"use client";

import { COLORS, tint } from "../../components/ui";
import { formatPence, formatLondonDate } from "../../lib/format";
import type { PipelineItem } from "../../components/growth-types";

function confidenceColor(c: string): string {
  switch (c) {
    case "high":
      return COLORS.green;
    case "med":
    case "medium":
      return COLORS.amber;
    default:
      return COLORS.grey;
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
          borderBottom: "1px solid var(--border)",
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
        }}
      >
        <h3 style={{ fontSize: 14 }}>
          Opportunity pipeline{" "}
          <span className="faint" style={{ fontWeight: 400 }}>
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
        <div style={{ display: "grid", gap: 0 }}>
          {items.map((it, i) => {
            const tone = confidenceColor(it.confidence);
            const b = busy[it.id];
            const reviewed = it.status === "reviewed";
            return (
              <article
                key={it.id}
                style={{
                  padding: "14px 18px",
                  borderTop: i === 0 ? "none" : "1px solid var(--border)",
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
                    {reviewed && (
                      <span
                        className="badge"
                        style={{
                          color: COLORS.blue,
                          background: tint(COLORS.blue, 0.12),
                          borderColor: tint(COLORS.blue, 0.28),
                        }}
                      >
                        reviewed
                      </span>
                    )}
                    <span
                      className="badge"
                      style={{
                        color: tone,
                        background: tint(tone, 0.12),
                        borderColor: tint(tone, 0.28),
                      }}
                    >
                      {it.confidence}
                    </span>
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

                <div className="mono faint" style={{ fontSize: 11 }}>
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
                    className="btn btn-sm"
                    disabled={Boolean(b)}
                    onClick={() => onConvert(it.id)}
                    style={{
                      color: "#0b0e14",
                      background: COLORS.green,
                      borderColor: COLORS.green,
                    }}
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
