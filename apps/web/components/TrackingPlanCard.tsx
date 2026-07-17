"use client";

import { useState } from "react";
import { coveragePlan, getTrackingPlan } from "../lib/tracking-presets";
import { CopyButton } from "./CopyBlock";
import { trackSnippet } from "./SnippetTabs";
import { COLORS, humanize, tint } from "./ui";
import type { EventTypeSeen } from "./types";

/**
 * Setup tab "Tracking plan" card (Phase 7 task T1). Replaces the old
 * full-taxonomy "Event coverage" checklist with the per-project-type preset:
 * required types first (✓ seen / ○ never seen), then recommended, each
 * missing type gets a copy-paste `os.track(...)` snippet, plus an
 * "N/M required" summary chip. Graceful with zero events.
 */
export function TrackingPlanCard({
  projectType,
  eventTypesSeen,
}: {
  projectType: string;
  eventTypesSeen: EventTypeSeen[];
}) {
  const plan = getTrackingPlan(projectType);
  const presentTypes = new Set(eventTypesSeen.map((e) => e.type));
  const { items, requiredTotal, requiredPresent } = coveragePlan(
    plan,
    presentTypes,
  );
  const fullyCovered = requiredTotal > 0 && requiredPresent === requiredTotal;

  return (
    <section className="card" style={{ padding: 18 }}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          marginBottom: 6,
          gap: 12,
        }}
      >
        <h3 style={{ fontSize: 14 }}>Tracking plan</h3>
        <span
          className="badge badge-mono"
          style={{
            color: fullyCovered ? COLORS.green : COLORS.amber,
            background: tint(fullyCovered ? COLORS.green : COLORS.amber, 0.12),
            flex: "none",
          }}
        >
          coverage: {requiredPresent}/{requiredTotal} required
        </span>
      </div>
      <p className="muted" style={{ fontSize: 13, marginBottom: 14 }}>
        The baseline preset for a <strong>{humanize(projectType)}</strong>{" "}
        project. ✓ means at least one event of that type has ever landed in
        the spine for this project; ○ means it hasn&rsquo;t been seen yet.
      </p>

      {items.length === 0 ? (
        <p className="faint" style={{ fontSize: 13 }}>
          No preset types for this project type — send whatever the
          integration naturally produces.
        </p>
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          {items.map((item) => (
            <TrackingPlanRow key={item.type} item={item} />
          ))}
        </div>
      )}
    </section>
  );
}

function TrackingPlanRow({
  item,
}: {
  item: { type: string; required: boolean; present: boolean };
}) {
  const [expanded, setExpanded] = useState(false);
  const color = item.present ? COLORS.green : item.required ? COLORS.amber : COLORS.grey;
  const canExpand = !item.present;

  return (
    <div
      style={{
        border: "none",
        borderRadius: "var(--radius-tile)",
        background: "var(--bg-well)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "9px 12px",
        }}
      >
        <span
          className="mono"
          style={{ color, fontSize: 13, width: 14, flex: "none" }}
          aria-hidden
        >
          {item.present ? "✓" : "○"}
        </span>
        <span className="mono" style={{ fontSize: 12.5, flex: 1, minWidth: 0 }}>
          {item.type}
        </span>
        <span
          className="badge"
          style={{
            fontSize: 10.5,
            color: item.required ? COLORS.amber : "var(--text-3)",
            background: item.required
              ? tint(COLORS.amber, 0.1)
              : "var(--card)",
            flex: "none",
          }}
        >
          {item.required ? "required" : "recommended"}
        </span>
        {canExpand && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? "Hide snippet" : "Get snippet"}
          </button>
        )}
      </div>
      {canExpand && expanded && (
        <div style={{ padding: "0 12px 12px" }}>
          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              marginBottom: 4,
            }}
          >
            <CopyButton value={trackSnippet(item.type)} className="btn btn-sm" />
          </div>
          <pre className="codeblock" style={{ fontSize: 12 }}>
            {trackSnippet(item.type)}
          </pre>
        </div>
      )}
    </div>
  );
}
