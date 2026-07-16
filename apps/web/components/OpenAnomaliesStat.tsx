"use client";

import { useEffect, useState } from "react";
import { StatCell } from "./system";

/**
 * The Command Center's 6th StatCell — open-anomaly count. Reads the SAME
 * /api/overview endpoint the page already consumes (previously via
 * OverviewHealth) so the whole StatRow stays one row without a new server
 * query. Renders "—" until loaded so the strip never reflows.
 */
export function OpenAnomaliesStat() {
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/overview", { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) return;
        const json = (await res.json()) as { openAnomalies?: number };
        if (alive && typeof json.openAnomalies === "number") {
          setCount(json.openAnomalies);
        }
      })
      .catch(() => {
        /* stat degrades to — on failure */
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <StatCell
      label="Open anomalies"
      value={count === null ? "—" : count.toLocaleString("en-GB")}
    />
  );
}
