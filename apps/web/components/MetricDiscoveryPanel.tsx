"use client";

import { useEffect, useState } from "react";
import { COLORS, tint } from "./ui";
import type {
  ApiErrorShape,
  CreateMetricBody,
  DiscoveredMetricView,
  MetricDiscoveryResponse,
} from "./metrics-types";

/**
 * Metrics tab "Available to add (N)" panel (§P9-W0B). Reads
 * GET /metrics/discovery (pure presence check — no writes) and renders each
 * unlocked template as a dense number-first tile with its "why" evidence;
 * one click POSTs the template straight to the EXISTING
 * POST /api/projects/[projectId]/metrics create endpoint — no new write path.
 */
export function MetricDiscoveryPanel({
  projectId,
  onAdded,
}: {
  projectId: string;
  onAdded: () => void;
}) {
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "error" }
    | { status: "ready"; data: MetricDiscoveryResponse }
  >({ status: "loading" });
  const [adding, setAdding] = useState<Record<string, boolean>>({});
  const [added, setAdded] = useState<Record<string, boolean>>({});
  const [expanded, setExpanded] = useState(true);

  useEffect(() => {
    let alive = true;
    setState({ status: "loading" });
    fetch(`/api/projects/${projectId}/metrics/discovery`, { cache: "no-store" })
      .then(async (res) => {
        if (!alive) return;
        if (!res.ok) {
          setState({ status: "error" });
          return;
        }
        const json = (await res.json()) as MetricDiscoveryResponse;
        setState({ status: "ready", data: json });
      })
      .catch(() => {
        if (alive) setState({ status: "error" });
      });
    return () => {
      alive = false;
    };
  }, [projectId]);

  async function addTemplate(tpl: DiscoveredMetricView) {
    if (adding[tpl.key] || added[tpl.key]) return;
    setAdding((a) => ({ ...a, [tpl.key]: true }));
    try {
      const body: CreateMetricBody = {
        key: tpl.key,
        name: tpl.name,
        description: tpl.description,
        unit: tpl.unit,
        aggregation: tpl.aggregation,
        eventType: tpl.eventType,
        valuePath: tpl.valuePath,
        whereEquals: tpl.whereEquals,
        goodDirection: tpl.goodDirection,
        isKpi: tpl.isKpi,
      };
      const res = await fetch(`/api/projects/${projectId}/metrics`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        cache: "no-store",
      });
      if (res.status === 201 || res.status === 409) {
        // 409 (already exists) is a harmless race with another tab — treat
        // as success so the tile still settles into the "added" state.
        setAdded((a) => ({ ...a, [tpl.key]: true }));
        onAdded();
        return;
      }
      const err = (await res.json().catch(() => null)) as ApiErrorShape | null;
      console.error("[metric-discovery] add failed:", err?.error ?? res.status);
    } catch (e) {
      console.error("[metric-discovery] add failed:", e);
    } finally {
      setAdding((a) => {
        const next = { ...a };
        delete next[tpl.key];
        return next;
      });
    }
  }

  if (state.status === "loading") {
    return <div className="skeleton" style={{ height: 64 }} />;
  }
  if (state.status === "error") {
    return null; // discovery is additive — a failed fetch never blocks the tab
  }

  const { available, missing } = state.data;
  if (available.length === 0) {
    const requiredMissing = missing.filter((m) => m.required);
    if (requiredMissing.length === 0) return null;
    return (
      <div className="card" style={{ padding: "12px 16px" }}>
        <span className="faint" style={{ fontSize: 12.5 }}>
          No new metrics to add yet — send{" "}
          <code className="mono">{requiredMissing[0]!.type}</code>
          {requiredMissing.length > 1 ? ` (+${requiredMissing.length - 1} more)` : ""}{" "}
          to unlock more.
        </span>
      </div>
    );
  }

  return (
    <section className="card" style={{ padding: 16 }}>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          width: "100%",
          background: "none",
          border: "none",
          cursor: "pointer",
          padding: 0,
        }}
        aria-expanded={expanded}
      >
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <h3 style={{ fontSize: 14, margin: 0 }}>
            Available to add ({available.length})
          </h3>
        </span>
        <span className="faint" style={{ fontSize: 12 }}>
          {expanded ? "Hide" : "Show"}
        </span>
      </button>

      {expanded && (
        <div
          style={{
            marginTop: 14,
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
            gap: 10,
          }}
        >
          {available.map((tpl) => (
            <DiscoveryTile
              key={tpl.key}
              tpl={tpl}
              busy={Boolean(adding[tpl.key])}
              done={Boolean(added[tpl.key])}
              onAdd={() => addTemplate(tpl)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function DiscoveryTile({
  tpl,
  busy,
  done,
  onAdd,
}: {
  tpl: DiscoveredMetricView;
  busy: boolean;
  done: boolean;
  onAdd: () => void;
}) {
  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-sm)",
        background: "var(--card-2)",
        padding: 12,
        display: "grid",
        gap: 6,
        alignContent: "start",
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.25 }}>{tpl.name}</span>
        <span
          className="badge"
          style={{
            fontSize: 10,
            color: COLORS.blue,
            background: tint(COLORS.blue, 0.1),
            borderColor: tint(COLORS.blue, 0.26),
            flex: "none",
          }}
        >
          {tpl.aggregation}
        </span>
      </div>
      <span className="faint" style={{ fontSize: 11.5 }}>
        {formatUnitHint(tpl)}
      </span>
      <span className="faint" style={{ fontSize: 11, fontStyle: "italic" }}>
        {tpl.why}
      </span>
      <button
        type="button"
        className="btn btn-sm"
        disabled={busy || done}
        onClick={onAdd}
        style={{
          marginTop: 4,
          justifySelf: "start",
          ...(done
            ? { color: COLORS.green, borderColor: tint(COLORS.green, 0.3) }
            : {}),
        }}
      >
        {done ? "Added ✓" : busy ? "Adding…" : "+ Add"}
      </button>
    </div>
  );
}

const UNIT_LABEL: Record<DiscoveredMetricView["unit"], string> = {
  count: "count",
  pence: "£",
  minutes: "minutes",
  percent: "%",
  ms: "ms",
};

function formatUnitHint(tpl: DiscoveredMetricView): string {
  return `${tpl.eventType} · ${UNIT_LABEL[tpl.unit]}`;
}
