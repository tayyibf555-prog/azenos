"use client";

import { useState } from "react";
import type { ReactNode } from "react";
import { relativeTime } from "../../../lib/format";
import { COLORS, humanize } from "../../ui";
import type { AnalyticsRange, FeedbackResponse, LabelledValue } from "../types";
import { Donut, HBars, Leaderboard, LineChart, topSegments } from "../charts";
import type { ChartPoint, DonutSegment } from "../charts";
import { StatGrid } from "../StatGrid";
import { StatTile } from "../StatTile";
import { ExpandableChart } from "../ExpandableChart";
import { Pill } from "../../system/Pill";
import type { SquircleTone } from "../../system/tokens";
import { ComingOnline, SectionFrame, SectionSkeleton, useSectionData } from "./_shell";

/**
 * FEEDBACK — the triage inbox for `feedback.submitted` events (Phase 7 §B),
 * mirrored into `feedback_items`. Split the same way Pulse/Bookings split
 * their contracts: `totalThisRange` / `prevRangeTotal` / `series` / `kindMix` /
 * `severityMix` are RANGE-scoped analytics (respect the shared range control);
 * `statusCounts` / `resolution` / `board` / `recentItems` /
 * `submitterLeaderboard` are a LIVE all-time snapshot of the triage backlog —
 * the queue you're clearing doesn't reset when someone flips to "7d", exactly
 * like Bookings' `upcoming`/`past` live counts.
 */

export type FeedbackKind = "bug" | "feature" | "question" | "praise" | "other";
export type FeedbackItemStatus = "new" | "seen" | "planned" | "done";

export interface FeedbackBoardItem {
  id: string;
  kind: FeedbackKind;
  severity: number | null;
  message: string;
  submitterName: string | null;
  submitterEmail: string | null;
  pageUrl: string | null;
  status: FeedbackItemStatus;
  createdAt: string;
}

export interface FeedbackData extends FeedbackResponse {
  /** the equal-length period immediately before the range, for the hero delta. */
  prevRangeTotal: number;
  kindMix: LabelledValue[];
  /** "Minor" / "Annoying" / "Blocking" / "Unspecified" over the range. */
  severityMix: LabelledValue[];
  /** all-time triage snapshot — column headers for the board. */
  statusCounts: Record<FeedbackItemStatus, number>;
  /** all-time done ÷ total; rate is null when there's nothing to resolve yet. */
  resolution: { done: number; total: number; rate: number | null };
  /** all-time, newest-first, capped per column (25). Always 4 columns, in order. */
  board: { status: FeedbackItemStatus; items: FeedbackBoardItem[] }[];
  /** all-time, newest-first across every status, capped at 20. */
  recentItems: FeedbackBoardItem[];
  /** all-time top submitters (name/email, or "Anonymous"), capped at 10. */
  submitterLeaderboard: LabelledValue[];
}

const RANGE_LABEL: Record<AnalyticsRange, string> = {
  "7d": "last 7 days",
  "30d": "last 30 days",
  "90d": "last 90 days",
};

/** Raw chart-mark colours — HBars/Donut segments and the StatTile hero tone. */
const KIND_COLOR: Record<FeedbackKind, string> = {
  bug: COLORS.red,
  feature: COLORS.blue,
  question: COLORS.violet,
  praise: COLORS.green,
  other: COLORS.grey,
};

/** RECIPE §2 tones (not raw hexes) — kind renders as a sanctioned pastel pill. */
const KIND_TONE: Record<FeedbackKind, SquircleTone> = {
  bug: "rose",
  feature: "sky",
  question: "butter",
  praise: "mint",
  other: "graphite",
};

const SEVERITY_COLOR: Record<string, string> = {
  Minor: COLORS.grey,
  Annoying: COLORS.amber,
  Blocking: COLORS.red,
  Unspecified: COLORS.grey,
};

const SEVERITY_TONE: Record<string, SquircleTone> = {
  Minor: "graphite",
  Annoying: "peach",
  Blocking: "rose",
  Unspecified: "graphite",
};

const STATUS_LABEL: Record<FeedbackItemStatus, string> = {
  new: "New",
  seen: "Seen",
  planned: "Planned",
  done: "Done",
};

const STATUS_COLOR: Record<FeedbackItemStatus, string> = {
  new: COLORS.blue,
  seen: COLORS.violet,
  planned: COLORS.amber,
  done: COLORS.green,
};

/** RECIPE §2 tones — the triage flow reads sky (new) → butter (seen, waiting)
 * → peach (planned, in progress) → mint (done). */
const STATUS_TONE: Record<FeedbackItemStatus, SquircleTone> = {
  new: "sky",
  seen: "butter",
  planned: "peach",
  done: "mint",
};

const STATUS_FLOW: FeedbackItemStatus[] = ["new", "seen", "planned", "done"];

const nf = (n: number): string => n.toLocaleString("en-GB");

function severityLabel(severity: number | null): string {
  if (severity === 3) return "Blocking";
  if (severity === 2) return "Annoying";
  if (severity === 1) return "Minor";
  return "Unspecified";
}

function Chip({
  tone,
  children,
  title,
}: {
  tone: SquircleTone;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span title={title}>
      <Pill tone={tone}>{children}</Pill>
    </span>
  );
}

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

export function FeedbackSection({
  projectId,
  range,
}: {
  projectId: string;
  range: AnalyticsRange;
}) {
  const state = useSectionData<FeedbackData>("feedback", projectId, range);

  return (
    <SectionFrame
      title="Feedback"
      subtitle="Bugs, feature requests and praise reported straight from the embeddable feedback widget."
    >
      {state.status === "loading" && <SectionSkeleton />}
      {state.status === "error" && (
        <ComingOnline note="Feedback is momentarily unavailable. It will reappear on the next refresh." />
      )}
      {state.status === "ready" && (
        <FeedbackBody projectId={projectId} data={state.data} range={range} />
      )}
    </SectionFrame>
  );
}

function FeedbackBody({
  projectId,
  data,
  range,
}: {
  projectId: string;
  data: FeedbackData;
  range: AnalyticsRange;
}) {
  const rangeLabel = RANGE_LABEL[range];
  const [board, setBoard] = useState(data.board);
  const [statusCounts, setStatusCounts] = useState(data.statusCounts);
  const [pending, setPending] = useState<string | null>(null);

  const liveTotal = STATUS_FLOW.reduce((s, k) => s + statusCounts[k], 0);
  if (liveTotal === 0 && data.recentItems.length === 0) {
    return (
      <ComingOnline note="No feedback yet — embed the widget from Setup to start collecting bugs, feature requests and praise from your client's team." />
    );
  }

  async function moveItem(itemId: string, to: FeedbackItemStatus) {
    let from: FeedbackItemStatus | null = null;
    let moved: FeedbackBoardItem | null = null;
    for (const col of board) {
      const hit = col.items.find((it) => it.id === itemId);
      if (hit) {
        from = col.status;
        moved = hit;
        break;
      }
    }
    if (!moved || from === to) return;

    setPending(itemId);
    // optimistic move
    setBoard((prev) =>
      prev.map((col) => {
        if (col.status === from) {
          return { ...col, items: col.items.filter((it) => it.id !== itemId) };
        }
        if (col.status === to) {
          return { ...col, items: [{ ...moved!, status: to }, ...col.items] };
        }
        return col;
      }),
    );
    setStatusCounts((prev) => ({
      ...prev,
      [from!]: Math.max(0, prev[from!] - 1),
      [to]: prev[to] + 1,
    }));

    try {
      const res = await fetch(
        `/api/projects/${projectId}/feedback/${itemId}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: to }),
        },
      );
      if (!res.ok) throw new Error("patch failed");
    } catch {
      // roll back on failure
      setBoard((prev) =>
        prev.map((col) => {
          if (col.status === to) {
            return { ...col, items: col.items.filter((it) => it.id !== itemId) };
          }
          if (col.status === from) {
            return { ...col, items: [{ ...moved!, status: from! }, ...col.items] };
          }
          return col;
        }),
      );
      setStatusCounts((prev) => ({
        ...prev,
        [to]: Math.max(0, prev[to] - 1),
        [from!]: prev[from!] + 1,
      }));
    } finally {
      setPending(null);
    }
  }

  const seriesPoints: ChartPoint[] = data.series.map((p) => ({
    periodStart: p.periodStart,
    value: p.value,
  }));
  const kindItems = data.kindMix.map((k) => ({
    label: humanize(k.label),
    value: k.value,
    color: KIND_COLOR[k.label as FeedbackKind] ?? COLORS.grey,
  }));
  const severitySegments: DonutSegment[] = data.severityMix.map((s) => ({
    label: s.label,
    value: s.value,
    color: SEVERITY_COLOR[s.label] ?? COLORS.grey,
  }));
  const resolutionPct =
    data.resolution.rate === null ? null : Math.round(data.resolution.rate * 100);
  const delta = data.totalThisRange - data.prevRangeTotal;
  const topSeverity = topSegments(severitySegments, 3);

  return (
    <div style={{ display: "grid", gap: 16 }}>
      {/* ── the numbers: range volume + full live triage snapshot ─────────── */}
      <StatGrid>
        <StatTile
          label={`Feedback in the ${rangeLabel}`}
          value={nf(data.totalThisRange)}
          delta={delta}
          deltaLabel={`${delta > 0 ? "+" : ""}${delta} vs prior ${rangeLabel}`}
          sub={`${nf(data.series.reduce((s, p) => s + p.value, 0))} submissions charted`}
          size="lg"
        />
        {STATUS_FLOW.map((s) => (
          <StatTile
            key={s}
            label={STATUS_LABEL[s]}
            value={nf(statusCounts[s])}
            tone={STATUS_COLOR[s]}
            sub="all-time"
          />
        ))}
        <StatTile
          label="Resolved"
          value={data.resolution.total > 0 ? `${resolutionPct}%` : "—"}
          tone={COLORS.green}
          sub={
            data.resolution.total > 0
              ? `${nf(data.resolution.done)}/${nf(data.resolution.total)} · all-time`
              : "Nothing resolved yet"
          }
        />
      </StatGrid>

      {/* ── daily volume + kind/severity mix ──────────────────────────────── */}
      <div
        style={{
          display: "grid",
          gap: 12,
          gridTemplateColumns: "minmax(0, 1.4fr) minmax(0, 1fr) minmax(0, 1fr)",
        }}
      >
        <div className="card" style={{ padding: 16, display: "grid", gap: 12, minWidth: 0 }}>
          <PanelTitle title="Daily volume" hint={`Feedback submitted per day · ${rangeLabel}`} />
          <ExpandableChart label="daily trend">
            {seriesPoints.filter((p) => p.value !== null).length >= 2 ? (
              <LineChart points={seriesPoints} color={COLORS.blue} unit="count" period="day" />
            ) : (
              <p className="faint" style={{ fontSize: 12.5, minHeight: 100, display: "grid", placeItems: "center" }}>
                Not enough days to plot a trend yet.
              </p>
            )}
          </ExpandableChart>
        </div>
        <div className="card" style={{ padding: 16, display: "grid", gap: 12, minWidth: 0 }}>
          <PanelTitle title="By kind" hint={rangeLabel} />
          <HBars items={kindItems} emptyLabel={`No feedback in the ${rangeLabel}.`} labelWidth={90} />
        </div>
        <div className="card" style={{ padding: 16, display: "grid", gap: 12, minWidth: 0 }}>
          <PanelTitle title="By severity" hint={`${rangeLabel} · bugs only carry a severity`} />
          {topSeverity.length === 0 ? (
            <span className="faint" style={{ fontSize: 12.5 }}>No feedback in the {rangeLabel}.</span>
          ) : (
            <HBars items={topSeverity} labelWidth={80} />
          )}
          <ExpandableChart label="severity ring">
            <Donut
              segments={severitySegments}
              centerLabel=""
              emptyLabel={`No feedback in the ${rangeLabel}.`}
            />
          </ExpandableChart>
        </div>
      </div>

      {/* ── triage board ────────────────────────────────────────────────────── */}
      <div className="card" style={{ padding: 16, display: "grid", gap: 12 }}>
        <PanelTitle title="Triage board" hint="Live backlog, all-time — drag isn't wired; use the arrow to advance a card." />
        <div
          style={{
            display: "grid",
            gap: 12,
            gridTemplateColumns: "repeat(4, minmax(200px, 1fr))",
            overflowX: "auto",
          }}
        >
          {board.map((col) => (
            <BoardColumn
              key={col.status}
              status={col.status}
              items={col.items}
              pendingId={pending}
              onAdvance={moveItem}
            />
          ))}
        </div>
      </div>

      {/* ── recent list + submitter leaderboard ─────────────────────────────── */}
      <div
        style={{
          display: "grid",
          gap: 12,
          gridTemplateColumns: "minmax(0, 1.4fr) minmax(0, 1fr)",
        }}
      >
        <div className="card" style={{ padding: 16, display: "grid", gap: 10, minWidth: 0 }}>
          <PanelTitle title="Recent submissions" hint="Newest 20, all-time, any status" />
          {data.recentItems.length === 0 ? (
            <p className="faint" style={{ fontSize: 12.5 }}>Nothing submitted yet.</p>
          ) : (
            <div style={{ display: "grid", gap: 2 }}>
              {data.recentItems.map((it) => (
                <RecentRow key={it.id} item={it} />
              ))}
            </div>
          )}
        </div>
        <div className="card" style={{ padding: 16, display: "grid", gap: 12, minWidth: 0 }}>
          <PanelTitle title="Top submitters" hint="All-time, by name or email" />
          <Leaderboard
            rows={data.submitterLeaderboard.map((r) => ({ label: r.label, value: r.value }))}
            emptyLabel="No named submitters yet."
          />
        </div>
      </div>
    </div>
  );
}

function BoardColumn({
  status,
  items,
  pendingId,
  onAdvance,
}: {
  status: FeedbackItemStatus;
  items: FeedbackBoardItem[];
  pendingId: string | null;
  onAdvance: (itemId: string, to: FeedbackItemStatus) => void;
}) {
  const idx = STATUS_FLOW.indexOf(status);
  const next = STATUS_FLOW[idx + 1];
  return (
    <div style={{ display: "grid", gap: 8, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span
          style={{ width: 7, height: 7, borderRadius: "50%", background: STATUS_COLOR[status], flex: "none" }}
        />
        <span style={{ fontSize: 12, fontWeight: 620 }}>{STATUS_LABEL[status]}</span>
        <span className="faint tnum" style={{ fontSize: 11 }}>{items.length}</span>
      </div>
      <div style={{ display: "grid", gap: 8 }}>
        {items.length === 0 ? (
          <span className="faint" style={{ fontSize: 11.5, padding: "4px 2px" }}>Empty</span>
        ) : (
          items.map((it) => (
            <div
              key={it.id}
              className="card"
              style={{ padding: 10, display: "grid", gap: 6, background: "var(--card-2)" }}
            >
              <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                <Chip tone={KIND_TONE[it.kind]}>{humanize(it.kind)}</Chip>
                {it.severity !== null && (
                  <Chip tone={SEVERITY_TONE[severityLabel(it.severity)] ?? "graphite"}>
                    {severityLabel(it.severity)}
                  </Chip>
                )}
              </div>
              <span
                style={{
                  fontSize: 12,
                  lineHeight: 1.35,
                  display: "-webkit-box",
                  WebkitLineClamp: 3,
                  WebkitBoxOrient: "vertical",
                  overflow: "hidden",
                }}
                title={it.message}
              >
                {it.message}
              </span>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <span className="faint" style={{ fontSize: 10.5 }}>
                  {it.submitterName ?? it.submitterEmail ?? "Anonymous"} · {relativeTime(it.createdAt)}
                </span>
                {next && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    disabled={pendingId === it.id}
                    onClick={() => onAdvance(it.id, next)}
                    title={`Move to ${STATUS_LABEL[next]}`}
                    style={{ padding: "0 8px", height: 22, fontSize: 10.5 }}
                  >
                    → {STATUS_LABEL[next]}
                  </button>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function RecentRow({ item }: { item: FeedbackBoardItem }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 6px",
        borderRadius: 8,
      }}
      title={item.message}
    >
      <Chip tone={KIND_TONE[item.kind]}>{humanize(item.kind)}</Chip>
      {item.severity !== null && (
        <Chip tone={SEVERITY_TONE[severityLabel(item.severity)] ?? "graphite"}>
          {severityLabel(item.severity)}
        </Chip>
      )}
      <span
        style={{
          flex: 1,
          fontSize: 12.5,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {item.message}
      </span>
      {item.pageUrl && (
        <span className="faint" style={{ fontSize: 11, flex: "none", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {item.pageUrl.replace(/^https?:\/\//, "")}
        </span>
      )}
      <Chip tone={STATUS_TONE[item.status]}>{STATUS_LABEL[item.status]}</Chip>
      <span className="faint tnum" style={{ fontSize: 11, flex: "none", width: 64, textAlign: "right" }}>
        {relativeTime(item.createdAt)}
      </span>
    </div>
  );
}
