"use client";

import { useState } from "react";
import { ToolResultPreview } from "./ToolResultPreview";
import type { ToolTraceItem } from "./types";

/**
 * The collapsible "how I got this" trace — the chat equivalent of a brief's
 * data_snapshot. Lists every tool call behind an answer: name, input, ok/failed
 * status, and a compact result preview. Collapsed by default so answers stay
 * terse; one click reveals the full provenance for auditing every number.
 */

function compactInput(input: unknown): string {
  if (input === undefined) return "";
  if (input === null) return "null";
  if (typeof input === "string") return input;
  try {
    const s = JSON.stringify(input);
    return s.length > 160 ? `${s.slice(0, 160)}…` : s;
  } catch {
    return String(input);
  }
}

function StatusDot({ ok }: { ok?: boolean }) {
  const color = ok === undefined ? "var(--text-3)" : ok ? "var(--green)" : "var(--red)";
  return <span className="dot" style={{ width: 6, height: 6, background: color }} aria-hidden />;
}

export function AnswerTrace({ trace }: { trace: ToolTraceItem[] }) {
  const [open, setOpen] = useState(false);
  if (trace.length === 0) return null;

  const failures = trace.filter((t) => t.ok === false).length;

  return (
    <div style={{ marginTop: 10 }}>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        style={{ height: 24, padding: "0 8px", fontSize: 11.5, color: "var(--text-2)" }}
      >
        <svg
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
          style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform 0.12s ease" }}
        >
          <polyline points="9 6 15 12 9 18" />
        </svg>
        How I got this · {trace.length} tool{trace.length === 1 ? "" : "s"}
        {failures > 0 && (
          <span style={{ color: "var(--red)" }}>· {failures} failed</span>
        )}
      </button>

      {open && (
        <ol
          style={{
            listStyle: "none",
            margin: "8px 0 0",
            padding: 0,
            display: "grid",
            gap: 8,
          }}
        >
          {trace.map((t, i) => (
            <li
              key={i}
              className="card"
              style={{ background: "var(--input)", padding: "9px 11px", display: "grid", gap: 6 }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <StatusDot ok={t.ok} />
                <code className="badge badge-mono" style={{ background: "var(--card-2)", color: "var(--text)" }}>
                  {t.name}
                </code>
                {t.ok === false && (
                  <span style={{ fontSize: 11, color: "var(--red)" }}>failed</span>
                )}
              </div>
              {compactInput(t.input) !== "" && compactInput(t.input) !== "{}" && (
                <div
                  className="mono"
                  style={{ fontSize: 11, color: "var(--text-3)", wordBreak: "break-word" }}
                >
                  {compactInput(t.input)}
                </div>
              )}
              {t.resultSummary !== undefined && (
                <div
                  style={{
                    borderTop: "1px solid var(--border)",
                    paddingTop: 6,
                    marginTop: 1,
                  }}
                >
                  <ToolResultPreview value={t.resultSummary} />
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
