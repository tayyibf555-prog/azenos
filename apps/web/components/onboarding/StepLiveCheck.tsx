"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import { usePolling } from "../usePolling";
import { fetchLiveCheck } from "../../lib/onboarding/wizard";
import { COLORS, tint } from "../ui";

const POLL_MS = 2500;

/**
 * Step 5 — poll the SAME project-events route the Events tab uses
 * (GET /api/projects/:id/events) until the first event lands, then show
 * "✓ first event received" with its type. Skippable at any time.
 */
export function StepLiveCheck({
  projectId,
  projectName,
}: {
  projectId: string;
  projectName: string;
}) {
  const [status, setStatus] = useState<"waiting" | "received" | "error">(
    "waiting",
  );
  const [eventType, setEventType] = useState<string | null>(null);

  const poll = useCallback(async () => {
    try {
      const check = await fetchLiveCheck(projectId);
      if (check.received) {
        setStatus("received");
        setEventType(check.eventType);
      } else {
        // A successful poll with no event yet clears any prior transient error.
        setStatus((s) => (s === "received" ? s : "waiting"));
      }
    } catch {
      setStatus((s) => (s === "received" ? s : "error"));
    }
  }, [projectId]);

  // Keep polling through transient errors — stop only once the event arrives.
  // Gating on `status === "waiting"` would tear the interval down on the first
  // failed poll and never restart it, permanently stranding the step.
  usePolling(() => void poll(), POLL_MS, status !== "received");

  return (
    <div style={{ maxWidth: 520, display: "grid", gap: 18 }}>
      <div className="card" style={{ padding: 20 }}>
        {status === "received" ? (
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: "50%",
                background: COLORS.green,
                boxShadow: `0 0 0 4px ${tint(COLORS.green, 0.18)}`,
                flex: "none",
              }}
              aria-hidden
            />
            <div>
              <div style={{ fontWeight: 600, fontSize: 14 }}>
                ✓ First event received
              </div>
              <span className="badge badge-mono" style={{ marginTop: 6 }}>
                {eventType}
              </span>
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span className="pulse" style={{ width: 10, height: 10, borderRadius: "50%", background: "var(--text-3)" }} aria-hidden />
            <div>
              <div style={{ fontWeight: 600, fontSize: 14 }}>
                Waiting for the first event…
              </div>
              <p className="muted" style={{ fontSize: 13, marginTop: 4 }}>
                Send a test call from {projectName}&rsquo;s Setup tab, or wire
                the client&rsquo;s system to the endpoint above. This checks
                every {POLL_MS / 1000}s.
              </p>
              {status === "error" && (
                <p className="faint" style={{ fontSize: 12, marginTop: 4 }}>
                  Couldn&rsquo;t reach the events API — retrying.
                </p>
              )}
            </div>
          </div>
        )}
      </div>

      <div style={{ display: "flex", gap: 10 }}>
        <Link href={`/projects/${projectId}?tab=setup`} className="btn btn-primary">
          {status === "received" ? "Go to project →" : "Skip — go to project"}
        </Link>
        <Link href="/projects" className="btn">
          All projects
        </Link>
      </div>
    </div>
  );
}
