import type { ReactNode } from "react";
import { Sparkline } from "../Sparkline";

/**
 * Adaptive compact preview of a tool's result inside the "how I got this" trace.
 * Sniffs the shape and renders the most legible form:
 *   • a metric series ({ series: [{periodStart, value}], meta }) → Sparkline + range
 *   • an array of flat rows → a small capped table
 *   • a string → mono text
 *   • anything else → truncated pretty JSON
 * Purely presentational, defensive on every access.
 */

const ROW_CAP = 8;
const COL_CAP = 5;
const JSON_CAP = 1200;

interface SeriesPoint {
  periodStart?: unknown;
  value?: unknown;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function readSeries(v: unknown): { points: number[]; meta: Record<string, unknown> | null } | null {
  const rec = asRecord(v);
  if (!rec || !Array.isArray(rec.series)) return null;
  const points: number[] = [];
  for (const p of rec.series as SeriesPoint[]) {
    const val = asRecord(p)?.value;
    points.push(typeof val === "number" && Number.isFinite(val) ? val : 0);
  }
  if (points.length === 0) return null;
  return { points, meta: asRecord(rec.meta) };
}

function isFlatRow(v: unknown): v is Record<string, unknown> {
  const rec = asRecord(v);
  if (!rec) return false;
  return Object.values(rec).every(
    (cell) => cell === null || ["string", "number", "boolean"].includes(typeof cell),
  );
}

function cellText(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string") return v;
  return String(v);
}

function SeriesPreview({ points, meta }: { points: number[]; meta: Record<string, unknown> | null }): ReactNode {
  const name = typeof meta?.name === "string" ? meta.name : "series";
  const first = points[0];
  const last = points[points.length - 1];
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <Sparkline points={points} color="var(--ink)" />
      <div className="mono" style={{ fontSize: 11.5, color: "var(--text-2)", lineHeight: 1.5 }}>
        <div style={{ color: "var(--text)" }}>{name}</div>
        <div>
          {points.length} pts · {fmtNum(first)} → {fmtNum(last)}
        </div>
      </div>
    </div>
  );
}

function fmtNum(v: number | undefined): string {
  if (typeof v !== "number") return "—";
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

function TablePreview({ rows }: { rows: Record<string, unknown>[] }): ReactNode {
  const cols = Array.from(
    rows.reduce<Set<string>>((set, r) => {
      Object.keys(r).forEach((k) => set.add(k));
      return set;
    }, new Set()),
  ).slice(0, COL_CAP);
  const shown = rows.slice(0, ROW_CAP);
  return (
    <div className="scroll-x">
      <table className="table" style={{ fontSize: 12 }}>
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c} style={{ padding: "6px 10px" }}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((r, i) => (
            <tr key={i}>
              {cols.map((c) => (
                <td key={c} className="mono" style={{ padding: "6px 10px", fontSize: 11.5 }}>
                  {cellText(r[c])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > ROW_CAP && (
        <div className="faint" style={{ fontSize: 11, padding: "4px 10px" }}>
          +{rows.length - ROW_CAP} more rows
        </div>
      )}
    </div>
  );
}

export function ToolResultPreview({ value }: { value: unknown }): ReactNode {
  if (value === undefined) return null;

  // Some traces nest the payload under `data` (the ToolResult envelope).
  const rec = asRecord(value);
  const inner = rec && "data" in rec ? rec.data : value;

  const series = readSeries(inner) ?? readSeries(value);
  if (series) return <SeriesPreview points={series.points} meta={series.meta} />;

  const rowsSource = Array.isArray(inner) ? inner : Array.isArray(value) ? value : null;
  if (rowsSource && rowsSource.length > 0 && rowsSource.every(isFlatRow)) {
    return <TablePreview rows={rowsSource as Record<string, unknown>[]} />;
  }

  if (typeof value === "string") {
    return (
      <div className="mono" style={{ fontSize: 11.5, color: "var(--text-2)", whiteSpace: "pre-wrap" }}>
        {value.slice(0, JSON_CAP)}
      </div>
    );
  }

  let json: string;
  try {
    json = JSON.stringify(inner ?? value, null, 2);
  } catch {
    json = String(value);
  }
  const truncated = json.length > JSON_CAP;
  return (
    <pre
      className="mono"
      style={{
        fontSize: 11,
        lineHeight: 1.5,
        color: "var(--text-2)",
        margin: 0,
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
      }}
    >
      {truncated ? `${json.slice(0, JSON_CAP)}…` : json}
    </pre>
  );
}
