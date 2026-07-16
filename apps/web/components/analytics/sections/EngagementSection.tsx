"use client";

import type {
  AnalyticsRange,
  EngagementResponse,
  LabelledValue,
  SeriesPoint,
} from "../types";
import { COLORS, humanize } from "../../ui";
import {
  Donut,
  HBars,
  Heatmap,
  LineChart,
  intensityColor,
  topHeatmapCells,
  topSegments,
} from "../charts";
import type { ChartPoint } from "../charts";
import { StatGrid } from "../StatGrid";
import { StatTile } from "../StatTile";
import { ExpandableChart } from "../ExpandableChart";
import { ComingOnline, SectionFrame, SectionSkeleton, useSectionData } from "./_shell";

/**
 * ENGAGEMENT & USAGE — how much the client's end-users actually use the system.
 *
 * Reads the richer wire shape the engagement endpoint returns (a superset of
 * the foundation `EngagementResponse`; the extra fields are declared here to
 * mirror the route without importing server code). Every panel degrades to a
 * calm empty-state — nothing throws on a project with no events.
 */
interface EngagementData extends EngagementResponse {
  totalConversations: number;
  uniqueUsers: number;
  newUsers: number;
  returningUsers: number;
  sessions: number;
  avgTurns: number | null;
  avgSessionSeconds: number | null;
  inboundMessages: number;
  outboundMessages: number;
  channelMix: LabelledValue[];
  activeUsersSeries: SeriesPoint[];
  logins: number;
  hasLoginEvents: boolean;
  retentionCohorts: RetentionCohortRow[];
  retentionWeek1Pct: number | null;
  retentionWeek4Pct: number | null;
  channelShift: ChannelShiftRow[];
}

interface RetentionCohortCell {
  offset: number;
  activeCount: number;
  activePct: number | null;
}
interface RetentionCohortRow {
  block: number;
  blockStart: string;
  cohortSize: number;
  cells: RetentionCohortCell[];
}
interface ChannelShiftRow {
  label: string;
  currentPct: number;
  priorPct: number;
  deltaPct: number;
}

const RANGE_LABEL: Record<AnalyticsRange, string> = {
  "7d": "last 7 days",
  "30d": "last 30 days",
  "90d": "last 90 days",
};

const nf = (n: number): string => n.toLocaleString("en-GB");

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

export function EngagementSection({
  projectId,
  range,
}: {
  projectId: string;
  range: AnalyticsRange;
}) {
  const state = useSectionData<EngagementData>("engagement", projectId, range);

  return (
    <SectionFrame
      title="Engagement & Usage"
      subtitle="How much the client's end-users lean on the system — who, how often, through which channel, and when."
    >
      {state.status === "loading" && <SectionSkeleton />}
      {state.status === "error" && (
        <ComingOnline note="Engagement data is momentarily unavailable. It will reappear on the next refresh." />
      )}
      {state.status === "ready" && <EngagementBody data={state.data} range={range} />}
    </SectionFrame>
  );
}

function EngagementBody({ data, range }: { data: EngagementData; range: AnalyticsRange }) {
  const rangeLabel = RANGE_LABEL[range];
  const activeUserValues = data.activeUsersSeries.map((p) => p.value);
  const linePoints: ChartPoint[] = data.activeUsersSeries.map((p) => ({
    periodStart: p.periodStart,
    value: p.value,
  }));
  const channelSegments = data.channelMix.map((c) => ({
    label: humanize(c.label),
    value: c.value,
  }));
  const topChannels = topSegments(channelSegments, 3);
  const topSlots = topHeatmapCells(data.heatmap, 3);
  const topEventItems = data.topEvents.map((e) => ({
    label: humanize(e.label),
    value: e.value,
  }));

  const newReturnTotal = data.newUsers + data.returningUsers;
  const newPct = newReturnTotal > 0 ? Math.round((data.newUsers / newReturnTotal) * 100) : null;
  const returningPct = newReturnTotal > 0 ? Math.round((data.returningUsers / newReturnTotal) * 100) : null;

  if (data.totalEvents === 0) {
    return (
      <ComingOnline note={`No end-user activity recorded in the ${rangeLabel}. Once events flow in, usage rhythms, channel mix and active users appear here.`} />
    );
  }

  return (
    <div style={{ display: "grid", gap: 16 }}>
      {/* the numbers — every headline aggregate the endpoint computes */}
      <StatGrid>
        <StatTile
          label="Unique end-users"
          value={nf(data.uniqueUsers)}
          sub={`active in the ${rangeLabel}`}
          sparkline={activeUserValues}
          size="lg"
        />
        <StatTile label="Conversations" value={nf(data.totalConversations)} />
        <StatTile
          label="Sessions"
          value={nf(data.sessions)}
          sub={data.avgTurns !== null ? `${data.avgTurns} turns avg` : undefined}
        />
        <StatTile label="Avg session length" value={formatDuration(data.avgSessionSeconds)} />
        <StatTile label="Inbound" value={nf(data.inboundMessages)} sub="messages & calls in" />
        <StatTile label="Outbound" value={nf(data.outboundMessages)} sub="messages & emails out" />
        <StatTile
          label="New users"
          value={nf(data.newUsers)}
          sub={newPct !== null ? `${newPct}% of active` : undefined}
        />
        <StatTile
          label="Returning users"
          value={nf(data.returningUsers)}
          sub={returningPct !== null ? `${returningPct}% of active` : undefined}
        />
        {data.hasLoginEvents && (
          <StatTile label="Logins" value={nf(data.logins)} sub="login / session events" />
        )}
      </StatGrid>

      {/* channel mix — top channel + top-3, ring behind an expand */}
      <div className="card" style={{ padding: 18, display: "grid", gap: 14 }}>
        <PanelTitle title="Channel mix" hint="Where conversations, messages, calls and email land" />
        {topChannels.length === 0 ? (
          <p className="faint" style={{ fontSize: 12.5 }}>No channelled activity in this range yet.</p>
        ) : (
          <>
            <StatTile
              label="Top channel"
              value={topChannels[0]!.label}
              deltaLabel={`${nf(topChannels[0]!.value)} events`}
            />
            <HBars items={topChannels} labelWidth={130} />
          </>
        )}
        <ExpandableChart label="channel ring">
          <Donut
            segments={channelSegments}
            centerLabel=""
            emptyLabel="No channelled activity in this range yet."
          />
        </ExpandableChart>
      </div>

      {/* active users trend — numbers first, line behind an expand */}
      <div className="card" style={{ padding: 18, display: "grid", gap: 14 }}>
        <PanelTitle title="Active users" hint="Distinct end-users each day" />
        <ExpandableChart label="daily trend">
          {linePoints.length >= 2 ? (
            <LineChart points={linePoints} color={COLORS.teal} unit="count" period="day" />
          ) : (
            <p
              className="faint"
              style={{ fontSize: 12.5, minHeight: 120, display: "grid", placeItems: "center" }}
            >
              Not enough days to plot a trend yet.
            </p>
          )}
        </ExpandableChart>
      </div>

      {/* busiest times — top slot + top-3, grid behind an expand */}
      <div className="card" style={{ padding: 18, display: "grid", gap: 14 }}>
        <PanelTitle title="When activity happens" hint="End-user events by weekday × hour (Europe/London)" />
        {topSlots.length === 0 ? (
          <p className="faint" style={{ fontSize: 12.5 }}>No activity to map in this range yet.</p>
        ) : (
          <>
            <StatTile
              label="Busiest slot"
              value={topSlots[0]!.label}
              deltaLabel={`${nf(topSlots[0]!.value)} events`}
            />
            <HBars items={topSlots} labelWidth={90} />
          </>
        )}
        <ExpandableChart label="hour × weekday grid">
          <Heatmap cells={data.heatmap} />
        </ExpandableChart>
      </div>

      {/* top event types — already a ranked list; stays as-is */}
      <div className="card" style={{ padding: 18, display: "grid", gap: 14 }}>
        <PanelTitle title="Most-fired event types" hint={`Top ${topEventItems.length} in the ${rangeLabel}`} />
        <HBars items={topEventItems} emptyLabel="No events in this range yet." labelWidth={190} />
      </div>

      {/* P9-PACK2 additive — retention cohorts (fixed 8-week lookback, not range-bound) */}
      <RetentionPanel
        cohorts={data.retentionCohorts}
        week1Pct={data.retentionWeek1Pct}
        week4Pct={data.retentionWeek4Pct}
      />

      {/* P9-PACK2 additive — channel-shift vs the prior equal window */}
      <ChannelShiftPanel rows={data.channelShift} />
    </div>
  );
}

// ── P9-PACK2 · retention cohorts ─────────────────────────────────────────────

function RetentionPanel({
  cohorts,
  week1Pct,
  week4Pct,
}: {
  cohorts: RetentionCohortRow[];
  week1Pct: number | null;
  week4Pct: number | null;
}) {
  const hasData = cohorts.some((c) => c.cohortSize > 0);
  return (
    <div className="card" style={{ padding: 18, display: "grid", gap: 14 }}>
      <PanelTitle
        title="Retention cohorts"
        hint="End-users grouped by the week they first showed up, tracked in the weeks after"
      />
      {!hasData ? (
        <p className="faint" style={{ fontSize: 12.5 }}>
          No new end-users tracked in the last 8 weeks yet.
        </p>
      ) : (
        <>
          <StatGrid minTileWidth={150}>
            <StatTile
              label="Week 1 retention"
              value={week1Pct === null ? "—" : `${week1Pct}%`}
              sub="still active 1 week after first seen"
            />
            <StatTile
              label="Week 4 retention"
              value={week4Pct === null ? "—" : `${week4Pct}%`}
              sub="still active 4 weeks after first seen"
            />
          </StatGrid>
          <ExpandableChart label="retention triangle">
            <RetentionTriangle cohorts={cohorts} />
          </ExpandableChart>
        </>
      )}
    </div>
  );
}

/** 8×8 triangle heatmap: rows = cohort week, columns = weeks since first seen. */
function RetentionTriangle({ cohorts }: { cohorts: RetentionCohortRow[] }) {
  const byBlock = new Map(cohorts.map((c) => [c.block, c]));
  return (
    <div style={{ overflowX: "auto", maxWidth: "100%" }}>
      <div style={{ display: "grid", gap: 4, minWidth: 480 }}>
        {Array.from({ length: 8 }, (_, block) => {
          const row = byBlock.get(block);
          const cellByOffset = new Map((row?.cells ?? []).map((c) => [c.offset, c]));
          return (
            <div key={block} style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span
                className="faint tnum"
                style={{ flex: "none", width: 78, fontSize: 10.5, textAlign: "right" }}
                title={row ? `Week starting ${row.blockStart}` : undefined}
              >
                {row ? `${row.blockStart} · ${row.cohortSize}` : "—"}
              </span>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(8, 1fr)", gap: 3, flex: 1 }}>
                {Array.from({ length: 8 }, (_, offset) => {
                  const inTriangle = block + offset <= 7;
                  const cell = cellByOffset.get(offset);
                  if (!inTriangle) {
                    return <div key={offset} style={{ aspectRatio: "1 / 1" }} />;
                  }
                  const pct = cell?.activePct ?? null;
                  const bg = pct === null ? "var(--card-2)" : intensityColor(pct / 100);
                  return (
                    <div
                      key={offset}
                      title={
                        row
                          ? `${row.blockStart} cohort, +${offset}w: ${pct === null ? "—" : `${pct}%`} (${cell?.activeCount ?? 0}/${row.cohortSize})`
                          : undefined
                      }
                      style={{
                        aspectRatio: "1 / 1",
                        borderRadius: 3,
                        background: bg,
                        opacity: pct === null ? 0.5 : 0.35 + (pct / 100) * 0.65,
                        display: "grid",
                        placeItems: "center",
                      }}
                    >
                      {pct !== null && (
                        <span
                          className="tnum"
                          style={{ fontSize: 9, fontWeight: 600, color: "#fff", mixBlendMode: "difference" }}
                        >
                          {Math.round(pct)}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      <span className="faint" style={{ fontSize: 10.5 }}>
        Rows: cohort week (start date · cohort size). Columns: weeks since first seen (0..7).
      </span>
    </div>
  );
}

// ── P9-PACK2 · channel-shift ──────────────────────────────────────────────────

function ChannelShiftPanel({ rows }: { rows: ChannelShiftRow[] }) {
  return (
    <div className="card" style={{ padding: 18, display: "grid", gap: 14 }}>
      <PanelTitle
        title="Channel shift"
        hint="Share of channelled activity this window vs the prior equal window"
      />
      {rows.length === 0 ? (
        <p className="faint" style={{ fontSize: 12.5 }}>No channelled activity to compare yet.</p>
      ) : (
        <StatGrid minTileWidth={140}>
          {rows.map((row) => (
            <StatTile
              key={row.label}
              label={humanize(row.label)}
              value={`${row.currentPct}%`}
              deltaLabel={
                row.deltaPct === 0
                  ? "±0pp"
                  : `${row.deltaPct > 0 ? "+" : "−"}${Math.abs(row.deltaPct)}pp`
              }
              sub={`was ${row.priorPct}%`}
              goodDirection="up"
              delta={row.deltaPct}
            />
          ))}
        </StatGrid>
      )}
    </div>
  );
}

function PanelTitle({ title, hint }: { title: string; hint?: string }) {
  return (
    <div style={{ display: "grid", gap: 2 }}>
      <span style={{ fontSize: 13.5, fontWeight: 600 }}>{title}</span>
      {hint && (
        <span className="faint" style={{ fontSize: 11.5 }}>
          {hint}
        </span>
      )}
    </div>
  );
}
