"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Pill, TINTS } from "./system";

interface HealthSummary {
  green: number;
  amber: number;
  red: number;
}

interface OverviewExtras {
  healthSummary?: HealthSummary;
  openAnomalies?: number;
}

/**
 * Command Center hero strip (§Metrics UI): live health dots + open-anomaly
 * count from the extended /api/overview. Both fields are read defensively —
 * if the API hasn't shipped them yet, the component renders nothing.
 */
export function OverviewHealth() {
  const [data, setData] = useState<OverviewExtras | null>(null);
  // Deep-link target for the open-anomalies badge (contract: "first project w/
  // anomalies"). /api/overview only ships a scalar count, so the specific
  // project is resolved from existing read-only endpoints. null = fall back to
  // the generic list.
  const [anomalyProjectId, setAnomalyProjectId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/overview", { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) return;
        const json = (await res.json()) as OverviewExtras;
        if (alive) setData(json);
      })
      .catch(() => {
        /* hero degrades to nothing on failure */
      });
    return () => {
      alive = false;
    };
  }, []);

  // Resolve the first project carrying a new anomaly insight, in projects-list
  // order. Only runs when the overview reports open anomalies.
  useEffect(() => {
    if (!data || (data.openAnomalies ?? 0) <= 0) {
      setAnomalyProjectId(null);
      return;
    }
    let alive = true;
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch("/api/projects", {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!res.ok) return;
        const json = (await res.json()) as { projects?: { id: string }[] };
        const projects = json.projects ?? [];
        const checks = await Promise.all(
          projects.map(async (p) => {
            try {
              const r = await fetch(
                `/api/projects/${p.id}/insights?status=new&limit=20`,
                { cache: "no-store", signal: controller.signal },
              );
              if (!r.ok) return { id: p.id, hasAnomaly: false };
              const body = (await r.json()) as {
                insights?: { kind: string }[];
              };
              return {
                id: p.id,
                hasAnomaly: (body.insights ?? []).some(
                  (i) => i.kind === "anomaly",
                ),
              };
            } catch {
              return { id: p.id, hasAnomaly: false };
            }
          }),
        );
        const first = checks.find((c) => c.hasAnomaly);
        if (alive) setAnomalyProjectId(first ? first.id : null);
      } catch {
        /* leave the badge pointing at the generic list on failure */
      }
    })();
    return () => {
      alive = false;
      controller.abort();
    };
  }, [data]);

  if (!data) return null;
  const hs = data.healthSummary;
  const anomalies =
    typeof data.openAnomalies === "number" ? data.openAnomalies : null;
  if (!hs && anomalies === null) return null;
  const anomalyHref = anomalyProjectId
    ? `/projects/${anomalyProjectId}`
    : "/projects";

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        flexWrap: "wrap",
        gap: 16,
        fontSize: 13,
      }}
    >
      {hs && (
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <span className="faint" style={{ fontSize: 12 }}>
            Project health
          </span>
          <HealthCount color={TINTS.mint.fg} label="green" n={hs.green ?? 0} />
          <HealthCount color={TINTS.butter.fg} label="amber" n={hs.amber ?? 0} />
          <HealthCount color={TINTS.rose.fg} label="red" n={hs.red ?? 0} />
        </div>
      )}

      {anomalies !== null && (
        <Link href={anomalyHref} style={{ textDecoration: "none" }}>
          <Pill tone={anomalies > 0 ? "rose" : "graphite"}>
            {anomalies > 0 ? "●" : "○"} {anomalies} open{" "}
            {anomalies === 1 ? "anomaly" : "anomalies"}
          </Pill>
        </Link>
      )}
    </div>
  );
}

function HealthCount({
  color,
  label,
  n,
}: {
  color: string;
  label: string;
  n: number;
}) {
  return (
    <span
      style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
      title={`${n} ${label}`}
    >
      <span className="dot" style={{ background: color }} />
      <span style={{ fontWeight: 600 }}>{n}</span>
    </span>
  );
}
