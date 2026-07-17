"use client";

import { Fragment, useState } from "react";
import { formatPence } from "../../lib/format";
import { Pill } from "../system";
import type { CostStatementClient, CostStatements } from "../money-types";

function applyMarkup(costPence: number, pct: number): number {
  return Math.round(costPence * (1 + pct / 100));
}

/**
 * Largest-remainder allocation of the client billable across project costs so
 * the per-project lines sum EXACTLY to the client billable — mirrors the
 * server (lib/server/money.ts) so an edited markup keeps the copied invoice's
 * line items reconciled with the stated Total instead of independently rounding
 * each line (which can overshoot, e.g. 13p + 13p under a 25p total).
 */
function allocateBillable(costsPence: number[], pct: number, clientBillablePence: number): number[] {
  const factor = 1 + pct / 100;
  const floors = costsPence.map((c) => Math.floor(c * factor));
  let remainder = clientBillablePence - floors.reduce((a, b) => a + b, 0);
  const out = [...floors];
  const order = costsPence
    .map((c, i) => ({ i, frac: c * factor - floors[i]! }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (remainder <= 0) break;
    out[i]! += 1;
    remainder -= 1;
  }
  return out;
}

function recompute(c: CostStatementClient, pct: number): CostStatementClient {
  const billablePence = applyMarkup(c.costPence, pct);
  const lineBillable = allocateBillable(
    c.projects.map((p) => p.costPence),
    pct,
    billablePence,
  );
  return {
    ...c,
    markupPct: pct,
    billablePence,
    markupPence: billablePence - c.costPence,
    projects: c.projects.map((p, i) => ({
      ...p,
      billablePence: lineBillable[i]!,
    })),
  };
}

/**
 * Client API-cost billing (owner requirement): monthly cost → markup →
 * billable, per client, with an inline markup editor and a copy-as-invoice
 * affordance. PATCHes /api/clients/[clientId]/markup.
 */
export function CostStatementsPanel({ initial }: { initial: CostStatements }) {
  const [clients, setClients] = useState(initial.clients);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const totals = clients.reduce(
    (a, c) => ({
      cost: a.cost + c.costPence,
      markup: a.markup + c.markupPence,
      billable: a.billable + c.billablePence,
    }),
    { cost: 0, markup: 0, billable: 0 },
  );

  async function saveMarkup(clientId: string, pct: number) {
    setClients((prev) =>
      prev.map((c) => (c.clientId === clientId ? recompute(c, pct) : c)),
    );
    try {
      await fetch(`/api/clients/${clientId}/markup`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pct }),
      });
    } catch {
      // optimistic; a failed save simply won't persist across reloads
    }
  }

  async function copyInvoice(c: CostStatementClient) {
    const lines = [
      `${c.clientName} — API & hosting costs (${initial.month})`,
      ...c.projects
        .filter((p) => p.billablePence > 0)
        .map((p) => `  ${p.name}: ${formatPence(p.billablePence)}`),
      `Total: ${formatPence(c.billablePence)}${c.markupPct ? ` (incl. ${c.markupPct}% markup)` : ""}`,
    ].join("\n");
    try {
      await navigator.clipboard.writeText(lines);
      setCopied(c.clientId);
      setTimeout(() => setCopied(null), 1800);
    } catch {
      setCopied(null);
    }
  }

  return (
    <div className="card" style={{ padding: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
        <h3 style={{ fontSize: 14, fontWeight: 620 }}>Client cost statements</h3>
        <span className="faint" style={{ fontSize: 12 }}>{initial.month}</span>
      </div>
      <p className="faint" style={{ fontSize: 12.5, marginBottom: 12 }}>
        OS agent + client-system AI cost per client, marked up for invoicing.
        Default markup {initial.defaultMarkupPct}%.{" "}
        {initial.includeClientEmitted
          ? "Both streams are billed; the client-system AI provider split is shown below."
          : "The client's own key spend is shown separately below and is not billed."}
      </p>

      {clients.length === 0 ? (
        <div className="faint" style={{ fontSize: 13 }}>No clients with attributed cost this month.</div>
      ) : (
        <div className="scroll-x">
          <table className="table">
            <thead>
              <tr>
                <th>Client</th>
                <th style={{ textAlign: "right" }}>Cost</th>
                <th style={{ textAlign: "right" }}>Markup %</th>
                <th style={{ textAlign: "right" }}>Billable</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {clients.map((c) => (
                <Fragment key={c.clientId}>
                  <tr>
                    <td>
                      <button
                        type="button"
                        className="btn-ghost"
                        style={{ padding: 0, fontWeight: 550 }}
                        onClick={() => setExpanded((e) => (e === c.clientId ? null : c.clientId))}
                      >
                        {expanded === c.clientId ? "▾" : "▸"} {c.clientName}
                      </button>
                    </td>
                    <td className="tnum" style={{ textAlign: "right" }}>{formatPence(c.costPence)}</td>
                    <td className="tnum" style={{ textAlign: "right" }}>
                      <MarkupEditor
                        value={c.markupPct}
                        onSave={(pct) => saveMarkup(c.clientId, pct)}
                      />
                    </td>
                    <td className="tnum" style={{ textAlign: "right", fontWeight: 600, color: "var(--green)" }}>
                      {formatPence(c.billablePence)}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <button type="button" className="btn btn-sm" onClick={() => copyInvoice(c)}>
                        {copied === c.clientId ? "Copied ✓" : "Copy lines"}
                      </button>
                    </td>
                  </tr>
                  {expanded === c.clientId &&
                    c.projects.map((p) => (
                      <tr key={p.projectId} style={{ background: "var(--bg-well)" }}>
                        <td style={{ paddingLeft: 24 }} className="faint">{p.name}</td>
                        <td style={{ textAlign: "right" }} className="faint tnum">{formatPence(p.costPence)}</td>
                        <td />
                        <td style={{ textAlign: "right" }} className="faint tnum">{formatPence(p.billablePence)}</td>
                        <td />
                      </tr>
                    ))}
                </Fragment>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ fontWeight: 600 }}>
                <td>Total</td>
                <td className="tnum" style={{ textAlign: "right" }}>{formatPence(totals.cost)}</td>
                <td />
                <td className="tnum" style={{ textAlign: "right", color: "var(--green)" }}>{formatPence(totals.billable)}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {initial.totalClientEmittedPence > 0 && (
        <div
          style={{
            marginTop: 14,
            padding: 14,
            background: "var(--bg-well)",
            borderRadius: "var(--radius-tile)",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
            <h4 style={{ fontSize: 13, fontWeight: 600 }}>
              Client-system AI · by provider{" "}
              <span className="faint" style={{ fontWeight: 400 }}>
                {initial.includeClientEmitted
                  ? "· billed with markup (included above)"
                  : "· their own key spend — not billed"}
              </span>
            </h4>
            <span className="tnum" style={{ fontSize: 13, fontWeight: 600 }}>
              {formatPence(initial.totalClientEmittedPence)}
            </span>
          </div>
          {initial.providerTotals.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
              {initial.providerTotals.map((p) => (
                <span key={p.provider} className="tnum">
                  <Pill tone="lavender">
                    {p.label} · {formatPence(p.pence)}
                  </Pill>
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function MarkupEditor({
  value,
  onSave,
}: {
  value: number;
  onSave: (pct: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(value));

  if (!editing) {
    return (
      <button
        type="button"
        className="btn-ghost"
        style={{ padding: "2px 6px", fontSize: 13 }}
        onClick={() => {
          setDraft(String(value));
          setEditing(true);
        }}
      >
        {value}%
      </button>
    );
  }
  return (
    <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
      <input
        className="input"
        style={{ width: 56, padding: "2px 6px", textAlign: "right" }}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        inputMode="numeric"
        autoFocus
      />
      <button
        type="button"
        className="btn btn-sm btn-primary"
        onClick={() => {
          const pct = Math.max(0, Math.min(1000, Math.round(Number(draft) || 0)));
          onSave(pct);
          setEditing(false);
        }}
      >
        ✓
      </button>
    </span>
  );
}
