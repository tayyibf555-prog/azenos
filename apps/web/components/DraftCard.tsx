"use client";

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { ProjectDraft } from "../lib/server/intake/schema";
import { formatPence } from "../lib/format";
import { getTrackingPlan } from "../lib/tracking-presets";
import { COLORS, eventCategory, humanize, tint } from "./ui";

/**
 * Read-only-ish view of the current draft: every field, a client-match badge,
 * £-formatted money, goals, taxonomy-coloured event badges, and an amber
 * assumptions list. The project name is inline-editable (direct rename without
 * the copilot). Fields named in `changedKeys` briefly flash after a refine.
 *
 * Client-safe: only imports the ProjectDraft TYPE (erased at build) plus
 * client-only formatters — never the server schema module's runtime code.
 */

const FLASH_CSS = `
@keyframes intakeFlash {
  0% { box-shadow: 0 0 0 2px rgba(122,162,247,0.55); background: rgba(122,162,247,0.12); }
  100% { box-shadow: 0 0 0 0 rgba(122,162,247,0); background: transparent; }
}
.intake-flash { animation: intakeFlash 1.2s ease-out; border-radius: 8px; }
@media (prefers-reduced-motion: reduce) { .intake-flash { animation: none; } }
`;

function money(pence: number | null): string {
  return pence === null ? "—" : formatPence(pence);
}

export function DraftCard({
  draft,
  onNameChange,
  changedKeys,
}: {
  draft: ProjectDraft;
  onNameChange: (name: string) => void;
  changedKeys: readonly string[];
}) {
  const [flash, setFlash] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    if (changedKeys.length === 0) return;
    setFlash(new Set(changedKeys));
    const t = setTimeout(() => setFlash(new Set()), 1200);
    return () => clearTimeout(t);
  }, [changedKeys]);

  const fc = (k: string): string | undefined =>
    flash.has(k) ? "intake-flash" : undefined;

  const c = draft.client;
  const clientColor = c.match === "existing" ? COLORS.green : COLORS.blue;
  const trackingPlan = getTrackingPlan(draft.type);
  const trackingCount = trackingPlan.required.length + trackingPlan.recommended.length;

  return (
    <div className="card" style={{ padding: 18, display: "grid", gap: 16 }}>
      <style>{FLASH_CSS}</style>

      {/* name + type/stack */}
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <div className={fc("name")} style={{ flex: 1, minWidth: 0 }}>
          <label className="label" htmlFor="draft-name">
            Project name
          </label>
          <input
            id="draft-name"
            className="input"
            value={draft.name}
            onChange={(e) => onNameChange(e.target.value)}
            aria-label="Project name"
            style={{ fontSize: 16, fontWeight: 600, height: 40 }}
          />
        </div>
        <div
          className={fc("type") || fc("stack")}
          style={{
            display: "grid",
            justifyItems: "end",
            gap: 4,
            paddingTop: 22,
          }}
        >
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <Pill color={COLORS.violet}>{humanize(draft.type)}</Pill>
            <Pill color={COLORS.teal}>{humanize(draft.stack)}</Pill>
          </div>
          <span className="faint" style={{ fontSize: 11.5 }}>
            We&rsquo;ll track {trackingCount} events for this project type
          </span>
        </div>
      </div>

      {/* client match */}
      <div className={fc("client")}>
        <div className="label">Client</div>
        <span
          className="badge"
          style={{
            color: clientColor,
            background: tint(clientColor, 0.13),
            borderColor: tint(clientColor, 0.28),
          }}
        >
          <span
            className="dot"
            style={{ width: 6, height: 6, background: clientColor }}
            aria-hidden
          />
          {c.match === "existing" ? "existing" : "new client"}
          {" · "}
          {c.name || "(unnamed)"}
          {c.industrySlug ? ` · ${c.industrySlug}` : ""}
        </span>
      </div>

      {/* money */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
          gap: 10,
        }}
      >
        <MoneyCell
          className={fc("retainerPenceMonthly")}
          label="Retainer / mo"
          value={money(draft.retainerPenceMonthly)}
        />
        <MoneyCell
          className={fc("buildFeePence")}
          label="Build fee"
          value={money(draft.buildFeePence)}
        />
        <MoneyCell
          className={fc("hourlyRatePence")}
          label="Hourly rate"
          value={money(draft.hourlyRatePence)}
        />
      </div>

      {/* description */}
      <div className={fc("description")}>
        <div className="label">Description</div>
        <p style={{ fontSize: 13.5, lineHeight: 1.55 }}>
          {draft.description || <span className="faint">No description.</span>}
        </p>
      </div>

      {/* goals */}
      <div className={fc("goals")}>
        <div className="label">Goals</div>
        {draft.goals.length === 0 ? (
          <p className="faint" style={{ fontSize: 13 }}>
            No measurable goals inferred.
          </p>
        ) : (
          <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 6 }}>
            {draft.goals.map((g, i) => (
              <li
                key={`${g.metric}-${i}`}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  fontSize: 13,
                }}
              >
                <span
                  className="badge badge-mono"
                  style={{
                    color: COLORS.blue,
                    background: tint(COLORS.blue, 0.12),
                    borderColor: tint(COLORS.blue, 0.26),
                  }}
                >
                  {g.target}
                  <span className="faint">/{g.period}</span>
                </span>
                <span>{humanize(g.metric)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* suggested event types */}
      <div className={fc("suggestedEventTypes")}>
        <div className="label">Suggested event types</div>
        {draft.suggestedEventTypes.length === 0 ? (
          <p className="faint" style={{ fontSize: 13 }}>
            None suggested.
          </p>
        ) : (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {draft.suggestedEventTypes.map((t) => {
              const { color } = eventCategory(t);
              return (
                <span
                  key={t}
                  className="badge badge-mono"
                  style={{
                    color,
                    background: tint(color, 0.12),
                    borderColor: tint(color, 0.26),
                  }}
                >
                  {t}
                </span>
              );
            })}
          </div>
        )}
      </div>

      {/* assumptions */}
      {draft.assumptions.length > 0 && (
        <div className={fc("assumptions")}>
          <div className="label" style={{ color: COLORS.amber }}>
            Assumptions to check
          </div>
          <ul
            style={{
              margin: 0,
              paddingLeft: 18,
              display: "grid",
              gap: 4,
              fontSize: 13,
              color: COLORS.amber,
            }}
          >
            {draft.assumptions.map((a, i) => (
              <li key={i} style={{ color: "var(--text)" }}>
                <span style={{ color: COLORS.amber }}>•</span> {a}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Pill({ color, children }: { color: string; children: ReactNode }) {
  return (
    <span
      className="badge"
      style={{
        color,
        background: tint(color, 0.13),
        borderColor: tint(color, 0.28),
      }}
    >
      {children}
    </span>
  );
}

function MoneyCell({
  label,
  value,
  className,
}: {
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div
      className={className}
      style={{
        background: "var(--bg-well)",
        borderRadius: "var(--radius-tile)",
        padding: "9px 11px",
      }}
    >
      <div className="faint" style={{ fontSize: 11, marginBottom: 3 }}>
        {label}
      </div>
      <div style={{ fontSize: 15, fontWeight: 600 }}>{value}</div>
    </div>
  );
}
