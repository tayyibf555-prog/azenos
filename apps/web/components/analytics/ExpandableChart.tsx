"use client";

import { useState } from "react";
import type { ReactNode } from "react";

/**
 * Numbers-first primitive #3: the per-tile/group chart collapse
 * (APPLE-THEME.md §Numbers first — "charts ONLY behind an expand"). Renders
 * a quiet toggle; the chart/heatmap/donut passed as `children` mounts only
 * once expanded, so a section is tiles-by-default with zero chart markup
 * until a click. `hint` is optional compact content shown alongside the
 * toggle at all times (e.g. a one-line summary).
 */
export function ExpandableChart({
  label = "chart",
  defaultOpen = false,
  hint,
  children,
}: {
  label?: string;
  defaultOpen?: boolean;
  hint?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: hint ? "space-between" : "flex-start",
          gap: 10,
          flexWrap: "wrap",
        }}
      >
        {hint}
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          style={{ cursor: "pointer", flex: "none" }}
        >
          <span
            aria-hidden
            style={{
              display: "inline-block",
              marginRight: 5,
              transform: open ? "rotate(90deg)" : "none",
              transition: "transform 200ms var(--ease)",
            }}
          >
            ▸
          </span>
          {open ? "Hide" : "Show"} {label}
        </button>
      </div>
      {open && <div data-expandable-chart-body="">{children}</div>}
    </div>
  );
}
