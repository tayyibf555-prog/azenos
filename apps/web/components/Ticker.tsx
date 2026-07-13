"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { formatPence } from "../lib/format";
import { RelativeTime } from "./RelativeTime";
import { eventCategory, tint } from "./ui";
import { usePolling } from "./usePolling";
import type { TickerEvent, TickerResponse } from "./types";

const CAP = 50;

/** Live event ticker — polls /api/ticker every 2.5s with incremental afterId. */
export function Ticker() {
  const [events, setEvents] = useState<TickerEvent[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [paused, setPaused] = useState(false);
  const newestId = useRef<string | null>(null);

  const load = useCallback(async (afterId: string | null) => {
    try {
      const qs = new URLSearchParams({ limit: "30" });
      if (afterId) qs.set("afterId", afterId);
      const res = await fetch(`/api/ticker?${qs.toString()}`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`ticker ${res.status}`);
      const json = (await res.json()) as TickerResponse;
      setEvents((prev) => {
        if (json.events.length === 0) return prev;
        const seen = new Set(prev.map((e) => e.id));
        const fresh = json.events.filter((e) => !seen.has(e.id));
        if (fresh.length === 0) return prev;
        const merged = [...fresh, ...prev].slice(0, CAP);
        newestId.current = merged[0]?.id ?? newestId.current;
        return merged;
      });
      setStatus("ready");
    } catch {
      setStatus((s) => (s === "loading" ? "error" : s));
    }
  }, []);

  useEffect(() => {
    void load(null);
  }, [load]);

  usePolling(() => void load(newestId.current), 2500, !paused);

  return (
    <section className="card" style={{ display: "flex", flexDirection: "column", minHeight: 320 }}>
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "13px 16px",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
          <span
            className={paused ? undefined : "pulse"}
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: paused ? "var(--text-3)" : "var(--green)",
              boxShadow: paused ? "none" : `0 0 0 3px ${tint("#3fb27f", 0.18)}`,
            }}
            aria-hidden
          />
          <h3 style={{ fontSize: 14 }}>Live activity</h3>
          <span className="faint" style={{ fontSize: 12 }}>
            across every client system
          </span>
        </div>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => setPaused((p) => !p)}
          aria-pressed={paused}
        >
          {paused ? "Resume" : "Pause"}
        </button>
      </header>

      <div style={{ overflowY: "auto", flex: 1, maxHeight: 520 }}>
        {status === "loading" && (
          <div style={{ padding: 16, display: "grid", gap: 10 }}>
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="skeleton" style={{ height: 18 }} />
            ))}
          </div>
        )}

        {status === "error" && events.length === 0 && (
          <div className="empty">
            <span className="empty-title">Couldn&apos;t reach the ticker</span>
            <span style={{ fontSize: 13 }}>It will retry automatically.</span>
          </div>
        )}

        {status === "ready" && events.length === 0 && (
          <div className="empty">
            <span className="empty-title">Waiting for events</span>
            <span style={{ fontSize: 13 }}>
              Send one from any project&apos;s Setup tab to see it here.
            </span>
          </div>
        )}

        {events.map((e) => {
          const cat = eventCategory(e.type);
          return (
            <div
              key={e.id}
              className="row-in"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "9px 16px",
                borderBottom: "1px solid var(--border)",
                fontSize: 13,
              }}
            >
              <RelativeTime
                value={e.receivedAt}
                className="faint"
              />
              <span
                className="badge badge-mono"
                style={{
                  color: cat.color,
                  background: tint(cat.color, 0.12),
                  borderColor: tint(cat.color, 0.26),
                  flex: "none",
                }}
              >
                {e.type}
              </span>
              <span
                className="muted truncate"
                style={{ flex: "none", maxWidth: 150 }}
                title={e.projectName}
              >
                {e.projectName}
              </span>
              <span className="truncate" style={{ flex: 1, color: "var(--text-2)" }}>
                {e.subjectName ?? ""}
              </span>
              {e.valuePence != null ? (
                <span style={{ flex: "none", color: "var(--green)", fontWeight: 550 }}>
                  {formatPence(e.valuePence)}
                </span>
              ) : e.minutesSaved != null ? (
                <span className="faint" style={{ flex: "none" }}>
                  {e.minutesSaved} min saved
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
