"use client";

import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Sparkline } from "./Sparkline";
import { COLORS } from "./ui";
import type { ApiErrorShape, SparklinesResponse } from "./metrics-types";

type StripState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; sparklines: SparklinesResponse["sparklines"] };

const SparklineContext = createContext<StripState>({ status: "loading" });

/**
 * Projects-list sparklines (§Metrics UI): mounted ONCE around the card grid,
 * makes a single batched fetch to /api/projects/sparklines and distributes the
 * per-project payloads through context. Each card renders <ProjectSparkline/>.
 */
export function SparklineStrip({ children }: { children: ReactNode }) {
  const [state, setState] = useState<StripState>({ status: "loading" });

  useEffect(() => {
    let alive = true;
    fetch("/api/projects/sparklines?days=7", { cache: "no-store" })
      .then(async (res) => {
        const json = (await res.json()) as SparklinesResponse | ApiErrorShape;
        if (!alive) return;
        if (!res.ok || "error" in json) {
          setState({ status: "error" });
          return;
        }
        setState({ status: "ready", sparklines: json.sparklines ?? {} });
      })
      .catch(() => {
        if (alive) setState({ status: "error" });
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <SparklineContext.Provider value={state}>
      {children}
    </SparklineContext.Provider>
  );
}

export function ProjectSparkline({ projectId }: { projectId: string }) {
  const state = useContext(SparklineContext);

  if (state.status === "loading") {
    return <div className="skeleton" style={{ height: 28, width: 120 }} />;
  }
  if (state.status === "error") {
    return <div style={{ height: 28, width: 120 }} aria-hidden />;
  }

  const payload = state.sparklines[projectId];
  const values = payload?.points?.map((p) => p.value) ?? [];

  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end" }}>
      <Sparkline points={values} color={COLORS.blue} />
    </div>
  );
}
