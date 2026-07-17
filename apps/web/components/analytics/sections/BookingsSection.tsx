"use client";

import type { ReactNode } from "react";
import type { AnalyticsRange, BookingsResponse, LabelledValue } from "../types";
import { COLORS, humanize } from "../../ui";
import {
  Donut,
  HBars,
  Heatmap,
  LineChart,
  topHeatmapCells,
  topSegments,
} from "../charts";
import { StatGrid } from "../StatGrid";
import { StatTile } from "../StatTile";
import { ExpandableChart } from "../ExpandableChart";
import { SectionFrame, SectionSkeleton, useSectionData } from "./_shell";

/** Extended wire shape the bookings endpoint returns (add-only over the contract). */
interface BookingsData extends BookingsResponse {
  statusCounts: {
    scheduled: number;
    completed: number;
    cancelled: number;
    noShow: number;
  };
  completedRate: number | null;
  cancelledRate: number | null;
  noShowRate: number | null;
  rescheduleRate: number | null;
  avgLeadHours: number | null;
  weekdayCurve: LabelledValue[];
  hourCurve: LabelledValue[];
  heatmap: { weekday: number; hour: number; value: number }[];
  kindMix: LabelledValue[];
  sourceMix: LabelledValue[];
  upcoming: number;
  past: number;
}

const n = (v: number): string => v.toLocaleString("en-GB");

/** 0..1 ratio → "42%" (or "—" when the metric is undefined for this window). */
function pct(v: number | null): string {
  return v === null ? "—" : `${Math.round(v * 100)}%`;
}

/** hours → "3.2 days" / "18h" / "45m" — human, compact. */
function leadTime(hours: number | null): string {
  if (hours === null) return "—";
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 48) return `${hours.toFixed(hours < 10 ? 1 : 0)}h`;
  return `${(hours / 24).toFixed(1)} days`;
}

// ── small building blocks ──────────────────────────────────────────────────────

function Card({
  children,
  strong,
  pad = 20,
}: {
  children: ReactNode;
  strong?: boolean;
  pad?: number;
}) {
  return (
    <div
      className={strong ? "glass-strong" : "card"}
      style={{ padding: pad, display: "grid", gap: 16 }}
    >
      {children}
    </div>
  );
}

function CardHead({ title, hint }: { title: string; hint?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
      <span style={{ fontSize: 13.5, fontWeight: 600 }}>{title}</span>
      {hint && (
        <span className="faint" style={{ fontSize: 11.5, textAlign: "right" }}>
          {hint}
        </span>
      )}
    </div>
  );
}

/** A tiny hour-of-day distribution strip (24 bars) — the "by hour" curve. */
function HourStrip({ hourCurve }: { hourCurve: LabelledValue[] }) {
  const max = hourCurve.reduce((m, h) => Math.max(m, h.value), 0);
  if (max === 0) {
    return (
      <div className="faint" style={{ fontSize: 12, minHeight: 72, display: "grid", placeItems: "center" }}>
        No bookings by hour in this range yet.
      </div>
    );
  }
  const peak = hourCurve.reduce((a, b) => (b.value > a.value ? b : a), hourCurve[0]!);
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 64 }}>
        {hourCurve.map((h) => {
          const t = h.value / max;
          return (
            <div
              key={h.label}
              title={`${h.label} — ${n(h.value)}`}
              style={{
                flex: 1,
                minWidth: 0,
                height: `${Math.max(3, t * 100)}%`,
                borderRadius: 2,
                background: COLORS.teal,
                opacity: h.value === 0 ? 0.14 : 0.35 + t * 0.55,
              }}
            />
          );
        })}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <span className="faint" style={{ fontSize: 10.5 }}>00:00</span>
        <span className="faint" style={{ fontSize: 10.5 }}>
          peak {peak.label} · {n(peak.value)}
        </span>
        <span className="faint" style={{ fontSize: 10.5 }}>23:00</span>
      </div>
    </div>
  );
}

// ── section ────────────────────────────────────────────────────────────────────

export function BookingsSection({
  projectId,
  range,
}: {
  projectId: string;
  range: AnalyticsRange;
}) {
  const state = useSectionData<BookingsData>("bookings", projectId, range);

  return (
    <SectionFrame title="Bookings" subtitle="Appointments booked, shows, no-shows, and when clients book.">
      {state.status === "loading" ? (
        <SectionSkeleton />
      ) : state.status === "error" ? (
        <div
          className="card"
          style={{ padding: 24, display: "grid", placeItems: "center", border: "1px dashed var(--border-2)", textAlign: "center", gap: 6 }}
        >
          <span className="empty-title">Bookings are offline</span>
          <span className="faint" style={{ fontSize: 12.5, maxWidth: 420 }}>
            Couldn&rsquo;t load booking analytics for this range. Try another window.
          </span>
        </div>
      ) : (
        <BookingsBody data={state.data} />
      )}
    </SectionFrame>
  );
}

function BookingsBody({ data }: { data: BookingsData }) {
  const { statusCounts } = data;
  const trend = data.series.map((p) => p.value);
  const showRate =
    data.completedRate === null ? null : Math.round(data.completedRate * 100);

  const statusMix = [
    { label: "Completed", value: statusCounts.completed, color: COLORS.green },
    { label: "Scheduled", value: statusCounts.scheduled, color: COLORS.blue },
    { label: "Cancelled", value: statusCounts.cancelled, color: COLORS.grey },
    { label: "No-show", value: statusCounts.noShow, color: COLORS.red },
  ];
  const kindSegments = data.kindMix.map((k) => ({ label: humanize(k.label), value: k.value }));
  const sourceSegments = data.sourceMix.map((k) => ({ label: humanize(k.label), value: k.value }));
  const topKinds = topSegments(kindSegments, 3);
  const topSources = topSegments(sourceSegments, 3);
  const topSlots = topHeatmapCells(data.heatmap, 3);

  return (
    <div style={{ display: "grid", gap: 16 }}>
      {/* the numbers — every headline aggregate the endpoint computes */}
      <StatGrid>
        <StatTile
          label="Bookings this range"
          value={n(data.totalBookings)}
          sub={showRate !== null ? `${showRate}% completed of resolved` : "awaiting outcomes"}
          sparkline={trend}
          sparkColor={COLORS.violet}
          size="lg"
        />
        <StatTile label="Upcoming" value={n(data.upcoming)} tone={COLORS.blue} sub="scheduled ahead" />
        <StatTile label="Past" value={n(data.past)} sub="all-time held" />
        <StatTile label="Avg lead time" value={leadTime(data.avgLeadHours)} sub="booked → appt" />
        <StatTile label="Reschedules" value={pct(data.rescheduleRate)} sub="of new bookings" />
        <StatTile
          label="Completed"
          value={n(statusCounts.completed)}
          tone={COLORS.green}
          sub={`${pct(data.completedRate)} of resolved`}
        />
        <StatTile
          label="No-show"
          value={n(statusCounts.noShow)}
          tone={statusCounts.noShow > 0 ? COLORS.red : undefined}
          sub={`${pct(data.noShowRate)} of resolved`}
        />
        <StatTile label="Cancelled" value={n(statusCounts.cancelled)} sub={`${pct(data.cancelledRate)} of resolved`} />
        <StatTile label="Scheduled" value={n(statusCounts.scheduled)} tone={COLORS.blue} sub="still upcoming" />
      </StatGrid>

      {/* outcomes — status mix as a ranked list, ring behind an expand */}
      <Card>
        <CardHead title="Outcomes" hint={`of ${n(data.totalBookings)} in range`} />
        <HBars items={statusMix} />
        <ExpandableChart label="outcomes ring">
          <Donut
            segments={statusMix}
            centerLabel={n(data.totalBookings)}
            emptyLabel="No bookings due in this range yet."
          />
        </ExpandableChart>
      </Card>

      {/* volume trend — numbers already above; line behind an expand */}
      <Card>
        <CardHead title="Booking volume" hint="appointments per day, by date" />
        <ExpandableChart label="daily trend">
          <LineChart points={data.series} color={COLORS.violet} unit="count" period="day" />
        </ExpandableChart>
      </Card>

      {/* the booking curve — busiest slot + top-3, grid behind an expand */}
      <Card>
        <CardHead title="When clients book" hint="weekday × hour of day" />
        {topSlots.length === 0 ? (
          <span className="faint" style={{ fontSize: 12.5 }}>No booking times to map in this range yet.</span>
        ) : (
          <>
            <StatTile
              label="Busiest slot"
              value={topSlots[0]!.label}
              deltaLabel={`${n(topSlots[0]!.value)} bookings`}
              tone={COLORS.violet}
            />
            <HBars items={topSlots} labelWidth={90} />
          </>
        )}
        <div
          style={{
            display: "grid",
            gap: 20,
            gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
          }}
        >
          <div style={{ display: "grid", gap: 10 }}>
            <span className="muted" style={{ fontSize: 12, fontWeight: 550 }}>
              By weekday
            </span>
            <HBars
              items={data.weekdayCurve.map((d) => ({ label: d.label, value: d.value, color: COLORS.violet }))}
              labelWidth={44}
              emptyLabel="No weekday data yet."
            />
          </div>
          <div style={{ display: "grid", gap: 10 }}>
            <span className="muted" style={{ fontSize: 12, fontWeight: 550 }}>
              By hour of day
            </span>
            <HourStrip hourCurve={data.hourCurve} />
          </div>
        </div>
        <ExpandableChart label="hour × weekday grid">
          <Heatmap
            cells={data.heatmap}
            emptyLabel="No booking times to map in this range yet."
          />
        </ExpandableChart>
      </Card>

      {/* mix — top type/source + top-3, rings behind an expand */}
      <Card>
        <CardHead title="Booking mix" hint="by type and source, in range" />
        <div
          style={{
            display: "grid",
            gap: 24,
            gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
          }}
        >
          <div style={{ display: "grid", gap: 10 }}>
            <span className="muted" style={{ fontSize: 12, fontWeight: 550 }}>
              By type
            </span>
            {topKinds.length === 0 ? (
              <span className="faint" style={{ fontSize: 12.5 }}>No booking types in this range yet.</span>
            ) : (
              <HBars items={topKinds} labelWidth={100} />
            )}
            <ExpandableChart label="type ring">
              <Donut segments={kindSegments} emptyLabel="No booking types in this range yet." />
            </ExpandableChart>
          </div>
          <div style={{ display: "grid", gap: 10 }}>
            <span className="muted" style={{ fontSize: 12, fontWeight: 550 }}>
              By source
            </span>
            {topSources.length === 0 ? (
              <span className="faint" style={{ fontSize: 12.5 }}>No booking sources in this range yet.</span>
            ) : (
              <HBars items={topSources} labelWidth={100} />
            )}
            <ExpandableChart label="source ring">
              <Donut segments={sourceSegments} emptyLabel="No booking sources in this range yet." />
            </ExpandableChart>
          </div>
        </div>
      </Card>
    </div>
  );
}
