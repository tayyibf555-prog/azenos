"use client";

import { useEffect, useState } from "react";
import { COLORS } from "./ui";
import {
  IconSquircle,
  List,
  ListRow,
  Pill,
  StatusDot,
} from "./system";

interface OverviewExtras {
  healthSummary?: { green: number; amber: number; red: number };
  openAnomalies?: number;
}

/**
 * §5 rail alerts card — open anomalies + the project-health breakdown, as
 * compact ListRows. Reads the SAME /api/overview endpoint the page already
 * consumes; renders nothing extra until loaded.
 */
export function HealthAlertsCard() {
  const [data, setData] = useState<OverviewExtras | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/overview", { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) return;
        const json = (await res.json()) as OverviewExtras;
        if (alive) setData(json);
      })
      .catch(() => {
        /* card degrades to skeleton on failure */
      });
    return () => {
      alive = false;
    };
  }, []);

  if (!data) {
    return (
      <div style={{ display: "grid", gap: 8 }}>
        {[0, 1].map((i) => (
          <div key={i} className="skeleton" style={{ height: 28 }} />
        ))}
      </div>
    );
  }

  const anomalies = data.openAnomalies ?? 0;
  const hs = data.healthSummary;

  return (
    <List>
      <ListRow
        href="/health"
        leading={
          <IconSquircle tone={anomalies > 0 ? "rose" : "mint"} icon={anomalies > 0 ? "alert" : "check"} size={28} />
        }
        primary="Open anomalies"
        secondary={anomalies > 0 ? "Need a look" : "All clear"}
        meta={
          <Pill tone={anomalies > 0 ? "rose" : "mint"}>
            {anomalies.toLocaleString("en-GB")}
          </Pill>
        }
      />
      {hs ? (
        <ListRow
          href="/health"
          leading={<IconSquircle tone="sky" icon="activity" size={28} />}
          primary="Project health"
          secondary="Live across the portfolio"
          meta={
            <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
              <StatusDot color={COLORS.green} label={String(hs.green)} />
              <StatusDot color={COLORS.amber} label={String(hs.amber)} />
              <StatusDot color={COLORS.red} label={String(hs.red)} />
            </span>
          }
        />
      ) : null}
    </List>
  );
}
