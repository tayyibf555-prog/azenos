"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { formatPence } from "../lib/format";
import { RelativeTime } from "./RelativeTime";
import { COLORS, tint } from "./ui";
import { IconSquircle } from "./system/IconSquircle";
import { eventTone } from "./system/tokens";
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
              boxShadow: paused ? "none" : `0 0 0 3px ${tint(COLORS.green, 0.18)}`,
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

        {events.map((e) => (
          <div
            key={e.id}
            className="row-in sys-eventchip"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 11,
              padding: "7px 14px",
              borderBottom: "1px solid var(--border)",
              fontSize: 13,
            }}
          >
            <IconSquircle tone={eventTone(e.type)} icon="spark" size={28} />
            <span style={{ minWidth: 0, flex: 1, display: "grid", gap: 1 }}>
              <span
                className="mono truncate"
                style={{ fontSize: 11.5, fontWeight: 600, color: "var(--text)" }}
              >
                {e.type}
              </span>
              <span className="faint truncate" style={{ fontSize: 11.5 }}>
                {e.projectName}
                {e.subjectName ? ` · ${e.subjectName}` : ""}
              </span>
            </span>
            {e.valuePence != null ? (
              <span style={{ flex: "none", color: "var(--green)", fontWeight: 600, fontSize: 12.5 }}>
                {formatPence(e.valuePence)}
              </span>
            ) : e.minutesSaved != null ? (
              <span className="faint" style={{ flex: "none", fontSize: 11.5 }}>
                {e.minutesSaved} min saved
              </span>
            ) : null}
            <RelativeTime
              value={e.receivedAt}
              className="faint"
            />
          </div>
        ))}
      </div>
    </section>
  );
}
