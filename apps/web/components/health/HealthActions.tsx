"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Pill, TINTS, type SquircleTone } from "../system";
import type { OpenAlert } from "../../lib/server/health/queries";

const SEV_TONE: Record<string, SquircleTone> = {
  critical: "rose",
  warn: "butter",
  info: "sky",
};

function timeAgo(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** "Re-evaluate now" — runs one evaluation pass, then refreshes the server data. */
export function ReevaluateButton() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    try {
      // Skip escalation from the manual button — the cron owns real sends.
      await fetch("/api/health/evaluate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ escalate: false }),
      });
      start(() => router.refresh());
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      className="btn btn-primary"
      onClick={run}
      disabled={busy || pending}
    >
      {busy || pending ? "Evaluating…" : "Re-evaluate"}
    </button>
  );
}

/** Open-alert list with ack / resolve controls (PATCH /api/health/alerts/[id]). */
export function AlertsPanel({ alerts }: { alerts: OpenAlert[] }) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);

  async function act(id: string, action: "ack" | "resolve") {
    setBusyId(id);
    try {
      await fetch(`/api/health/alerts/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      router.refresh();
    } finally {
      setBusyId(null);
    }
  }

  if (alerts.length === 0) {
    return (
      <div className="card" style={{ padding: 20 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
          <span
            className="dot"
            style={{ width: 8, height: 8, background: TINTS.mint.fg }}
            aria-hidden
          />
          <span style={{ fontWeight: 600 }}>All clear</span>
        </div>
        <p className="muted" style={{ fontSize: 13, marginTop: 6 }}>
          No open health alerts across your live projects.
        </p>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {alerts.map((a) => (
        <div
          key={a.id}
          className="card"
          style={{
            padding: "14px 16px",
            display: "flex",
            alignItems: "center",
            gap: 14,
            opacity: a.ackedAt ? 0.72 : 1,
          }}
        >
          <span
            className="dot"
            style={{
              width: 9,
              height: 9,
              flex: "none",
              background: TINTS[SEV_TONE[a.severity] ?? "graphite"].fg,
            }}
            aria-hidden
          />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontWeight: 600, fontSize: 13.5 }}>{a.message}</span>
              {a.escalated && <Pill tone="rose">escalated</Pill>}
              {a.ackedAt && <Pill tone="graphite">acked</Pill>}
            </div>
            <div className="faint" style={{ fontSize: 12, marginTop: 3 }}>
              {a.clientName ? `${a.clientName} · ` : ""}
              {a.projectName ?? "org-level"} · {a.check ?? a.kind} ·{" "}
              {timeAgo(a.firedAt)}
            </div>
          </div>
          <div style={{ flex: "none", display: "flex", gap: 8 }}>
            {!a.ackedAt && (
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => act(a.id, "ack")}
                disabled={busyId === a.id}
              >
                Ack
              </button>
            )}
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => act(a.id, "resolve")}
              disabled={busyId === a.id}
            >
              Resolve
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
