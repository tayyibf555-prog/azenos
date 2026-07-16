"use client";

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { AnalyticsRange } from "../types";

/**
 * Shared plumbing for the analytics sections. The foundation ships every
 * section as a stub built on this shell; wave-1 agents keep the
 * `useSectionData` fetch contract and the `SectionFrame` chrome, then swap the
 * placeholder body for real charts. Fetches never throw — a failed/empty
 * response falls back to a calm note, never a crash.
 */

export type SectionState<T> =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; data: T };

export function useSectionData<T>(
  slug: string,
  projectId: string,
  range: AnalyticsRange,
): SectionState<T> {
  const [state, setState] = useState<SectionState<T>>({ status: "loading" });
  useEffect(() => {
    let alive = true;
    setState({ status: "loading" });
    fetch(`/api/projects/${projectId}/analytics/${slug}?range=${range}`, {
      cache: "no-store",
    })
      .then(async (res) => {
        const json: unknown = await res.json().catch(() => null);
        if (!alive) return;
        if (
          !res.ok ||
          (json !== null && typeof json === "object" && "error" in json)
        ) {
          setState({ status: "error" });
          return;
        }
        setState({ status: "ready", data: json as T });
      })
      .catch(() => {
        if (alive) setState({ status: "error" });
      });
    return () => {
      alive = false;
    };
  }, [slug, projectId, range]);
  return state;
}

/** Section title block. */
export function SectionFrame({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <section style={{ display: "grid", gap: 16 }}>
      <div>
        <h2 style={{ fontSize: 17, fontWeight: 640 }}>{title}</h2>
        {subtitle && (
          <p className="muted" style={{ fontSize: 13, marginTop: 3 }}>
            {subtitle}
          </p>
        )}
      </div>
      {children}
    </section>
  );
}

/** Loading shimmer card. */
export function SectionSkeleton() {
  return (
    <div className="card" style={{ padding: 20, display: "grid", gap: 12 }}>
      <div className="skeleton" style={{ height: 40, width: 160 }} />
      <div className="skeleton" style={{ height: 140, width: "100%" }} />
    </div>
  );
}

/** Placeholder body shown until a wave-1 agent wires the real charts. */
export function ComingOnline({ note }: { note: string }) {
  return (
    <div
      className="card"
      style={{
        padding: 24,
        display: "grid",
        gap: 6,
        borderStyle: "dashed",
        placeItems: "center",
        textAlign: "center",
      }}
    >
      <span className="empty-title">Coming online</span>
      <span className="faint" style={{ fontSize: 12.5, maxWidth: 420 }}>
        {note}
      </span>
    </div>
  );
}
