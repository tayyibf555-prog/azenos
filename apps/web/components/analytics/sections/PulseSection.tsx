"use client";

import type { ReactNode } from "react";
import { formatLondonTime, relativeTime } from "../../../lib/format";
import type { GoalPacingResult } from "../../../lib/server/pacing";
import { COLORS, humanize } from "../../ui";
import { Pill } from "../../system/Pill";
import { healthTone, type SquircleTone } from "../../system/tokens";
import type { AnalyticsRange, PulseResponse } from "../types";
import {
  BigStat,
  Donut,
  HBars,
  Heatmap,
  LineChart,
  topHeatmapCells,
  topSegments,
  type BandPoint,
} from "../charts";
import { StatGrid } from "../StatGrid";
import { StatTile } from "../StatTile";
import { ExpandableChart } from "../ExpandableChart";
import { SectionFrame, SectionSkeleton, useSectionData } from "./_shell";

/**
 * Rich Pulse wire contract. Extends the foundation-guaranteed `PulseResponse`
 * (range / from / to / totalEvents / activeDays / series preserved) with the
 * live-health payload the Pulse endpoint computes. Defined here so both the
 * endpoint (`import type`) and this section read from one source of truth.
 */
export interface PulseData extends PulseResponse {
  /** all events ever recorded for this project — the hero "spine" number. */
  spineTotal: number;
  /** project health tone: "green" | "amber" | "red" | anything → grey. */
  health: string;
  liveness: {
    status: "up" | "degraded" | "down";
    /** ISO instant of the most-recent event, or null when the spine is empty. */
    lastEventAt: string | null;
    /** ISO instant of the freshest agent.heartbeat, or null. */
    lastHeartbeatAt: string | null;
    /** minutes since the most-recent event. */
    lastEventAgeMinutes: number | null;
    /** minutes since the freshest of (event, heartbeat) — drives the verdict. */
    freshestAgeMinutes: number | null;
  };
  counts: {
    today: number;
    last7d: number;
    prev7d: number;
    last30d: number;
    prev30d: number;
  };
  /** London weekday (1=Mon…7=Sun) × hour (0-23) event counts over the window. */
  heatmap: { weekday: number; hour: number; value: number }[];
  /** taxonomy-category segments (already ordered, descending) for the donut. */
  mix: { label: string; color: string; value: number }[];
  /** raw per-type counts over the window. */
  typeMix: { type: string; count: number }[];
  /**
   * P9-PACK1 additive: pace-vs-target for each of the project's declared
   * goals (empty when the project has none). Optional so existing fixtures
   * built before this field existed keep typechecking.
   */
  pacing?: GoalPacingResult[];
  /**
   * P9-PACK1 additive: a deterministic 7-day forecast band (±1 stddev of the
   * trailing-28-day regression's residuals) continuing the daily-volume
   * chart — null when there isn't enough signal to project responsibly
   * (see lib/server/forecast.ts). Optional for the same fixture-compat reason.
   */
  forecast?: { points: BandPoint[] } | null;
}

/**
 * RECIPE §3 tone (not a raw hex) — liveness renders as a sanctioned pastel
 * pill (system Pill) instead of a hand-rolled tint() wash.
 */
const LIVENESS: Record<
  PulseData["liveness"]["status"],
  { label: string; tone: SquircleTone }
> = {
  up: { label: "Live", tone: "mint" },
  degraded: { label: "Degraded", tone: "butter" },
  down: { label: "Silent", tone: "rose" },
};

const PACING_PERIOD_LABEL: Record<GoalPacingResult["period"], string> = {
  day: "today",
  week: "this week",
  month: "this month",
};

/** Compact number formatter for pacing tile bodies — no long decimal tails. */
function paceNum(n: number): string {
  return n.toLocaleString("en-GB", { maximumFractionDigits: 1 });
}

/** P9-PACK1 additive: one goal's pace-vs-target as a numbers-first tile. */
function PacingTile({ goal }: { goal: GoalPacingResult }) {
  const pctText = goal.pacePct === null ? "—" : `${Math.round(goal.pacePct)}%`;
  const tone = goal.pacePct === null ? undefined : goal.onPace ? COLORS.green : COLORS.red;
  return (
    <StatTile
      label={`${humanize(goal.metric)} · ${PACING_PERIOD_LABEL[goal.period]}`}
      value={pctText}
      tone={tone}
      delta={goal.pacePct === null ? null : goal.onPace ? 1 : -1}
      deltaLabel={goal.pacePct === null ? "period just started" : goal.onPace ? "on pace" : "behind pace"}
      sub={`${paceNum(goal.actualToDate)} / ${paceNum(goal.target)} to date`}
    />
  );
}

function CardTitle({ children }: { children: ReactNode }) {
  return (
    <span className="muted" style={{ fontSize: 12.5, fontWeight: 600 }}>
      {children}
    </span>
  );
}

const RANGE_LABEL: Record<AnalyticsRange, string> = {
  "7d": "last 7 days",
  "30d": "last 30 days",
  "90d": "last 90 days",
};

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** Compact day label ("17 Jun") from a YYYY-MM-DD London day key. */
function dayLabel(key: string): string {
  const [, m, d] = key.split("-").map(Number);
  return `${d} ${MONTHS[(m ?? 1) - 1]}`;
}

export function PulseSection({
  projectId,
  range,
}: {
  projectId: string;
  range: AnalyticsRange;
}) {
  const state = useSectionData<PulseData>("pulse", projectId, range);

  return (
    <SectionFrame
      title="Pulse"
      subtitle="The live health of this project's event spine — is data still flowing, and how loud?"
    >
      {state.status === "loading" ? (
        <SectionSkeleton />
      ) : state.status === "error" ? (
        <div
          className="card"
          style={{ padding: 24, display: "grid", placeItems: "center", textAlign: "center" }}
        >
          <span className="empty-title">Pulse unavailable</span>
          <span className="faint" style={{ fontSize: 12.5, marginTop: 4 }}>
            Couldn&rsquo;t read the spine right now. It&rsquo;ll reappear on the next refresh.
          </span>
        </div>
      ) : (
        <PulseBody data={state.data} range={range} />
      )}
    </SectionFrame>
  );
}

export function PulseBody({ data, range }: { data: PulseData; range: AnalyticsRange }) {
  const live = LIVENESS[data.liveness.status];
  const rangeLabel = RANGE_LABEL[range];
  const lastEvent = data.liveness.lastEventAt;

  const seriesValues = data.series.map((p) => p.value);
  const topMix = topSegments(data.mix, 3);
  const topSlots = topHeatmapCells(data.heatmap, 3);

  return (
    <div style={{ display: "grid", gap: 16 }}>
      {/* ── hero: spine total + liveness / health ─────────────────────────── */}
      <div
        className="glass-strong"
        style={{
          padding: 20,
          display: "flex",
          flexWrap: "wrap",
          gap: 20,
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <BigStat
          label="Events in the spine"
          value={data.spineTotal.toLocaleString("en-GB")}
          sub="captured since inception"
        />
        <div style={{ display: "grid", gap: 8, justifyItems: "end" }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
            <Pill tone={live.tone}>{live.label}</Pill>
            <Pill tone={healthTone(data.health)}>{humanize(data.health)} health</Pill>
          </div>
          <span className="faint tnum" style={{ fontSize: 11.5, textAlign: "right" }}>
            {lastEvent
              ? `Last event ${relativeTime(lastEvent)} · ${formatLondonTime(lastEvent)}`
              : "No events recorded yet"}
          </span>
          {data.liveness.lastHeartbeatAt && (
            <span className="faint tnum" style={{ fontSize: 11.5, textAlign: "right" }}>
              Agent heartbeat {relativeTime(data.liveness.lastHeartbeatAt)}
            </span>
          )}
        </div>
      </div>

      {/* ── the numbers: fixed period counts + window totals ───────────────── */}
      <StatGrid>
        {/* Rolling instant-window counts (now()-7d / now()-30d) carry no
            sparkline: the only per-day series available is the selected-range
            CALENDAR window, a different window than these rolling counts, so
            slicing it would depict a shorter/other span than the number it
            annotates. */}
        <StatTile label="Today" value={data.counts.today.toLocaleString("en-GB")} />
        <StatTile
          label="Last 7 days"
          value={data.counts.last7d.toLocaleString("en-GB")}
          delta={data.counts.last7d - data.counts.prev7d}
          sub="vs prior 7d"
        />
        <StatTile
          label="Last 30 days"
          value={data.counts.last30d.toLocaleString("en-GB")}
          delta={data.counts.last30d - data.counts.prev30d}
          sub="vs prior 30d"
        />
        <StatTile
          label={`Events · ${rangeLabel}`}
          value={data.totalEvents.toLocaleString("en-GB")}
          sub={`${dayLabel(data.from)}–${dayLabel(data.to)}`}
          sparkline={seriesValues}
        />
        <StatTile
          label="Active days"
          value={data.activeDays.toLocaleString("en-GB")}
          sub={rangeLabel}
        />
      </StatGrid>

      {/* ── goal pacing (P9-PACK1 additive) — pace vs target, numbers-first ── */}
      {data.pacing && data.pacing.length > 0 && (
        <div className="card" style={{ padding: 16, display: "grid", gap: 12, minWidth: 0 }}>
          <CardTitle>Goal pacing</CardTitle>
          <StatGrid minTileWidth={170}>
            {data.pacing.map((g) => (
              <PacingTile key={`${g.metric}-${g.period}`} goal={g} />
            ))}
          </StatGrid>
        </div>
      )}

      {/* ── daily volume — numbers first, chart behind an expand ───────────── */}
      <div className="card" style={{ padding: 16, display: "grid", gap: 12, minWidth: 0 }}>
        <CardTitle>Daily volume</CardTitle>
        <ExpandableChart
          label="daily chart"
          hint={
            <span className="faint tnum" style={{ fontSize: 11.5 }}>
              {data.totalEvents.toLocaleString("en-GB")} events · {data.activeDays} active{" "}
              {data.activeDays === 1 ? "day" : "days"} · {dayLabel(data.from)}–{dayLabel(data.to)}
              {data.forecast && data.forecast.points.length > 0 ? " · dashed = 7-day projection" : ""}
            </span>
          }
        >
          <LineChart
            points={data.series}
            band={data.forecast?.points ?? null}
            color={COLORS.blue}
            unit="count"
            period="day"
          />
        </ExpandableChart>
      </div>

      {/* ── event mix — top category + top-3, ring behind an expand ───────── */}
      <div className="card" style={{ padding: 16, display: "grid", gap: 12, minWidth: 0 }}>
        <CardTitle>Event mix</CardTitle>
        {topMix.length === 0 ? (
          <span className="faint" style={{ fontSize: 12.5 }}>No events in the {rangeLabel}.</span>
        ) : (
          <>
            <StatTile
              label="Top category"
              value={topMix[0]!.label}
              deltaLabel={`${topMix[0]!.value.toLocaleString("en-GB")} events`}
              tone={topMix[0]!.color}
            />
            <HBars
              items={topMix.map((m) => ({ label: m.label, value: m.value, color: m.color }))}
              labelWidth={120}
            />
          </>
        )}
        <ExpandableChart label="mix ring">
          <Donut
            segments={data.mix}
            centerLabel=""
            emptyLabel={`No events in the ${rangeLabel}.`}
          />
        </ExpandableChart>
      </div>

      {/* ── activity rhythm — busiest slot + top-3, grid behind an expand ──── */}
      <div className="card" style={{ padding: 16, display: "grid", gap: 12 }}>
        <CardTitle>Activity rhythm</CardTitle>
        {topSlots.length === 0 ? (
          <span className="faint" style={{ fontSize: 12.5 }}>
            No activity to map in the {rangeLabel} yet.
          </span>
        ) : (
          <>
            <StatTile
              label="Busiest slot"
              value={topSlots[0]!.label}
              deltaLabel={`${topSlots[0]!.value.toLocaleString("en-GB")} events`}
            />
            <HBars items={topSlots} labelWidth={90} />
          </>
        )}
        <ExpandableChart
          label="hour × weekday grid"
          hint={
            <span className="faint" style={{ fontSize: 11.5 }}>
              London hour × weekday · {rangeLabel}
            </span>
          }
        >
          <Heatmap
            cells={data.heatmap}
            emptyLabel={`No activity to map in the ${rangeLabel} yet.`}
          />
        </ExpandableChart>
      </div>
    </div>
  );
}
