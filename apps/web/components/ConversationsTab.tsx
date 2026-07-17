"use client";

import { useEffect, useState } from "react";
import { LineChart } from "./charts/LineChart";
import { COLORS, tint } from "./ui";
import { formatLondonTime } from "../lib/format";

/**
 * Conversations tab (docs/phase5/CONTRACTS.md §P5-CONVO). Reads the read-only
 * `/api/projects/:id/conversations` endpoint and renders: resolution/escalation
 * stat cards, a daily volume LineChart, a sentiment-mix bar, and the FAQ-cluster
 * cards (topic, share, trend arrow, Scout flag) with an expandable
 * example-conversation drill-down. Every fetch fails quietly to an inline note —
 * the tab never crashes on a 404 or an empty clustering result.
 */

interface ConversationExample {
  eventId: string;
  occurredAt: string;
  channel: string | null;
  intent: string | null;
  resolution: string | null;
  sentiment: string | null;
  summary: string | null;
}

interface TopicCluster {
  id: string;
  title: string;
  bodyMd: string;
  confidence: string;
  status: string;
  createdAt: string;
  count: number;
  sharePct: number;
  trend: string;
  scoutCandidate: boolean;
  exampleEventIds: string[];
  examples: ConversationExample[];
}

interface ConversationsResponse {
  from: string;
  to: string;
  totalConversations: number;
  resolution: {
    resolved: number;
    escalated: number;
    abandoned: number;
    total: number;
  };
  resolutionRate: number | null;
  escalationRate: number | null;
  volumeSeries: { periodStart: string; value: number }[];
  sentimentMix: { positive: number; neutral: number; negative: number };
  topics: TopicCluster[];
}

type State =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; data: ConversationsResponse };

const pct = (v: number | null): string =>
  v === null ? "—" : `${(v * 100).toFixed(1)}%`;

function trendArrow(trend: string): { glyph: string; color: string; label: string } {
  switch (trend) {
    case "up":
      return { glyph: "▲", color: COLORS.green, label: "up vs last week" };
    case "down":
      return { glyph: "▼", color: COLORS.red, label: "down vs last week" };
    case "new":
      return { glyph: "✦", color: COLORS.violet, label: "new this week" };
    case "flat":
      return { glyph: "▬", color: COLORS.grey, label: "flat vs last week" };
    default:
      return { glyph: "", color: COLORS.grey, label: "" };
  }
}

const SENTIMENT_COLORS: Record<string, string> = {
  positive: COLORS.green,
  neutral: COLORS.grey,
  negative: COLORS.red,
};

export function ConversationsTab({ projectId }: { projectId: string }) {
  const [state, setState] = useState<State>({ status: "loading" });
  const [open, setOpen] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let alive = true;
    setState({ status: "loading" });
    fetch(`/api/projects/${projectId}/conversations`, { cache: "no-store" })
      .then(async (res) => {
        const json = (await res.json()) as ConversationsResponse | { error: string };
        if (!alive) return;
        if (!res.ok || "error" in json) {
          setState({ status: "error" });
          return;
        }
        setState({ status: "ready", data: json });
      })
      .catch(() => {
        if (alive) setState({ status: "error" });
      });
    return () => {
      alive = false;
    };
  }, [projectId]);

  if (state.status === "loading") {
    return (
      <div style={{ display: "grid", gap: 22 }}>
        <div className="skeleton" style={{ height: 74 }} />
        <div className="skeleton" style={{ height: 260 }} />
        <div className="skeleton" style={{ height: 160 }} />
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className="card empty">
        <span className="empty-title">Couldn&apos;t load conversations</span>
        <span style={{ fontSize: 13 }}>
          This project may have no conversation events yet.
        </span>
      </div>
    );
  }

  const { data } = state;
  const { resolution, sentimentMix } = data;
  const sentimentTotal =
    sentimentMix.positive + sentimentMix.neutral + sentimentMix.negative;

  return (
    <div style={{ display: "grid", gap: 22 }}>
      {/* ── stat strip ── */}
      <div style={{ display: "grid", gap: 10 }}>
        <div
          className="faint"
          style={{ fontSize: 11.5, display: "flex", alignItems: "center", gap: 6 }}
        >
          <span style={{ fontWeight: 600 }}>Overview</span>
          <span>· {data.from} → {data.to}</span>
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
            gap: 14,
          }}
        >
        <StatBox label="Conversations" value={data.totalConversations.toLocaleString("en-GB")} />
        <StatBox label="Resolution rate" value={pct(data.resolutionRate)} tone={COLORS.green} />
        <StatBox label="Escalation rate" value={pct(data.escalationRate)} tone={COLORS.amber} />
        <StatBox
          label="Resolved / escalated / abandoned"
          value={`${resolution.resolved} · ${resolution.escalated} · ${resolution.abandoned}`}
        />
        </div>
      </div>

      {/* ── volume line chart ── */}
      <section className="card" style={{ padding: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
          <span className="dot" style={{ background: COLORS.blue }} />
          <span style={{ fontSize: 13.5, fontWeight: 600 }}>Conversation volume</span>
          <span className="faint" style={{ fontSize: 11.5 }}>
            {data.from} → {data.to} · daily
          </span>
        </div>
        {data.volumeSeries.length < 2 ? (
          <div
            className="faint"
            style={{ height: 200, display: "grid", placeItems: "center", fontSize: 13 }}
          >
            Not enough days to plot yet.
          </div>
        ) : (
          <LineChart
            points={data.volumeSeries.map((p) => ({
              periodStart: p.periodStart,
              value: p.value,
            }))}
            color={COLORS.blue}
            unit="count"
            period="day"
          />
        )}
      </section>

      {/* ── sentiment mix ── */}
      <section className="card" style={{ padding: 16 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 12 }}>Sentiment mix</div>
        {sentimentTotal === 0 ? (
          <div className="faint" style={{ fontSize: 13 }}>No sentiment recorded in this window.</div>
        ) : (
          <div style={{ display: "grid", gap: 10 }}>
            <div
              style={{
                display: "flex",
                height: 12,
                borderRadius: "var(--radius-pill)",
                overflow: "hidden",
                background: "var(--card-2)",
              }}
            >
              {(["positive", "neutral", "negative"] as const).map((k) => {
                const v = sentimentMix[k];
                if (v === 0) return null;
                return (
                  <div
                    key={k}
                    title={`${k}: ${v}`}
                    style={{
                      width: `${(v / sentimentTotal) * 100}%`,
                      background: SENTIMENT_COLORS[k],
                    }}
                  />
                );
              })}
            </div>
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
              {(["positive", "neutral", "negative"] as const).map((k) => (
                <span key={k} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
                  <span className="dot" style={{ background: SENTIMENT_COLORS[k] }} />
                  <span style={{ textTransform: "capitalize" }}>{k}</span>
                  <span className="faint">
                    {sentimentMix[k]} ({((sentimentMix[k] / sentimentTotal) * 100).toFixed(0)}%)
                  </span>
                </span>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* ── FAQ clusters ── */}
      <section className="card" style={{ padding: 0 }}>
        <div style={{ padding: "14px 18px 4px" }}>
          <h3 style={{ fontSize: 14 }}>
            FAQ clusters{" "}
            <span className="faint" style={{ fontWeight: 400 }}>
              · {data.topics.length}
            </span>
          </h3>
          <div className="faint" style={{ fontSize: 11.5, marginTop: 2 }}>
            Rolling 7-day window — topic shares below are “% of the week”, a
            tighter lens than the {data.from} → {data.to} overview above.
          </div>
        </div>
        {data.topics.length === 0 ? (
          <div className="empty" style={{ padding: "30px 24px" }}>
            <span className="empty-title">No clusters yet</span>
            <span style={{ fontSize: 13 }}>
              The clustering agent groups this project&apos;s conversations into FAQ
              clusters each day. Run it once conversations have landed.
            </span>
          </div>
        ) : (
          <div style={{ display: "grid" }}>
            {data.topics.map((t) => {
              const arrow = trendArrow(t.trend);
              const isOpen = open[t.id] === true;
              return (
                <article
                  key={t.id}
                  style={{
                    padding: "14px 18px",
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
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ fontSize: 13.5, fontWeight: 600 }}>{t.title}</span>
                        {arrow.glyph && (
                          <span title={arrow.label} style={{ color: arrow.color, fontSize: 11 }}>
                            {arrow.glyph}
                          </span>
                        )}
                        {t.scoutCandidate && (
                          <span
                            className="badge"
                            title="Flagged as unautomated repetition — a Scout candidate"
                            style={{
                              color: COLORS.orange,
                              background: tint(COLORS.orange, 0.12),
                            }}
                          >
                            automate
                          </span>
                        )}
                      </div>
                      <div className="faint" style={{ fontSize: 11.5, marginTop: 2 }}>
                        {t.count.toLocaleString("en-GB")} conversations · {t.sharePct.toFixed(1)}% of the week
                      </div>
                    </div>
                    <span
                      className="badge"
                      style={{
                        flex: "none",
                        color: COLORS.blue,
                        background: tint(COLORS.blue, 0.12),
                      }}
                    >
                      {t.confidence}
                    </span>
                  </div>

                  {t.bodyMd && (
                    <p
                      className="muted"
                      style={{ fontSize: 12.5, lineHeight: 1.5, whiteSpace: "pre-wrap" }}
                    >
                      {t.bodyMd}
                    </p>
                  )}

                  {t.examples.length > 0 && (
                    <div>
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        onClick={() =>
                          setOpen((o) => ({ ...o, [t.id]: !o[t.id] }))
                        }
                      >
                        {isOpen ? "Hide" : `Show ${t.examples.length} example`}
                        {t.examples.length === 1 ? "" : "s"}
                      </button>
                      {isOpen && (
                        <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
                          {t.examples.map((ex) => (
                            <div
                              key={ex.eventId}
                              style={{
                                padding: "10px 12px",
                                borderRadius: "var(--radius-tile)",
                                background: "var(--bg-well)",
                                display: "grid",
                                gap: 4,
                              }}
                            >
                              <div style={{ fontSize: 12.5 }}>
                                {ex.summary ?? ex.intent ?? "(no summary)"}
                              </div>
                              <div className="faint mono" style={{ fontSize: 10.5 }}>
                                {[
                                  formatLondonTime(ex.occurredAt),
                                  ex.channel,
                                  ex.resolution,
                                  ex.sentiment,
                                ]
                                  .filter(Boolean)
                                  .join(" · ")}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

function StatBox({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: string;
}) {
  return (
    <div className="card" style={{ padding: "14px 16px" }}>
      <div className="faint" style={{ fontSize: 11.5 }}>
        {label}
      </div>
      <div
        style={{
          fontSize: 22,
          fontWeight: 660,
          letterSpacing: "-0.02em",
          marginTop: 6,
          color: tone,
        }}
      >
        {value}
      </div>
    </div>
  );
}
