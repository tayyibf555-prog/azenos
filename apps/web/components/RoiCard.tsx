"use client";

import { useEffect, useState } from "react";
import { formatPence } from "../lib/format";
import { COLORS, tint } from "./ui";
import { currentLondonMonth } from "./charts/util";
import type { ApiErrorShape, RoiResponse } from "./metrics-types";

type State =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; roi: RoiResponse };

function hoursLabel(minutes: number): string {
  const hrs = minutes / 60;
  if (hrs <= 0) return "0h";
  if (hrs < 10) return `${hrs.toLocaleString("en-GB", { maximumFractionDigits: 1 })}h`;
  return `${Math.round(hrs).toLocaleString("en-GB")}h`;
}

/**
 * ROI headline (§Metrics UI Overview upgrade): big multiple, the §10 honest
 * "attributed" framing, and a breakdown of the numerator/denominator. Renders
 * an em-dash when the API returns a null multiple (zero cost baseline).
 */
export function RoiCard({
  projectId,
  month = currentLondonMonth(),
}: {
  projectId: string;
  month?: string;
}) {
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    let alive = true;
    setState({ status: "loading" });
    fetch(`/api/projects/${projectId}/roi?month=${month}`, { cache: "no-store" })
      .then(async (res) => {
        const json = (await res.json()) as RoiResponse | ApiErrorShape;
        if (!alive) return;
        if (!res.ok || "error" in json) {
          setState({ status: "error" });
          return;
        }
        setState({ status: "ready", roi: json });
      })
      .catch(() => {
        if (alive) setState({ status: "error" });
      });
    return () => {
      alive = false;
    };
  }, [projectId, month]);

  if (state.status === "loading") {
    return (
      <section className="card" style={{ padding: 20 }}>
        <div className="skeleton" style={{ height: 44, width: 140 }} />
        <div className="skeleton" style={{ height: 16, marginTop: 12, width: "70%" }} />
      </section>
    );
  }

  if (state.status === "error") {
    return (
      <section
        className="card"
        style={{
          padding: 20,
          display: "flex",
          alignItems: "center",
          gap: 14,
          border: "1px dashed var(--border-2)",
        }}
      >
        <div
          aria-hidden
          style={{
            width: 40,
            height: 40,
            borderRadius: "var(--radius-icon)",
            flex: "none",
            display: "grid",
            placeItems: "center",
            fontSize: 20,
            background: tint(COLORS.green, 0.12),
          }}
        >
          ✦
        </div>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600 }}>ROI headline</div>
          <div className="muted" style={{ fontSize: 12.5, marginTop: 3 }}>
            Appears once the metrics engine has rolled up this month&apos;s value and
            cost events.
          </div>
        </div>
      </section>
    );
  }

  const { roi } = state;
  const denominator = roi.retainerPence + roi.runCostPence;
  const multipleText = roi.roiMultiple === null ? "—" : `${roi.roiMultiple.toFixed(1)}×`;
  const multipleColor =
    roi.roiMultiple === null
      ? "var(--text-3)"
      : roi.roiMultiple >= 1
        ? COLORS.green
        : COLORS.amber;

  return (
    <section
      className="card"
      style={{
        padding: "20px 22px",
        display: "flex",
        gap: 22,
        flexWrap: "wrap",
        alignItems: "center",
        background: tint(COLORS.green, 0.055),
      }}
    >
      <div style={{ flex: "none", minWidth: 120 }}>
        <div
          style={{
            fontSize: 46,
            fontWeight: 720,
            letterSpacing: "-0.03em",
            lineHeight: 1,
            color: multipleColor,
          }}
        >
          {multipleText}
        </div>
        <div className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>
          ROI this month
        </div>
      </div>

      <div style={{ flex: "1 1 320px", minWidth: 0 }}>
        <p style={{ fontSize: 15, lineHeight: 1.5 }}>
          <strong style={{ color: COLORS.green }}>
            {formatPence(roi.revenueAttributedPence)}
          </strong>{" "}
          attributed revenue
          <span className="muted"> + </span>
          <strong>{formatPence(roi.timeValuePence)}</strong> in time saved
          <span className="faint"> ({hoursLabel(roi.minutesSaved)})</span>
          <span className="muted"> measured against </span>
          <strong>{formatPence(denominator)}</strong>{" "}
          <span className="muted">retainer + agent cost.</span>
        </p>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 12 }}>
          <Cell label="Attributed revenue" value={formatPence(roi.revenueAttributedPence)} tone={COLORS.green} />
          <Cell label="Time value" value={formatPence(roi.timeValuePence)} tone="var(--text)" />
          <Cell label="Retainer" value={formatPence(roi.retainerPence)} tone={COLORS.grey} />
          <Cell label="Agent cost" value={formatPence(roi.runCostPence)} tone={COLORS.amber} />
        </div>

        <p className="faint" style={{ fontSize: 11.5, marginTop: 10, lineHeight: 1.45 }}>
          {roi.roiMultiple === null
            ? "No billable baseline yet — set a retainer or wait for agent-cost events to compute a multiple. "
            : ""}
          “Attributed” = revenue on events the system touched, not an audited
          cause; time saved valued at {formatPence(roi.hourlyRatePence)}/hr.
        </p>
      </div>
    </section>
  );
}

function Cell({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div
      style={{
        background: "var(--card-2)",
        border: "none",
        borderRadius: "var(--radius-tile)",
        padding: "7px 11px",
        minWidth: 92,
      }}
    >
      <div className="faint" style={{ fontSize: 10.5, marginBottom: 2 }}>
        {label}
      </div>
      <div style={{ fontSize: 13.5, fontWeight: 600, color: tone }}>{value}</div>
    </div>
  );
}
