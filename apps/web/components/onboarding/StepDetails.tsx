"use client";

import { poundsToPence } from "../../lib/onboarding/wizard";
import { formatPence } from "../../lib/format";
import { TrackingPlanCard } from "../TrackingPlanCard";
import { humanize } from "../ui";
import type { ProjectDraft } from "../../lib/server/intake/schema";

/**
 * Step 3 — project details (prefilled by intake, or filled in manually if
 * step 2 was skipped) plus the tracking-plan preview. Reuses
 * `TrackingPlanCard` (lib/tracking-presets) UNCHANGED — no project exists yet
 * so `eventTypesSeen` is empty, which the card already renders gracefully
 * (every row shows ○, "0/N required"). The card's own "Get snippet" buttons
 * ARE the toggles the contract calls for — no separate control needed.
 */
export function StepDetails({
  draft,
  onChange,
  types,
  stacks,
}: {
  draft: ProjectDraft;
  onChange: (draft: ProjectDraft) => void;
  types: string[];
  stacks: string[];
}) {
  const retainerPounds =
    draft.retainerPenceMonthly !== null && draft.retainerPenceMonthly > 0
      ? String(draft.retainerPenceMonthly / 100)
      : "";
  const buildFeePounds =
    draft.buildFeePence !== null && draft.buildFeePence > 0
      ? String(draft.buildFeePence / 100)
      : "";

  return (
    <div style={{ display: "grid", gap: 20 }}>
      <div style={{ maxWidth: 560, display: "grid", gap: 16 }}>
        <div>
          <label className="label" htmlFor="wiz-name">
            Project name
          </label>
          <input
            id="wiz-name"
            className="input"
            value={draft.name}
            onChange={(e) => onChange({ ...draft, name: e.target.value })}
            placeholder="Reception voice agent"
            required
          />
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div>
            <label className="label" htmlFor="wiz-type">
              Type
            </label>
            <select
              id="wiz-type"
              className="input"
              value={draft.type}
              onChange={(e) =>
                onChange({ ...draft, type: e.target.value as ProjectDraft["type"] })
              }
            >
              {types.map((t) => (
                <option key={t} value={t}>
                  {humanize(t)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="wiz-stack">
              Stack
            </label>
            <select
              id="wiz-stack"
              className="input"
              value={draft.stack}
              onChange={(e) =>
                onChange({ ...draft, stack: e.target.value as ProjectDraft["stack"] })
              }
            >
              {stacks.map((s) => (
                <option key={s} value={s}>
                  {humanize(s)}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div>
            <label className="label" htmlFor="wiz-retainer">
              Monthly retainer (£)
            </label>
            <input
              id="wiz-retainer"
              className="input"
              type="number"
              min="0"
              step="1"
              value={retainerPounds}
              onChange={(e) =>
                onChange({
                  ...draft,
                  retainerPenceMonthly: poundsToPence(e.target.value),
                })
              }
              placeholder="1500"
            />
          </div>
          <div>
            <label className="label" htmlFor="wiz-buildfee">
              Build fee (£) <span className="faint">(optional)</span>
            </label>
            <input
              id="wiz-buildfee"
              className="input"
              type="number"
              min="0"
              step="1"
              value={buildFeePounds}
              onChange={(e) =>
                onChange({ ...draft, buildFeePence: poundsToPence(e.target.value) })
              }
              placeholder="2500"
            />
          </div>
        </div>

        <div>
          <label className="label" htmlFor="wiz-desc">
            Description <span className="faint">(optional)</span>
          </label>
          <textarea
            id="wiz-desc"
            className="input"
            value={draft.description}
            onChange={(e) => onChange({ ...draft, description: e.target.value })}
            placeholder="What this system does for the client…"
          />
        </div>

        {draft.goals.length > 0 && (
          <div>
            <div className="label">Goals from intake</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {draft.goals.map((g, i) => (
                <span key={`${g.metric}-${i}`} className="badge badge-mono">
                  {g.target}/{g.period} {humanize(g.metric)}
                </span>
              ))}
            </div>
          </div>
        )}

        {(draft.retainerPenceMonthly ?? 0) > 0 && (
          <p className="faint" style={{ fontSize: 12, margin: 0 }}>
            {formatPence(draft.retainerPenceMonthly)}/month retainer
          </p>
        )}
      </div>

      <TrackingPlanCard projectType={draft.type} eventTypesSeen={[]} />
    </div>
  );
}
