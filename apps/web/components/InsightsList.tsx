"use client";

import { useEffect, useState } from "react";
import { COLORS, tint } from "./ui";
import { formatLondonTime } from "../lib/format";
import type {
  ApiErrorShape,
  EvidenceEvent,
  InsightItem,
  InsightsResponse,
} from "./metrics-types";

type State =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; insights: InsightItem[] };

function confidenceColor(confidence: string): string {
  switch (confidence) {
    case "high":
      return COLORS.red;
    case "med":
    case "medium":
      return COLORS.amber;
    default:
      return COLORS.grey;
  }
}

function evidenceSummary(evidence: Record<string, unknown>): string {
  if (!evidence || typeof evidence !== "object") return "";
  const parts: string[] = [];
  const push = (k: string, label: string, digits = 2) => {
    const v = evidence[k];
    if (typeof v === "number" && Number.isFinite(v)) {
      parts.push(`${label} ${v.toFixed(digits)}`);
    }
  };
  if (typeof evidence["metric_key"] === "string") {
    parts.push(String(evidence["metric_key"]));
  }
  push("value", "value");
  push("mean", "mean");
  push("std", "σ");
  push("z", "z");
  const ids = evidence["event_ids"];
  if (Array.isArray(ids) && ids.length > 0) {
    parts.push(`${ids.length} events`);
  }
  return parts.join(" · ");
}

/**
 * Evidence drill-down (§P6-SCOUT): an inline expander that maps an insight's
 * cited event ids → the actual events (id, type, occurred time), resolved by the
 * insights API. A reviewer can click "N events" to verify an opportunity is
 * grounded in real events. Silent when an insight cites no events (e.g. an
 * unused-taxonomy opportunity, whose evidence is a documented absence).
 */
function EvidenceDrilldown({ insight }: { insight: InsightItem }) {
  const [open, setOpen] = useState(false);
  const events: EvidenceEvent[] = insight.evidenceEvents ?? [];
  const rawIds = insight.evidence?.["event_ids"];
  const citedCount = Array.isArray(rawIds) ? rawIds.length : 0;
  if (citedCount === 0) return null;

  return (
    <div>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        style={{ fontSize: 11.5, padding: "2px 8px" }}
      >
        {open ? "▾" : "▸"} {citedCount} evidence event{citedCount === 1 ? "" : "s"}
      </button>
      {open && (
        <div
          style={{
            marginTop: 8,
            border: "1px solid var(--border)",
            borderRadius: 8,
            overflow: "hidden",
          }}
        >
          {events.length === 0 ? (
            <div
              className="faint"
              style={{ fontSize: 11.5, padding: "8px 10px" }}
            >
              The cited events are no longer available.
            </div>
          ) : (
            events.map((ev, i) => (
              <div
                key={ev.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 12,
                  padding: "7px 10px",
                  borderTop: i === 0 ? "none" : "1px solid var(--border)",
                }}
              >
                <span className="mono" style={{ fontSize: 11.5 }}>
                  {ev.type}
                </span>
                <span className="faint" style={{ fontSize: 11 }}>
                  {formatLondonTime(ev.occurredAt)}
                </span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Open-insights list (§Metrics UI Overview upgrade): anomaly / insight cards
 * with Review + Dismiss actions that PATCH the insight and optimistically drop
 * it from the list. Quiet empty and error states.
 */
export function InsightsList({ projectId }: { projectId: string }) {
  const [state, setState] = useState<State>({ status: "loading" });
  const [busy, setBusy] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let alive = true;
    setState({ status: "loading" });
    fetch(`/api/projects/${projectId}/insights?status=new`, {
      cache: "no-store",
    })
      .then(async (res) => {
        const json = (await res.json()) as InsightsResponse | ApiErrorShape;
        if (!alive) return;
        if (!res.ok || "error" in json) {
          setState({ status: "error" });
          return;
        }
        setState({ status: "ready", insights: json.insights ?? [] });
      })
      .catch(() => {
        if (alive) setState({ status: "error" });
      });
    return () => {
      alive = false;
    };
  }, [projectId]);

  async function act(id: string, status: "reviewed" | "dismissed") {
    if (state.status !== "ready" || busy[id]) return;
    const prev = state.insights;
    setBusy((b) => ({ ...b, [id]: true }));
    // optimistic remove
    setState({ status: "ready", insights: prev.filter((i) => i.id !== id) });
    try {
      const res = await fetch(`/api/insights/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) {
        // roll back on failure
        setState({ status: "ready", insights: prev });
      }
    } catch {
      setState({ status: "ready", insights: prev });
    } finally {
      setBusy((b) => {
        const next = { ...b };
        delete next[id];
        return next;
      });
    }
  }

  if (state.status === "loading") {
    return (
      <section className="card" style={{ padding: 18 }}>
        <div className="skeleton" style={{ height: 16, width: 140 }} />
        <div className="skeleton" style={{ height: 48, marginTop: 12 }} />
      </section>
    );
  }

  if (state.status === "error") {
    return null;
  }

  if (state.insights.length === 0) {
    return (
      <section className="card" style={{ padding: 0 }}>
        <div
          style={{ padding: "14px 18px", borderBottom: "1px solid var(--border)" }}
        >
          <h3 style={{ fontSize: 14 }}>Insights</h3>
        </div>
        <div className="empty" style={{ padding: "30px 24px" }}>
          <span className="empty-title">No open insights</span>
          <span style={{ fontSize: 13 }}>
            Anomalies the metrics engine spots will surface here.
          </span>
        </div>
      </section>
    );
  }

  return (
    <section className="card" style={{ padding: 0 }}>
      <div
        style={{ padding: "14px 18px", borderBottom: "1px solid var(--border)" }}
      >
        <h3 style={{ fontSize: 14 }}>
          Insights{" "}
          <span className="faint" style={{ fontWeight: 400 }}>
            · {state.insights.length} open
          </span>
        </h3>
      </div>
      <div style={{ display: "grid", gap: 0 }}>
        {state.insights.map((ins, i) => {
          const tone = confidenceColor(ins.confidence);
          const summary = evidenceSummary(ins.evidence);
          return (
            <article
              key={ins.id}
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
                  <div style={{ fontSize: 13.5, fontWeight: 600 }}>
                    {ins.title}
                  </div>
                  <div className="faint" style={{ fontSize: 11.5, marginTop: 2 }}>
                    {ins.kind} · {formatLondonTime(ins.createdAt)}
                  </div>
                </div>
                <span
                  className="badge"
                  style={{
                    flex: "none",
                    color: tone,
                    background: tint(tone, 0.12),
                    borderColor: tint(tone, 0.28),
                  }}
                >
                  {ins.confidence}
                </span>
              </div>

              {ins.bodyMd && (
                <p
                  className="muted"
                  style={{
                    fontSize: 12.5,
                    lineHeight: 1.5,
                    whiteSpace: "pre-wrap",
                  }}
                >
                  {ins.bodyMd}
                </p>
              )}

              {summary && (
                <div className="mono faint" style={{ fontSize: 11 }}>
                  {summary}
                </div>
              )}

              <EvidenceDrilldown insight={ins} />

              <div style={{ display: "flex", gap: 8, marginTop: 2 }}>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={busy[ins.id]}
                  onClick={() => act(ins.id, "reviewed")}
                >
                  Review
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  disabled={busy[ins.id]}
                  onClick={() => act(ins.id, "dismissed")}
                >
                  Dismiss
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
