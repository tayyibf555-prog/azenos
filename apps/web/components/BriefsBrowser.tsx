"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { DeliveryChips } from "./DeliveryChips";
import { Pill } from "./system/Pill";
import type { SquircleTone } from "./system/tokens";
import type { BriefPeriod, BriefStatus } from "./brief-types";

/**
 * Client-side Briefs browser with scope + client + period filters
 * (docs/phase5/CONTRACTS.md §P5-MONTHLY — "ensure the per-client value reports
 * are findable"). Rows are pre-serialised by the server page; filtering is a
 * pure in-browser narrow, so it stays fast and needs no round trips. The monthly
 * per-client value reports and upsell dossiers carry a docType + clientName so
 * they surface as their own labelled, filterable cards.
 */

export interface BriefRow {
  id: string;
  period: BriefPeriod;
  scope: string;
  /** owner_report | client_value_report | upsell_dossier (monthly docs only) */
  docType: string | null;
  clientName: string | null;
  headline: string;
  periodStartLabel: string;
  createdLabel: string;
  status: BriefStatus;
  sentEmailAt: string | null;
  sentWhatsappAt: string | null;
}

/** RECIPE §3: brief cadence reads as a tinted pill, category = tone (matches the detail page). */
const PERIOD_TONE: Record<string, SquircleTone> = {
  daily: "sky",
  weekly: "lavender",
  monthly: "butter",
};

const DOC_LABEL: Record<string, string> = {
  owner_report: "Owner report",
  client_value_report: "Value report",
  upsell_dossier: "Upsell dossier",
};

type PeriodFilter = "all" | BriefPeriod;
type ScopeFilter = "all" | "agency" | "project";

const PERIODS: PeriodFilter[] = ["all", "daily", "weekly", "monthly"];
const SCOPES: ScopeFilter[] = ["all", "agency", "project"];

/** RECIPE §3 pill mandate: content-area filter — black active pill, quiet at rest. */
function FilterButton({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={active ? "tab tab-active" : "tab"}
      onClick={onClick}
      style={{ height: 26, padding: "0 12px", fontSize: 12, textTransform: "capitalize" }}
    >
      {label}
    </button>
  );
}

export function BriefsBrowser({ rows }: { rows: BriefRow[] }) {
  const [period, setPeriod] = useState<PeriodFilter>("all");
  const [scope, setScope] = useState<ScopeFilter>("all");
  const [client, setClient] = useState<string>("all");

  const clientNames = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) if (r.clientName) set.add(r.clientName);
    return [...set].sort();
  }, [rows]);

  const filtered = useMemo(
    () =>
      rows.filter((r) => {
        if (period !== "all" && r.period !== period) return false;
        if (scope !== "all" && r.scope !== scope) return false;
        if (client !== "all" && r.clientName !== client) return false;
        return true;
      }),
    [rows, period, scope, client],
  );

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div
        className="card"
        style={{ padding: "12px 14px", display: "grid", gap: 10 }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span className="faint" style={{ fontSize: 11.5, width: 52 }}>
            Period
          </span>
          {PERIODS.map((p) => (
            <FilterButton
              key={p}
              active={period === p}
              label={p}
              onClick={() => setPeriod(p)}
            />
          ))}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span className="faint" style={{ fontSize: 11.5, width: 52 }}>
            Scope
          </span>
          {SCOPES.map((s) => (
            <FilterButton
              key={s}
              active={scope === s}
              label={s}
              onClick={() => setScope(s)}
            />
          ))}
        </div>
        {clientNames.length > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span className="faint" style={{ fontSize: 11.5, width: 52 }}>
              Client
            </span>
            <FilterButton
              active={client === "all"}
              label="all"
              onClick={() => setClient("all")}
            />
            {clientNames.map((name) => (
              <FilterButton
                key={name}
                active={client === name}
                label={name}
                onClick={() => setClient(name)}
              />
            ))}
          </div>
        )}
      </div>

      {filtered.length === 0 ? (
        <div className="card">
          <div className="empty">
            <span className="empty-title">No briefs match these filters</span>
            <span style={{ fontSize: 13 }}>Clear a filter to see more.</span>
          </div>
        </div>
      ) : (
        <div style={{ display: "grid", gap: 10 }}>
          {filtered.map((r) => {
            const docLabel = r.docType ? DOC_LABEL[r.docType] : undefined;
            return (
              <Link
                key={r.id}
                href={`/briefs/${r.id}`}
                className="card hoverable"
                style={{ padding: "15px 18px", display: "grid", gap: 10 }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    flexWrap: "wrap",
                  }}
                >
                  <Pill tone={PERIOD_TONE[r.period] ?? "graphite"}>{r.period}</Pill>
                  {docLabel && <Pill tone="sky">{docLabel}</Pill>}
                  {r.clientName && <Pill>{r.clientName}</Pill>}
                  <span className="faint" style={{ fontSize: 12 }}>
                    {r.scope} · {r.periodStartLabel}
                  </span>
                  <span style={{ marginLeft: "auto" }}>
                    <DeliveryChips
                      status={r.status}
                      sentEmailAt={r.sentEmailAt}
                      sentWhatsappAt={r.sentWhatsappAt}
                    />
                  </span>
                </div>
                <div style={{ fontSize: 15, fontWeight: 600, letterSpacing: "-0.01em" }}>
                  {r.headline}
                </div>
                <div className="faint" style={{ fontSize: 11.5 }}>
                  Generated {r.createdLabel}
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
