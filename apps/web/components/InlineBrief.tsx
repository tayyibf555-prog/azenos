"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { formatLondonDate } from "../lib/format";
import type { BriefDetail, LatestBriefResponse } from "./brief-types";
import { DeliveryChips } from "./DeliveryChips";
import { Markdown } from "./Markdown";

type State =
  | { status: "loading" }
  | { status: "error" }
  | { status: "empty" }
  | { status: "ready"; brief: BriefDetail };

/**
 * Inline latest daily brief on the Command Center — headline, agency summary +
 * needs-attention (from the rendered body), and a "view full" link into the
 * archive. Fetches GET /api/briefs/latest defensively: 404 / null / network
 * error all degrade to a quiet empty or error state, never a crash.
 */
export function InlineBrief() {
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    let alive = true;
    fetch("/api/briefs/latest", { cache: "no-store" })
      .then(async (res) => {
        if (!alive) return;
        if (!res.ok) {
          setState({ status: res.status === 404 ? "empty" : "error" });
          return;
        }
        const json = (await res.json()) as LatestBriefResponse;
        if (!alive) return;
        if (!json.brief) setState({ status: "empty" });
        else setState({ status: "ready", brief: json.brief });
      })
      .catch(() => {
        if (alive) setState({ status: "error" });
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <section className="card" style={{ padding: 0 }}>
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          padding: "13px 18px",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
          <span
            className="dot"
            style={{ width: 8, height: 8, background: "var(--accent)" }}
            aria-hidden
          />
          <h3 style={{ fontSize: 14 }}>Today&apos;s brief</h3>
          {state.status === "ready" && (
            <span className="faint" style={{ fontSize: 12 }}>
              {formatLondonDate(state.brief.periodStart)}
            </span>
          )}
        </div>
        <Link href="/briefs" className="btn btn-ghost btn-sm">
          View full →
        </Link>
      </header>

      <div style={{ padding: "16px 18px" }}>
        {state.status === "loading" && (
          <div style={{ display: "grid", gap: 10 }}>
            <div className="skeleton" style={{ height: 18, width: "70%" }} />
            <div className="skeleton" style={{ height: 14 }} />
            <div className="skeleton" style={{ height: 14, width: "85%" }} />
          </div>
        )}

        {state.status === "error" && (
          <p className="muted" style={{ fontSize: 13 }}>
            Couldn&apos;t load the latest brief. It will appear here once ready.
          </p>
        )}

        {state.status === "empty" && (
          <div style={{ display: "grid", gap: 6 }}>
            <span className="empty-title" style={{ fontSize: 13.5 }}>
              No brief yet
            </span>
            <span className="muted" style={{ fontSize: 13 }}>
              The daily brief runs each morning (07:00 London). Generate one from{" "}
              <Link href="/briefs" style={{ color: "var(--accent)" }}>
                Briefs
              </Link>
              .
            </span>
          </div>
        )}

        {state.status === "ready" && (
          <div style={{ display: "grid", gap: 12 }}>
            <div
              style={{
                fontSize: 16.5,
                fontWeight: 650,
                letterSpacing: "-0.01em",
                lineHeight: 1.4,
              }}
            >
              {state.brief.headline}
            </div>
            <Markdown source={state.brief.bodyMd} />
            <DeliveryChips
              status={state.brief.status}
              sentEmailAt={state.brief.sentEmailAt}
              sentWhatsappAt={state.brief.sentWhatsappAt}
            />
          </div>
        )}
      </div>
    </section>
  );
}
