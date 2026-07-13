"use client";

import { useState } from "react";
import { JsonView } from "./JsonView";

/**
 * Collapsible "data snapshot" drill-down for the brief detail — the exact
 * numbers the agent saw (the deterministic DailyPack), for auditability (§9:
 * "every agent output carries its data_snapshot"). Collapsed by default.
 */
export function CollapsibleSnapshot({ value }: { value: unknown }) {
  const [open, setOpen] = useState(false);
  const empty =
    value == null ||
    (typeof value === "object" && Object.keys(value as object).length === 0);

  return (
    <section className="card" style={{ padding: 0 }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          padding: "13px 18px",
          background: "none",
          border: "none",
          color: "var(--text)",
          fontFamily: "inherit",
          fontSize: 13.5,
          fontWeight: 550,
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        <span style={{ display: "flex", alignItems: "center", gap: 9 }}>
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{
              color: "var(--text-3)",
              transform: open ? "rotate(90deg)" : "none",
              transition: "transform 0.15s ease",
            }}
            aria-hidden
          >
            <polyline points="9 6 15 12 9 18" />
          </svg>
          Data snapshot
          <span className="faint" style={{ fontWeight: 400, fontSize: 12 }}>
            the exact numbers the agent saw
          </span>
        </span>
        <span className="chip">{open ? "Hide" : "Show"}</span>
      </button>
      {open && (
        <div style={{ padding: "0 18px 18px" }}>
          {empty ? (
            <p className="faint" style={{ fontSize: 12.5 }}>
              No snapshot stored for this brief.
            </p>
          ) : (
            <JsonView value={value} maxHeight={420} />
          )}
        </div>
      )}
    </section>
  );
}
