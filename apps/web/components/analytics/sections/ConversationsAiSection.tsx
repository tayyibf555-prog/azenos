"use client";

import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { COLORS, humanize, tint } from "../../ui";
import { TINTS } from "../../system/tokens";
import { Pill } from "../../system/Pill";
import type {
  AnalyticsRange,
  ConversationsAiResponse,
  LabelledValue,
  SeriesPoint,
} from "../types";
import {
  Donut,
  HBars,
  Leaderboard,
  LineChart,
  MiniTrend,
  topSegments,
} from "../charts";
import type { ChartPoint } from "../charts";
import { StatGrid } from "../StatGrid";
import { StatTile } from "../StatTile";
import { ExpandableChart } from "../ExpandableChart";
import { ComingOnline, SectionFrame, SectionSkeleton, useSectionData } from "./_shell";

/**
 * CONVERSATIONS & AI — the co-pilot brain.
 *
 * Reads the rich wire shape the conversations-ai endpoint returns (a superset
 * of the foundation `ConversationsAiResponse`; the extra fields are declared
 * here so both this section and the endpoint read from one source of truth —
 * the endpoint `import type`s these). Panels: conversation quality
 * (resolution / escalation / abandonment / deflection), sentiment mix + trend,
 * intent distribution, then the headline QUESTION INTELLIGENCE — a ranked,
 * searchable list of what end-users actually ask, with a this-week-vs-last-week
 * trend, dominant sentiment, and a content-gap callout. Everything degrades to
 * a calm empty-state; nothing throws on a project with no conversations.
 */

/** A daily ratio series where ÷0 buckets are gaps (null), for the LineChart. */
export interface RatioPoint {
  periodStart: string;
  value: number | null;
}

export interface SentimentDay {
  periodStart: string;
  positive: number;
  neutral: number;
  negative: number;
}

export interface QuestionRow {
  /** the representative end-user question text. */
  question: string;
  /** times asked over the selected range. */
  count: number;
  /** asked in the most-recent 7 days. */
  thisWeek: number;
  /** asked in the 7 days before that. */
  lastWeek: number;
  trend: "up" | "down" | "flat" | "new";
  sentiment: "positive" | "neutral" | "negative" | "mixed";
  /** 0..1 — share of this question's conversations that escalated to a human. */
  escalationRate: number;
  /** 0..1 — share with negative sentiment. */
  negativeRate: number;
  /** flagged: asked repeatedly but escalates or sours — a content gap. */
  contentGap: boolean;
}

export interface TopicRow {
  title: string;
  count: number;
  sharePct: number;
  /** 'up' | 'down' | 'flat' | 'new' | '' from the clustering agent. */
  trend: string;
}

export interface ConversationsAiData extends ConversationsAiResponse {
  resolvedCount: number;
  escalatedCount: number;
  abandonedCount: number;
  abandonmentRate: number | null;
  /** share handled without a human hand-off, 0..1. */
  deflectionRate: number | null;
  avgTurns: number | null;
  avgDurationSeconds: number | null;
  volumeSeries: SeriesPoint[];
  resolutionSeries: RatioPoint[];
  sentimentMix: { positive: number; neutral: number; negative: number };
  sentimentTrend: SentimentDay[];
  intents: LabelledValue[];
  /** every mined question, ranked by frequency (desc). */
  questions: QuestionRow[];
  /** the flagged subset, worst-first. */
  contentGaps: QuestionRow[];
  /** total question occurrences mined across all sources. */
  questionsTracked: number;
  topics: TopicRow[];
  /** P9-PACK2 additive: resolved AND turns <= 3, out of all conversations in window. */
  fcr: { rate: number | null; count: number; total: number };
  /** P9-PACK2 additive: top intents of ESCALATED conversations — root-cause hint. */
  escalationClusters: LabelledValue[];
  /** P9-PACK2 additive: top-6 intents × sentiment mini-matrix. */
  sentimentByTopic: SentimentTopicRow[];
}

/** P9-PACK2 additive: one row of the sentiment-by-topic mini-matrix. */
export interface SentimentTopicRow {
  intent: string;
  positive: number;
  neutral: number;
  negative: number;
}

const RANGE_LABEL: Record<AnalyticsRange, string> = {
  "7d": "last 7 days",
  "30d": "last 30 days",
  "90d": "last 90 days",
};

const nf = (n: number): string => n.toLocaleString("en-GB");
const pct = (r: number | null): string =>
  r === null ? "—" : `${Math.round(r * 100)}%`;

/** Seconds → compact "4m 12s" / "48s" / "1h 3m". */
function formatDuration(seconds: number | null): string {
  if (seconds === null || seconds <= 0) return "—";
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm > 0 ? `${h}h ${mm}m` : `${h}h`;
}

const SENTIMENT_COLOR: Record<QuestionRow["sentiment"], string> = {
  positive: COLORS.green,
  neutral: COLORS.grey,
  negative: COLORS.red,
  mixed: COLORS.amber,
};

export function ConversationsAiSection({
  projectId,
  range,
}: {
  projectId: string;
  range: AnalyticsRange;
}) {
  const state = useSectionData<ConversationsAiData>(
    "conversations-ai",
    projectId,
    range,
  );

  return (
    <SectionFrame
      title="Conversations & AI"
      subtitle="What end-users ask the co-pilot, how well it resolves them, and where the content gaps are."
    >
      {state.status === "loading" && <SectionSkeleton />}
      {state.status === "error" && (
        <ComingOnline note="Conversation intelligence is momentarily unavailable. It will reappear on the next refresh." />
      )}
      {state.status === "ready" && <ConversationsBody data={state.data} range={range} />}
    </SectionFrame>
  );
}

function ConversationsBody({
  data,
  range,
}: {
  data: ConversationsAiData;
  range: AnalyticsRange;
}) {
  const rangeLabel = RANGE_LABEL[range];

  if (data.totalConversations === 0 && data.questionsTracked === 0) {
    return (
      <ComingOnline
        note={`No AI conversations recorded in the ${rangeLabel}. Once the co-pilot handles questions, resolution quality, sentiment and the top-questions list appear here.`}
      />
    );
  }

  const volumeValues = data.volumeSeries.map((p) => p.value);
  const volumePoints: ChartPoint[] = data.volumeSeries.map((p) => ({
    periodStart: p.periodStart,
    value: p.value,
  }));
  const resolutionPoints: ChartPoint[] = data.resolutionSeries.map((p) => ({
    periodStart: p.periodStart,
    // resolution ratio → percent for a readable axis.
    value: p.value === null ? null : Math.round(p.value * 100),
  }));
  const negativeSpark = data.sentimentTrend.map((d) => d.negative);

  const sentimentSegments = [
    { label: "Positive", value: data.sentimentMix.positive, color: COLORS.green },
    { label: "Neutral", value: data.sentimentMix.neutral, color: COLORS.grey },
    { label: "Negative", value: data.sentimentMix.negative, color: COLORS.red },
  ];
  const topSentiment = topSegments(sentimentSegments, 3);
  const intentItems = data.intents.map((i) => ({
    label: humanize(i.label),
    value: i.value,
  }));

  return (
    <div style={{ display: "grid", gap: 16 }}>
      {/* ── the numbers: volume + full quality strip ─────────────────────────── */}
      <StatGrid>
        <StatTile
          label="AI conversations"
          value={nf(data.totalConversations)}
          sub={`handled in the ${rangeLabel}`}
          sparkline={volumeValues}
          size="lg"
        />
        <StatTile
          label="Resolved"
          value={pct(data.resolutionRate)}
          tone={COLORS.green}
          sub={`${nf(data.resolvedCount)} end-to-end`}
        />
        <StatTile
          label="Escalated"
          value={pct(data.escalationRate)}
          tone={data.escalatedCount > 0 ? COLORS.amber : undefined}
          sub={`${nf(data.escalatedCount)} to a human`}
        />
        <StatTile
          label="Abandoned"
          value={pct(data.abandonmentRate)}
          tone={data.abandonedCount > 0 ? COLORS.red : undefined}
          sub={`${nf(data.abandonedCount)} dropped`}
        />
        <StatTile
          label="Deflection"
          value={pct(data.deflectionRate)}
          tone={COLORS.green}
          sub="no human needed"
        />
        <StatTile
          label="Avg turns"
          value={data.avgTurns === null ? "—" : String(data.avgTurns)}
          sub={`${formatDuration(data.avgDurationSeconds)} avg`}
        />
      </StatGrid>

      {/* ── volume + resolution trend — numbers already above; lines behind an expand ── */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
          gap: 16,
        }}
      >
        <div className="card" style={{ padding: 18, display: "grid", gap: 14 }}>
          <PanelTitle title="Conversation volume" hint="AI conversations per day" />
          <ExpandableChart label="daily trend">
            {volumePoints.length >= 2 ? (
              <LineChart points={volumePoints} color={COLORS.teal} unit="count" period="day" />
            ) : (
              <NotEnough />
            )}
          </ExpandableChart>
        </div>
        <div className="card" style={{ padding: 18, display: "grid", gap: 14 }}>
          <PanelTitle title="Resolution rate" hint="Share resolved without a human, per day" />
          <ExpandableChart label="daily trend">
            {resolutionPoints.filter((p) => p.value !== null).length >= 2 ? (
              <LineChart points={resolutionPoints} color={COLORS.green} unit="percent" period="day" />
            ) : (
              <NotEnough />
            )}
          </ExpandableChart>
        </div>
      </div>

      {/* ── sentiment + intent — top value + top-3, ring behind an expand ─────── */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
          gap: 16,
        }}
      >
        <div className="card" style={{ padding: 18, display: "grid", gap: 14 }}>
          <PanelTitle title="Sentiment mix" hint="How conversations feel to end-users" />
          {topSentiment.length === 0 ? (
            <p className="faint" style={{ fontSize: 12.5 }}>No sentiment captured in this range yet.</p>
          ) : (
            <>
              <StatTile
                label="Dominant sentiment"
                value={topSentiment[0]!.label}
                deltaLabel={`${nf(topSentiment[0]!.value)} conversations`}
                tone={topSentiment[0]!.color}
              />
              <HBars items={topSentiment} labelWidth={90} />
            </>
          )}
          {negativeSpark.some((v) => v > 0) && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
                // RECIPE T1: spacing separates this sub-row, not a hairline.
                marginTop: 4,
                paddingTop: 10,
              }}
            >
              <span className="faint" style={{ fontSize: 11.5 }}>
                Negative sentiment over time
              </span>
              <MiniTrend values={negativeSpark} color={COLORS.red} width={64} height={22} />
            </div>
          )}
          <ExpandableChart label="sentiment ring">
            <Donut
              segments={sentimentSegments}
              centerLabel=""
              emptyLabel="No sentiment captured in this range yet."
            />
          </ExpandableChart>
        </div>
        <div className="card" style={{ padding: 18, display: "grid", gap: 14 }}>
          <PanelTitle title="Why they reach out" hint="Intent distribution over the range" />
          <HBars
            items={intentItems}
            emptyLabel="No intents captured in this range yet."
            labelWidth={140}
          />
        </div>
      </div>

      {/* ── content gaps callout ───────────────────────────────────────────── */}
      {data.contentGaps.length > 0 && <ContentGaps gaps={data.contentGaps} />}

      {/* ── question intelligence (headline) ───────────────────────────────── */}
      <QuestionIntelligence
        questions={data.questions}
        tracked={data.questionsTracked}
        rangeLabel={rangeLabel}
      />

      {/* P9-PACK2 additive — first-contact resolution + escalation root-cause + sentiment×topic */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
          gap: 16,
        }}
      >
        <div className="card" style={{ padding: 18, display: "grid", gap: 14 }}>
          <PanelTitle
            title="First-contact resolution"
            hint="Resolved in 3 turns or fewer, no human hand-off"
          />
          <StatGrid minTileWidth={140}>
            <StatTile
              label="FCR rate"
              value={pct(data.fcr.rate)}
              tone={COLORS.green}
              sub={`${nf(data.fcr.count)} of ${nf(data.fcr.total)}`}
              size="lg"
            />
          </StatGrid>
        </div>
        <div className="card" style={{ padding: 18, display: "grid", gap: 14 }}>
          <PanelTitle title="Escalation root causes" hint="Top intents among escalated conversations" />
          <HBars
            items={data.escalationClusters.map((c) => ({ label: humanize(c.label), value: c.value }))}
            emptyLabel="No escalations in this range yet."
            labelWidth={140}
          />
        </div>
      </div>

      {data.sentimentByTopic.length > 0 && (
        <div className="card" style={{ padding: 18, display: "grid", gap: 12 }}>
          <PanelTitle title="Sentiment by topic" hint="Top intents split by how they felt to end-users" />
          <SentimentTopicMatrix rows={data.sentimentByTopic} />
        </div>
      )}

      {/* ── topic clusters (from the clustering agent) ─────────────────────── */}
      {data.topics.length > 0 && (
        <div className="card" style={{ padding: 18, display: "grid", gap: 12 }}>
          <PanelTitle
            title="Question topics"
            hint="Clusters the weekly agent grouped from these conversations"
          />
          <Leaderboard
            rows={data.topics.slice(0, 8).map((t) => ({
              label: t.title,
              value: t.count,
              sub:
                t.sharePct > 0
                  ? `${Math.round(t.sharePct)}%${trendGlyph(t.trend)}`
                  : trendGlyph(t.trend).trim() || undefined,
            }))}
            emptyLabel="No topic clusters yet."
          />
        </div>
      )}
    </div>
  );
}

// ── Question intelligence panel ──────────────────────────────────────────────

function QuestionIntelligence({
  questions,
  tracked,
  rangeLabel,
}: {
  questions: QuestionRow[];
  tracked: number;
  rangeLabel: string;
}) {
  const [q, setQ] = useState("");
  const term = q.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      term
        ? questions.filter((row) => row.question.toLowerCase().includes(term))
        : questions,
    [questions, term],
  );
  const max = questions.reduce((m, row) => Math.max(m, row.count), 0) || 1;
  const shown = filtered.slice(0, 40);

  return (
    <div className="card" style={{ padding: 18, display: "grid", gap: 14 }}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <PanelTitle
          title="Top questions"
          hint={`${nf(tracked)} questions mined from conversations in the ${rangeLabel}`}
        />
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search questions…"
          aria-label="Search questions"
          className="input"
          style={{ fontSize: 12.5, maxWidth: 220, padding: "6px 10px" }}
        />
      </div>

      {questions.length === 0 ? (
        <p className="faint" style={{ fontSize: 12.5 }}>
          No end-user questions captured yet. Send the co-pilot&rsquo;s questions with{" "}
          <span className="mono">os.track(&quot;llm.conversation&quot;, {"{"} data: {"{"} question {"}"} {"}"})</span>{" "}
          to light this up.
        </p>
      ) : shown.length === 0 ? (
        <p className="faint" style={{ fontSize: 12.5 }}>
          No questions match &ldquo;{q}&rdquo;.
        </p>
      ) : (
        <div style={{ display: "grid", gap: 2 }}>
          {shown.map((row, i) => (
            <QuestionRowItem key={`${row.question}-${i}`} row={row} rank={i + 1} max={max} />
          ))}
        </div>
      )}
    </div>
  );
}

function QuestionRowItem({
  row,
  rank,
  max,
}: {
  row: QuestionRow;
  rank: number;
  max: number;
}) {
  const dot = SENTIMENT_COLOR[row.sentiment];
  return (
    <div
      style={{
        position: "relative",
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "9px 10px",
        borderRadius: 8,
        overflow: "hidden",
      }}
      title={row.question}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          width: `${(row.count / max) * 100}%`,
          background: tint(row.contentGap ? COLORS.amber : COLORS.teal, 0.1),
        }}
      />
      <span
        className="tnum faint"
        style={{ position: "relative", flex: "none", width: 20, fontSize: 12 }}
      >
        {rank}
      </span>
      <span
        style={{
          position: "relative",
          flex: "none",
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: dot,
        }}
        title={`${humanize(row.sentiment)} sentiment`}
      />
      <span
        style={{
          position: "relative",
          flex: 1,
          fontSize: 13,
          fontWeight: 500,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {row.question}
      </span>
      {row.contentGap && (
        <span style={{ position: "relative" }}>
          <Pill tone="peach">gap</Pill>
        </span>
      )}
      <TrendArrow trend={row.trend} />
      <span
        className="tnum"
        style={{ position: "relative", flex: "none", width: 40, textAlign: "right", fontSize: 13, fontWeight: 600 }}
      >
        {nf(row.count)}
      </span>
    </div>
  );
}

function TrendArrow({ trend }: { trend: QuestionRow["trend"] }) {
  if (trend === "new") {
    return (
      <span style={{ position: "relative" }}>
        <Pill tone="sky">new</Pill>
      </span>
    );
  }
  const glyph = trend === "up" ? "▲" : trend === "down" ? "▼" : "→";
  const color =
    trend === "up" ? COLORS.blue : trend === "down" ? COLORS.grey : COLORS.grey;
  return (
    <span
      className="tnum"
      style={{ position: "relative", flex: "none", width: 16, textAlign: "center", fontSize: 11, color }}
      title={`Asked ${trend === "up" ? "more" : trend === "down" ? "less" : "about the same"} this week vs last`}
    >
      {glyph}
    </span>
  );
}

// ── Content gaps callout ─────────────────────────────────────────────────────

function ContentGaps({ gaps }: { gaps: QuestionRow[] }) {
  // RECIPE T4: a whole-card pastel wash (peach = "attention"), not a
  // borrowed-COLORS.amber hairline wash — the tint itself is the separation
  // from its white siblings, with rows sitting in the tone's deeper wash.
  const t = TINTS.peach;
  return (
    <div
      style={{
        padding: 18,
        display: "grid",
        gap: 12,
        borderRadius: "var(--radius-card)",
        background: t.bg,
      }}
    >
      <div style={{ display: "grid", gap: 3 }}>
        <span style={{ fontSize: 13.5, fontWeight: 640, color: t.fg }}>
          Content gaps · {gaps.length}
        </span>
        <span style={{ fontSize: 12, color: t.fg, opacity: 0.72 }}>
          Questions people ask often but the co-pilot handles poorly — it escalates
          or sours sentiment. Prime candidates for a knowledge-base update.
        </span>
      </div>
      <div style={{ display: "grid", gap: 6 }}>
        {gaps.map((g, i) => (
          <div
            key={`${g.question}-${i}`}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: "8px 10px",
              borderRadius: "var(--radius-tile)",
              background: t.pill,
            }}
            title={g.question}
          >
            <span
              style={{
                flex: 1,
                fontSize: 12.5,
                fontWeight: 520,
                color: t.fg,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {g.question}
            </span>
            {g.escalationRate > 0 && (
              <span className="tnum" style={{ fontSize: 11, color: t.fg, opacity: 0.8 }}>
                {pct(g.escalationRate)} escalate
              </span>
            )}
            {g.negativeRate > 0 && (
              <span className="tnum" style={{ fontSize: 11, color: COLORS.red }}>
                {pct(g.negativeRate)} negative
              </span>
            )}
            <span className="tnum" style={{ flex: "none", fontSize: 12.5, fontWeight: 600, color: t.fg }}>
              {nf(g.count)}×
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── P9-PACK2 · sentiment-by-topic mini-matrix ────────────────────────────────

function SentimentTopicMatrix({ rows }: { rows: SentimentTopicRow[] }) {
  return (
    <div style={{ overflowX: "auto", maxWidth: "100%" }}>
      {/* RECIPE — the sanctioned .table class (globals.css): row separation is
          hover-highlight only, never a hairline divider. */}
      <table className="table" style={{ minWidth: 380 }}>
        <thead>
          <tr style={{ textAlign: "right" }}>
            <th style={{ textAlign: "left" }}>Topic</th>
            <th style={{ color: COLORS.green }}>Positive</th>
            <th>Neutral</th>
            <th style={{ color: COLORS.red }}>Negative</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.intent} style={{ textAlign: "right" }}>
              <td style={{ textAlign: "left", fontWeight: 540 }}>
                {humanize(row.intent)}
              </td>
              <td className="tnum" style={{ color: COLORS.green }}>
                {nf(row.positive)}
              </td>
              <td className="tnum muted">
                {nf(row.neutral)}
              </td>
              <td className="tnum" style={{ color: COLORS.red }}>
                {nf(row.negative)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── small shared bits ────────────────────────────────────────────────────────

function PanelTitle({ title, hint }: { title: string; hint?: string }) {
  return (
    <div style={{ display: "grid", gap: 2 }}>
      <span className="muted" style={{ fontSize: 12.5, fontWeight: 600 }}>
        {title}
      </span>
      {hint && (
        <span className="faint" style={{ fontSize: 11.5 }}>
          {hint}
        </span>
      )}
    </div>
  );
}

function NotEnough(): ReactNode {
  return (
    <p
      className="faint"
      style={{ fontSize: 12.5, minHeight: 120, display: "grid", placeItems: "center" }}
    >
      Not enough days to plot a trend yet.
    </p>
  );
}

/** Small trailing glyph for a cluster's own trend token. */
function trendGlyph(trend: string): string {
  if (trend === "up") return " ▲";
  if (trend === "down") return " ▼";
  if (trend === "new") return " ·new";
  return "";
}
