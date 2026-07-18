"use client";

import { useEffect, useMemo, useState } from "react";
import { Donut } from "./analytics/charts";

/**
 * Command Center — TERMINAL-LUXE pulse board (owner reference: "Zerrio live").
 * Near-black canvas, hairline cards, huge white tnum numerals, tiny uppercase
 * MONO micro-labels, small green/red delta chips. Colour lives ONLY in delta
 * chips, semantic dots and the tiny chart/donut segments — everything else is
 * monochrome discipline. All numbers are the agency's REAL data, computed once
 * on the server (loadPulse) and re-filtered client-side for the window toggle.
 */

export interface PulseProject {
  id: string;
  name: string;
  clientName: string;
  /** events in the last 30 London days */
  cur: number;
  /** events in the prior 30 London days */
  prev: number;
  /** the project's tint fg tone — its lone spot of colour */
  colorHex: string;
  /** last 30 London days, oldest→newest, event count per day */
  daily: number[];
}

export interface PulseData {
  projects: PulseProject[]; // sorted desc by `cur`
  seriesDaily: number[]; // last 30 London days total events, oldest→newest
  seriesDays: string[]; // matching 'YYYY-MM-DD' labels
  series60: number[]; // last 60 London days total events, oldest→newest
  eventsTotal: number; // all-time spine total (the hero)
  conversations30: number; // comms-category events, last 30 days
  mrrPence: number;
}

const gbp = (n: number) => n.toLocaleString("en-GB");

function fmtPct(recent: number, prior: number): { text: string; up: boolean; flat: boolean } {
  if (prior <= 0) {
    if (recent <= 0) return { text: "0.0%", up: true, flat: true };
    return { text: "NEW", up: true, flat: false };
  }
  const pct = ((recent - prior) / prior) * 100;
  const up = pct >= 0;
  return { text: `${up ? "+" : "−"}${Math.abs(pct).toFixed(1)}%`, up, flat: pct === 0 };
}

const shortDate = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});
function labelDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? "" : shortDate.format(d);
}

// ── delta chip ────────────────────────────────────────────────────────────────
function Delta({ recent, prior }: { recent: number; prior: number }) {
  const d = fmtPct(recent, prior);
  const color = d.flat ? "var(--text-3)" : d.up ? "var(--green)" : "var(--red)";
  return (
    <span className="cc-delta" style={{ color }}>
      {d.flat ? "±" : d.up ? "▲" : "▼"} {d.text}
    </span>
  );
}

// ── the combined-volume line (white 1.5px stepped, minimal axes) ────────────────
function VolumeChart({ series, days }: { series: number[]; days: string[] }) {
  const W = 720;
  const H = 210;
  const PAD = { t: 16, r: 14, b: 24, l: 34 };
  const plotW = W - PAD.l - PAD.r;
  const plotH = H - PAD.t - PAD.b;
  const n = series.length;
  const max = Math.max(1, ...series);
  const x = (i: number) => PAD.l + (n > 1 ? i / (n - 1) : 0) * plotW;
  const y = (v: number) => PAD.t + plotH - (v / max) * plotH;

  // stepped-feel path: step BEFORE each vertex (vertical riser at each day).
  let line = n > 0 ? `M${x(0).toFixed(1)} ${y(series[0]!).toFixed(1)}` : "";
  for (let i = 1; i < n; i++) {
    line += ` L${x(i).toFixed(1)} ${y(series[i - 1]!).toFixed(1)} L${x(i).toFixed(1)} ${y(series[i]!).toFixed(1)}`;
  }
  const area = line
    ? `${line} L${x(n - 1).toFixed(1)} ${(PAD.t + plotH).toFixed(1)} L${x(0).toFixed(1)} ${(PAD.t + plotH).toFixed(1)} Z`
    : "";
  const grid = [max, Math.round(max / 2), 0];
  const xIdx = [0, Math.floor((n - 1) / 2), n - 1];

  if (n < 2) {
    return (
      <div className="faint" style={{ height: H, display: "grid", placeItems: "center", fontSize: 12 }}>
        Not enough volume to plot yet.
      </div>
    );
  }

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="combined daily event volume" style={{ display: "block", overflow: "visible" }}>
      {grid.map((v, i) => {
        const gy = y(v);
        return (
          <g key={i}>
            <line x1={PAD.l} x2={W - PAD.r} y1={gy} y2={gy} stroke="var(--border)" strokeWidth={1} />
            <text x={PAD.l - 7} y={gy + 3} textAnchor="end" fontSize={9.5} fill="var(--text-3)" fontFamily="var(--mono)">
              {gbp(v)}
            </text>
          </g>
        );
      })}
      {xIdx.map((idx, i) => (
        <text
          key={idx}
          x={x(idx)}
          y={H - 7}
          textAnchor={i === 0 ? "start" : i === xIdx.length - 1 ? "end" : "middle"}
          fontSize={9.5}
          fill="var(--text-3)"
          fontFamily="var(--mono)"
          letterSpacing="0.06em"
        >
          {(days[idx] ?? "").length ? labelDay(days[idx]!) : ""}
        </text>
      ))}
      {area && <path d={area} fill="var(--text)" fillOpacity={0.05} stroke="none" />}
      <path d={line} fill="none" stroke="var(--text)" strokeWidth={1.5} strokeLinejoin="miter" strokeLinecap="butt" />
    </svg>
  );
}

// ── consistency bars: per project, one 30-segment row (filled = active day) ─────
function ConsistencyRow({ p }: { p: PulseProject }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
      <span
        className="cc-sub"
        style={{ flex: "none", width: 116, color: "var(--text-2)" }}
        title={`${p.name} — ${p.clientName}`}
      >
        {p.name}
      </span>
      <div style={{ flex: 1, display: "flex", gap: 2, minWidth: 0 }} aria-hidden>
        {p.daily.map((v, i) => (
          <span
            key={i}
            style={{
              flex: 1,
              height: 12,
              borderRadius: 2,
              background: v > 0 ? p.colorHex : "var(--card-2)",
              opacity: v > 0 ? Math.min(1, 0.42 + v / 8) : 1,
            }}
          />
        ))}
      </div>
      <span className="cc-sub tnum" style={{ flex: "none", width: 40, textAlign: "right", color: "var(--text-3)" }}>
        {p.daily.filter((v) => v > 0).length}/{p.daily.length}
      </span>
    </div>
  );
}

// ── card primitives ─────────────────────────────────────────────────────────────
function ProjectCard({ p }: { p: PulseProject }) {
  return (
    <div className="cc-card">
      <Delta recent={p.cur} prior={p.prev} />
      <span className="cc-kicker" title={p.name}>
        {p.name}
      </span>
      <span className="cc-num" style={{ marginTop: 2 }}>
        {gbp(p.cur)}
      </span>
      <span className="cc-sub" title={p.clientName}>
        {p.clientName}
      </span>
    </div>
  );
}

export function CommandCenterPulse({ data }: { data: PulseData }) {
  const [win, setWin] = useState<7 | 14 | 30>(30);
  const [anomalies, setAnomalies] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/overview", { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) return;
        const json = (await res.json()) as { openAnomalies?: number };
        if (alive && typeof json.openAnomalies === "number") setAnomalies(json.openAnomalies);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
  const growth = useMemo(() => {
    const s = data.series60;
    const nlen = s.length;
    const recent = sum(s.slice(nlen - win));
    const prior = sum(s.slice(nlen - 2 * win, nlen - win));
    return { recent, prior, ...fmtPct(recent, prior) };
  }, [data.series60, win]);

  const cur30 = sum(data.series60.slice(30));
  const prev30 = sum(data.series60.slice(0, 30));
  const net = cur30 - prev30;

  const topProject = data.projects[0] ?? null;
  const stripProjects = data.projects.slice(0, 6);
  const donutSegs = data.projects
    .filter((p) => p.cur > 0)
    .slice(0, 8)
    .map((p) => ({ label: p.name, value: p.cur, color: p.colorHex }));
  const consistencyProjects = data.projects.filter((p) => p.cur > 0 || p.prev > 0).slice(0, 8);

  return (
    <div className="cc-grid">
      {/* header — PULSE kicker + LIVE chip */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <span className="cc-kicker" style={{ letterSpacing: "0.16em", color: "var(--text-3)" }}>
          Portfolio pulse · last 30 days
        </span>
        <span className="cc-live">
          <span className="pulse" style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--green)", display: "inline-block" }} aria-hidden />
          Live
        </span>
      </div>

      {/* TOP STRIP — per-project cards */}
      {stripProjects.length > 0 ? (
        <div className="cc-strip">
          {stripProjects.map((p) => (
            <ProjectCard key={p.id} p={p} />
          ))}
        </div>
      ) : null}

      {/* SECOND ROW — wide stat cells */}
      <div className="cc-cells">
        <div className="cc-card">
          <span className="cc-kicker">Total events</span>
          <span className="cc-num cc-num--hero">{gbp(data.eventsTotal)}</span>
          <span className="cc-sub">spine · all time</span>
        </div>

        <div className="cc-card">
          <span className="cc-kicker">Growth · {win}d</span>
          <span
            className="cc-num"
            style={{ color: growth.flat ? "var(--text)" : growth.up ? "var(--green)" : "var(--red)" }}
          >
            {growth.text}
          </span>
          <span className="cc-seg" role="group" aria-label="growth window">
            {([7, 14, 30] as const).map((w) => (
              <button key={w} type="button" aria-pressed={win === w} onClick={() => setWin(w)}>
                {w}D
              </button>
            ))}
          </span>
        </div>

        <div className="cc-card">
          <span className="cc-kicker">Conversations</span>
          <span className="cc-num">{gbp(data.conversations30)}</span>
          <span className="cc-sub">messages · 30d</span>
        </div>

        <div className="cc-card">
          <span className="cc-kicker">Top project</span>
          <span className="cc-num cc-num--sm" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={topProject?.name}>
            {topProject?.name ?? "—"}
          </span>
          <span className="cc-sub">{topProject ? `${gbp(topProject.cur)} events · 30d` : "no events yet"}</span>
        </div>

        <div className="cc-card">
          <span className="cc-kicker">MRR</span>
          <span className="cc-num cc-num--sm">
            £{gbp(Math.round(data.mrrPence / 100))}
          </span>
          <span className="cc-sub">recurring · monthly</span>
        </div>

        <div className="cc-card">
          <span className="cc-kicker">Open anomalies</span>
          <span className="cc-num" style={{ color: anomalies && anomalies > 0 ? "var(--red)" : "var(--text)" }}>
            {anomalies === null ? "—" : gbp(anomalies)}
          </span>
          <span className="cc-sub">needs a look</span>
        </div>
      </div>

      {/* MAIN CHART + DONUT */}
      <div className="cc-mainrow">
        <div className="cc-card" style={{ gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
            <span className="cc-kicker">Combined volume · 30d</span>
            <span className="cc-delta" style={{ position: "static", color: net >= 0 ? "var(--green)" : "var(--red)" }}>
              {net >= 0 ? "▲" : "▼"} {net >= 0 ? "+" : "−"}
              {gbp(Math.abs(net))} net
            </span>
          </div>
          <VolumeChart series={data.seriesDaily} days={data.seriesDays} />
        </div>

        <div className="cc-card" style={{ gap: 14 }}>
          <span className="cc-kicker">Events share · by project</span>
          {donutSegs.length > 0 ? (
            <Donut segments={donutSegs} size={120} thickness={16} centerLabel={gbp(cur30)} />
          ) : (
            <span className="cc-sub" style={{ color: "var(--text-3)" }}>No project events in the last 30 days.</span>
          )}
        </div>
      </div>

      {/* BOTTOM STRIP — daily consistency */}
      {consistencyProjects.length > 0 ? (
        <div className="cc-card" style={{ gap: 12 }}>
          <span className="cc-kicker">Daily consistency · last 30 days</span>
          <div style={{ display: "grid", gap: 8 }}>
            {consistencyProjects.map((p) => (
              <ConsistencyRow key={p.id} p={p} />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
