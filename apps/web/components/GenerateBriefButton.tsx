"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type Phase = "idle" | "running" | "done" | "error";

/**
 * "Generate today's brief" — POSTs /api/briefs/run (P3-BRIEF route). Demo runs
 * are dryRun (no real send). Refreshes the archive on success. Degrades to a
 * quiet inline error if the route is missing (P3-BRIEF not landed) or the LLM
 * key is absent — the button never throws.
 */
export function GenerateBriefButton({ deliver = false }: { deliver?: boolean }) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("idle");
  const [msg, setMsg] = useState<string | null>(null);

  async function run() {
    if (phase === "running") return;
    setPhase("running");
    setMsg(null);
    try {
      const res = await fetch("/api/briefs/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deliver, dryRun: !deliver }),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => null);
        const code =
          detail && typeof detail === "object" && "error" in detail
            ? String((detail as { error: unknown }).error)
            : `HTTP ${res.status}`;
        setPhase("error");
        setMsg(
          res.status === 404
            ? "Brief runner not available yet."
            : `Couldn't generate: ${code}`,
        );
        return;
      }
      setPhase("done");
      setMsg("Brief generated.");
      router.refresh();
      setTimeout(() => setPhase("idle"), 2500);
    } catch {
      setPhase("error");
      setMsg("Couldn't reach the brief runner.");
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
        className="btn btn-primary btn-sm"
        onClick={run}
        disabled={phase === "running"}
      >
        {phase === "running" ? "Generating…" : "Generate today's brief"}
      </button>
    </div>
  );
}
