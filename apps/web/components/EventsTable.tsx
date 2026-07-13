"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { formatLondonTime, formatPence } from "../lib/format";
import { JsonView } from "./JsonView";
import { eventCategory, summarizeData, tint } from "./ui";
import { usePolling } from "./usePolling";
import type { EventRow, EventsResponse } from "./types";

interface Filters {
  type: string;
  q: string;
  from: string;
  to: string;
}

const EMPTY: Filters = { type: "", q: "", from: "", to: "" };

/** Searchable, filterable, paginated event stream for a project (Events tab). */
export function EventsTable({
  projectId,
  typeOptions,
}: {
  projectId: string;
  typeOptions: string[];
}) {
  const [draft, setDraft] = useState<Filters>(EMPTY);
  const [applied, setApplied] = useState<Filters>(EMPTY);
  const [rows, setRows] = useState<EventRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [loadingMore, setLoadingMore] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [autoRefresh, setAutoRefresh] = useState(false);
  const lastSeen = useRef<string | null>(null);

  const buildQs = useCallback((f: Filters) => {
    const qs = new URLSearchParams({ limit: "50" });
    if (f.type) qs.set("type", f.type);
    if (f.q) qs.set("q", f.q);
    if (f.from) qs.set("from", f.from);
    if (f.to) qs.set("to", f.to);
    return qs;
  }, []);

  const loadFirst = useCallback(
    async (f: Filters) => {
      setStatus("loading");
      try {
        const res = await fetch(
          `/api/projects/${projectId}/events?${buildQs(f).toString()}`,
          { cache: "no-store" },
        );
        if (!res.ok) throw new Error(`events ${res.status}`);
        const json = (await res.json()) as EventsResponse;
        setRows(json.events);
        setCursor(json.nextCursor);
        lastSeen.current = json.events[0]?.occurredAt ?? null;
        setStatus("ready");
      } catch {
        setStatus("error");
      }
    },
    [projectId, buildQs],
  );

  useEffect(() => {
    void loadFirst(EMPTY);
  }, [loadFirst]);

  async function loadMore() {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const qs = buildQs(applied);
      qs.set("cursor", cursor);
      const res = await fetch(
        `/api/projects/${projectId}/events?${qs.toString()}`,
        { cache: "no-store" },
      );
      if (!res.ok) throw new Error();
      const json = (await res.json()) as EventsResponse;
      setRows((prev) => {
        const seen = new Set(prev.map((e) => e.id));
        return [...prev, ...json.events.filter((e) => !seen.has(e.id))];
      });
      setCursor(json.nextCursor);
    } catch {
      // keep existing rows; surface nothing louder than the button reverting
    } finally {
      setLoadingMore(false);
    }
  }

  const refreshNewest = useCallback(async () => {
    try {
      const qs = buildQs(applied);
      if (lastSeen.current) qs.set("from", lastSeen.current);
      const res = await fetch(
        `/api/projects/${projectId}/events?${qs.toString()}`,
        { cache: "no-store" },
      );
      if (!res.ok) return;
      const json = (await res.json()) as EventsResponse;
      setRows((prev) => {
        const seen = new Set(prev.map((e) => e.id));
        const fresh = json.events.filter((e) => !seen.has(e.id));
        if (fresh.length === 0) return prev;
        const merged = [...fresh, ...prev];
        lastSeen.current = merged[0]?.occurredAt ?? lastSeen.current;
        return merged;
      });
    } catch {
      // silent — auto-refresh is best-effort
    }
  }, [projectId, applied, buildQs]);

  usePolling(refreshNewest, 5000, autoRefresh);

  function apply() {
    setApplied(draft);
    void loadFirst(draft);
  }
  function reset() {
    setDraft(EMPTY);
    setApplied(EMPTY);
    void loadFirst(EMPTY);
  }
  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const inputStyle = { height: 32, fontSize: 13 } as const;

  return (
    <div>
      {/* filter bar */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
          alignItems: "center",
          marginBottom: 14,
        }}
      >
        <select
          className="input"
          style={{ ...inputStyle, width: 190 }}
          value={draft.type}
          onChange={(e) => setDraft({ ...draft, type: e.target.value })}
          aria-label="Filter by event type"
        >
          <option value="">All types</option>
          {typeOptions.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <input
          className="input"
          style={{ ...inputStyle, width: 200 }}
          placeholder="Search data / subject / type"
          value={draft.q}
          onChange={(e) => setDraft({ ...draft, q: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Enter") apply();
          }}
          aria-label="Free-text search"
        />
        <input
          className="input"
          type="date"
          style={{ ...inputStyle, width: 150 }}
          value={draft.from}
          onChange={(e) => setDraft({ ...draft, from: e.target.value })}
          aria-label="From date"
        />
        <input
          className="input"
          type="date"
          style={{ ...inputStyle, width: 150 }}
          value={draft.to}
          onChange={(e) => setDraft({ ...draft, to: e.target.value })}
          aria-label="To date"
        />
        <button type="button" className="btn btn-sm btn-primary" onClick={apply}>
          Apply
        </button>
        <button type="button" className="btn btn-sm" onClick={reset}>
          Reset
        </button>
        <label
          style={{
            marginLeft: "auto",
            display: "inline-flex",
            alignItems: "center",
            gap: 7,
            fontSize: 12.5,
            color: "var(--text-2)",
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={autoRefresh}
            onChange={(e) => setAutoRefresh(e.target.checked)}
          />
          Auto-refresh
        </label>
      </div>

      {status === "loading" && (
        <div className="card" style={{ padding: 16, display: "grid", gap: 10 }}>
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="skeleton" style={{ height: 20 }} />
          ))}
        </div>
      )}

      {status === "error" && (
        <div className="card empty">
          <span className="empty-title">Couldn&apos;t load events</span>
          <button type="button" className="btn btn-sm" onClick={() => loadFirst(applied)}>
            Retry
          </button>
        </div>
      )}

      {status === "ready" && rows.length === 0 && (
        <div className="card empty">
          <span className="empty-title">No events yet</span>
          <span style={{ fontSize: 13 }}>Send one from the Setup tab.</span>
        </div>
      )}

      {status === "ready" && rows.length > 0 && (
        <>
          <div className="card scroll-x">
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 26 }} />
                  <th>Time</th>
                  <th>Type</th>
                  <th>Subject</th>
                  <th>Data</th>
                  <th style={{ textAlign: "right" }}>Value</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => {
                  const cat = eventCategory(e.type);
                  const open = expanded.has(e.id);
                  return (
                    <FragmentRow
                      key={e.id}
                      event={e}
                      open={open}
                      color={cat.color}
                      onToggle={() => toggle(e.id)}
                    />
                  );
                })}
              </tbody>
            </table>
          </div>

          <div style={{ display: "flex", justifyContent: "center", marginTop: 14 }}>
            {cursor ? (
              <button
                type="button"
                className="btn btn-sm"
                onClick={loadMore}
                disabled={loadingMore}
              >
                {loadingMore ? "Loading…" : "Load more"}
              </button>
            ) : (
              <span className="faint" style={{ fontSize: 12 }}>
                End of stream · {rows.length} shown
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function FragmentRow({
  event,
  open,
  color,
  onToggle,
}: {
  event: EventRow;
  open: boolean;
  color: string;
  onToggle: () => void;
}) {
  return (
    <>
      <tr
        onClick={onToggle}
        style={{ cursor: "pointer" }}
        aria-expanded={open}
      >
        <td style={{ color: "var(--text-3)", textAlign: "center" }}>
          {open ? "▾" : "▸"}
        </td>
        <td className="mono" style={{ whiteSpace: "nowrap", fontSize: 12, color: "var(--text-2)" }}>
          {formatLondonTime(event.occurredAt, true)}
        </td>
        <td>
          <span
            className="badge badge-mono"
            style={{
              color,
              background: tint(color, 0.12),
              borderColor: tint(color, 0.26),
            }}
          >
            {event.type}
          </span>
        </td>
        <td style={{ maxWidth: 160 }} className="truncate">
          {event.subject?.name ?? (
            <span className="faint">—</span>
          )}
        </td>
        <td
          className="mono truncate"
          style={{ maxWidth: 300, fontSize: 12, color: "var(--text-2)" }}
          title={summarizeData(event.data, 8)}
        >
          {summarizeData(event.data) || <span className="faint">—</span>}
        </td>
        <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
          {event.valuePence != null ? (
            <span style={{ color: "var(--green)", fontWeight: 550 }}>
              {formatPence(event.valuePence)}
            </span>
          ) : (
            <span className="faint">—</span>
          )}
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={6} style={{ background: "var(--bg-2)", padding: 14 }}>
            <JsonView value={event} />
          </td>
        </tr>
      )}
    </>
  );
}
