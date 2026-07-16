"use client";

import { useEffect, useState } from "react";
import type { ProjectDraft } from "../../lib/server/intake/schema";
import type { ClientRow, ClientsResponse } from "../types";

/**
 * Step 1 — pick an existing client or start a new one. Deliberately
 * self-contained (not a fork of NewProjectForm's inline picker — that
 * component lives outside this workstream's file ownership) but talks to the
 * SAME `/api/clients` list route.
 */
export function StepClient({
  draft,
  onChange,
}: {
  draft: ProjectDraft;
  onChange: (client: ProjectDraft["client"]) => void;
}) {
  const [clients, setClients] = useState<ClientRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/clients", { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<ClientsResponse>) : null))
      .then((j) => {
        if (cancelled || !j) return;
        setClients(j.clients);
        if (j.clients.length === 0 && draft.client.match === "existing") {
          onChange({ match: "new", clientId: null, name: "", industrySlug: null });
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const c = draft.client;

  return (
    <div style={{ maxWidth: 480, display: "grid", gap: 14 }}>
      <div
        role="tablist"
        aria-label="Client mode"
        style={{
          display: "inline-flex",
          gap: 3,
          padding: 3,
          background: "var(--card-2)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-sm)",
        }}
      >
        <button
          type="button"
          role="tab"
          aria-selected={c.match === "existing"}
          className={c.match === "existing" ? "btn btn-primary btn-sm" : "btn btn-ghost btn-sm"}
          onClick={() =>
            onChange({ match: "existing", clientId: c.clientId, name: c.name, industrySlug: c.industrySlug })
          }
          disabled={clients.length === 0}
        >
          Existing client
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={c.match === "new"}
          className={c.match === "new" ? "btn btn-primary btn-sm" : "btn btn-ghost btn-sm"}
          onClick={() =>
            onChange({ match: "new", clientId: null, name: c.name, industrySlug: c.industrySlug })
          }
        >
          New client
        </button>
      </div>

      {c.match === "existing" ? (
        <div>
          <label className="label" htmlFor="wiz-client">
            Client
          </label>
          <select
            id="wiz-client"
            className="input"
            value={c.clientId ?? ""}
            onChange={(e) =>
              onChange({ ...c, clientId: e.target.value || null })
            }
            disabled={loading}
          >
            <option value="">Select a client…</option>
            {clients.map((cl) => (
              <option key={cl.id} value={cl.id}>
                {cl.name}
              </option>
            ))}
          </select>
          {loading && (
            <p className="faint" style={{ fontSize: 12, marginTop: 6 }}>
              Loading clients…
            </p>
          )}
        </div>
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          <div>
            <label className="label" htmlFor="wiz-client-name">
              Client name
            </label>
            <input
              id="wiz-client-name"
              className="input"
              value={c.name}
              onChange={(e) => onChange({ ...c, name: e.target.value })}
              placeholder="Bright Smile Dental"
            />
          </div>
          <div>
            <label className="label" htmlFor="wiz-client-industry">
              Industry slug <span className="faint">(optional)</span>
            </label>
            <input
              id="wiz-client-industry"
              className="input"
              value={c.industrySlug ?? ""}
              onChange={(e) =>
                onChange({ ...c, industrySlug: e.target.value || null })
              }
              placeholder="dental"
            />
          </div>
        </div>
      )}
    </div>
  );
}
