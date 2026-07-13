"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type Phase = "idle" | "sending" | "done" | "error";

/**
 * "Re-send" — POSTs /api/briefs/[id]/resend (P3-BRIEF route), which re-runs
 * deliverBrief for a stored brief and restamps status. Degrades quietly when
 * delivery keys are absent (the route returns a typed not-configured result).
 */
export function ResendBriefButton({ briefId }: { briefId: string }) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("idle");
  const [msg, setMsg] = useState<string | null>(null);

  async function resend() {
    if (phase === "sending") return;
    setPhase("sending");
    setMsg(null);
    try {
      const res = await fetch(`/api/briefs/${briefId}/resend`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const detail = (await res.json().catch(() => null)) as
        | Record<string, unknown>
        | null;
      if (!res.ok) {
        const code =
          detail && "error" in detail ? String(detail.error) : `HTTP ${res.status}`;
        setPhase("error");
        setMsg(res.status === 404 ? "Resend not available yet." : `Failed: ${code}`);
        return;
      }
      setPhase("done");
      setMsg("Re-sent.");
      router.refresh();
      setTimeout(() => setPhase("idle"), 2500);
    } catch {
      setPhase("error");
      setMsg("Couldn't reach delivery.");
    }
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      {msg && (
        <span
          className="faint"
          style={{
            fontSize: 12.5,
            color: phase === "error" ? "var(--red)" : "var(--text-2)",
          }}
        >
          {msg}
        </span>
      )}
      <button
        type="button"
        className="btn btn-sm"
        onClick={resend}
        disabled={phase === "sending"}
      >
        {phase === "sending" ? "Re-sending…" : "Re-send"}
      </button>
    </div>
  );
}
