"use client";

import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useRouter } from "next/navigation";
import { formatLondonDate } from "../lib/format";
import { CopyBlock, CopyButton } from "./CopyBlock";
import { FeedbackWidgetCard } from "./FeedbackWidgetCard";
import { KeyReveal } from "./KeyReveal";
import { Modal } from "./Modal";
import { RelativeTime } from "./RelativeTime";
import { SnippetTabs } from "./SnippetTabs";
import { ToastViewport, useToasts } from "./Toast";
import { TrackingPlanCard } from "./TrackingPlanCard";
import { COLORS, tint } from "./ui";
import { usePolling } from "./usePolling";
import type {
  DeliveriesResponse,
  DeliveryRow,
  EventsResponse,
  EventTypeSeen,
  ProjectKeyView,
  ReplayResponse,
  RevokeResponse,
  RotateResponse,
  TestEventResponse,
  ApiError,
} from "./types";

interface RevealState {
  publicKey: string;
  secret: string;
  authMode: string;
  kind: "rotate" | "revoke";
}

export function SetupPanel({
  projectId,
  projectType,
  activeKey,
  feedbackKey,
  eventTypesSeen,
  hasEvents,
}: {
  projectId: string;
  projectType: string;
  activeKey: ProjectKeyView | null;
  feedbackKey: ProjectKeyView | null;
  eventTypesSeen: EventTypeSeen[];
  hasEvents: boolean;
}) {
  const router = useRouter();
  const { toasts, show } = useToasts();
  const [origin, setOrigin] = useState("");
  const [deliveries, setDeliveries] = useState<DeliveryRow[] | null>(null);
  const [modal, setModal] = useState<"rotate" | "revoke" | null>(null);
  const [reveal, setReveal] = useState<RevealState | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  const loadDeliveries = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/deliveries?limit=50`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error();
      const json = (await res.json()) as DeliveriesResponse;
      setDeliveries(json.deliveries);
    } catch {
      setDeliveries([]);
    }
  }, [projectId]);

  useEffect(() => {
    void loadDeliveries();
  }, [loadDeliveries]);

  const publicKey = activeKey?.publicKey ?? "";
  const endpoint = publicKey
    ? `${origin}/api/ingest/${publicKey}`
    : "";

  async function sendTest() {
    setBusy(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/test-event`, {
        method: "POST",
      });
      const json = (await res.json()) as TestEventResponse | ApiError;
      if (!res.ok || "error" in json) {
        show(
          "error" in json ? json.error : "Test event failed",
          "error",
        );
      } else if (json.accepted > 0) {
        show(`Test event accepted · ${json.eventType}`, "success");
      } else if (json.duplicates > 0) {
        show("Test event was a duplicate (already stored)", "info");
      } else {
        show("Test event rejected", "error");
      }
      await loadDeliveries();
      router.refresh();
    } catch {
      show("Network error sending test event", "error");
    } finally {
      setBusy(false);
    }
  }

  async function doRotate() {
    setBusy(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/keys/rotate`, {
        method: "POST",
      });
      const json = (await res.json()) as RotateResponse | ApiError;
      if (!res.ok || "error" in json) {
        show("error" in json ? json.error : "Rotate failed", "error");
        return;
      }
      setModal(null);
      setReveal({
        publicKey: json.publicKey,
        secret: json.secret,
        authMode: activeKey?.authMode ?? "hmac",
        kind: "rotate",
      });
      show("Secret rotated — old secret is now invalid", "success");
      router.refresh();
    } catch {
      show("Network error rotating secret", "error");
    } finally {
      setBusy(false);
    }
  }

  async function doRevoke() {
    setBusy(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/keys/revoke`, {
        method: "POST",
      });
      const json = (await res.json()) as RevokeResponse | ApiError;
      if (!res.ok || "error" in json) {
        show("error" in json ? json.error : "Revoke failed", "error");
        return;
      }
      setModal(null);
      setReveal({
        publicKey: json.publicKey,
        secret: json.secret,
        authMode: json.authMode,
        kind: "revoke",
      });
      show("Key revoked — a new key pair was issued", "success");
      router.refresh();
    } catch {
      show("Network error revoking key", "error");
    } finally {
      setBusy(false);
    }
  }

  async function replay(deliveryId: string) {
    try {
      const res = await fetch(`/api/deliveries/${deliveryId}/replay`, {
        method: "POST",
      });
      const json = (await res.json()) as ReplayResponse | ApiError;
      if (!res.ok || "error" in json) {
        show("error" in json ? json.error : "Replay failed", "error");
        return;
      }
      show(
        json.accepted > 0
          ? "Replayed — event accepted"
          : "Replayed — still rejected",
        json.accepted > 0 ? "success" : "info",
      );
      await loadDeliveries();
      router.refresh();
    } catch {
      show("Network error replaying delivery", "error");
    }
  }

  function closeReveal() {
    setReveal(null);
    router.refresh();
  }

  return (
    <div style={{ display: "grid", gap: 22 }}>
      {/* ── Endpoint & authentication ─────────────────────────────────── */}
      <section className="card" style={{ padding: 18 }}>
        <h3 style={{ fontSize: 14, marginBottom: 14 }}>Endpoint & authentication</h3>

        {!activeKey ? (
          <p className="muted" style={{ fontSize: 13 }}>
            No active key for this project. Use “Revoke &amp; re-issue” below to
            mint one.
          </p>
        ) : (
          <div style={{ display: "grid", gap: 16 }}>
            <CopyBlock
              label="Ingest endpoint"
              value={endpoint || `…/api/ingest/${publicKey}`}
            />

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
                gap: 14,
              }}
            >
              <Field label="Public key">
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span
                    className="mono truncate"
                    style={{ fontSize: 12.5 }}
                    title={activeKey.publicKey}
                  >
                    {activeKey.publicKey}
                  </span>
                  <CopyButton
                    value={activeKey.publicKey}
                    className="btn btn-ghost btn-sm"
                  />
                </div>
              </Field>
              <Field label="Auth mode">
                <AuthBadge mode={activeKey.authMode} />
              </Field>
              <Field label="Rate limit">
                <span style={{ fontSize: 13 }}>
                  {activeKey.rateLimitPer10s} / 10s
                </span>
              </Field>
              <Field label="Created">
                <span style={{ fontSize: 13 }}>
                  {formatLondonDate(activeKey.createdAt)}
                </span>
              </Field>
              <Field label="Last used">
                {activeKey.lastUsedAt ? (
                  <RelativeTime
                    value={activeKey.lastUsedAt}
                    className="mono"
                  />
                ) : (
                  <span className="faint" style={{ fontSize: 13 }}>
                    never
                  </span>
                )}
              </Field>
            </div>

            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={sendTest}
                disabled={busy}
              >
                Send test event
              </button>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setModal("rotate")}
                disabled={busy}
              >
                Rotate secret
              </button>
              <button
                type="button"
                className="btn btn-danger btn-sm"
                onClick={() => setModal("revoke")}
                disabled={busy}
              >
                Revoke &amp; re-issue
              </button>
            </div>
          </div>
        )}
      </section>

      {/* ── Waiting for first event ───────────────────────────────────── */}
      {!hasEvents && (
        <FirstEventListener
          projectId={projectId}
          onFound={() => {
            show("First event received", "success");
            router.refresh();
          }}
        />
      )}

      {/* ── Snippets ──────────────────────────────────────────────────── */}
      {activeKey && (
        <section className="card" style={{ padding: 18 }}>
          <h3 style={{ fontSize: 14, marginBottom: 12 }}>Integration snippets</h3>
          <SnippetTabs
            publicKey={activeKey.publicKey}
            endpoint={endpoint || `${origin}/api/ingest/${activeKey.publicKey}`}
            authMode={activeKey.authMode}
          />
        </section>
      )}

      {/* ── Feedback widget (Phase 7 §B) ──────────────────────────────── */}
      <FeedbackWidgetCard
        projectId={projectId}
        feedbackKey={feedbackKey}
        origin={origin}
      />

      {/* ── Tracking plan ─────────────────────────────────────────────── */}
      <TrackingPlanCard projectType={projectType} eventTypesSeen={eventTypesSeen} />

      {/* ── Delivery log ──────────────────────────────────────────────── */}
      <section className="card" style={{ padding: 0 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "14px 18px",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <h3 style={{ fontSize: 14 }}>Delivery log</h3>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={loadDeliveries}
          >
            Refresh
          </button>
        </div>
        <DeliveryLog deliveries={deliveries} onReplay={replay} />
      </section>

      {/* ── Modals ────────────────────────────────────────────────────── */}
      <Modal
        open={modal === "rotate" && !reveal}
        onClose={() => setModal(null)}
        title="Rotate secret"
      >
        <p className="muted" style={{ fontSize: 13.5, marginBottom: 16 }}>
          A new secret is generated on the <strong>same public key</strong>, so
          the endpoint URL stays the same. The current secret stops working{" "}
          <strong>immediately</strong> — there is no grace period. Any live
          integration must be updated with the new secret.
        </p>
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button className="btn btn-sm" onClick={() => setModal(null)}>
            Cancel
          </button>
          <button
            className="btn btn-primary btn-sm"
            onClick={doRotate}
            disabled={busy}
          >
            {busy ? "Rotating…" : "Rotate secret"}
          </button>
        </div>
      </Modal>

      <Modal
        open={modal === "revoke" && !reveal}
        onClose={() => setModal(null)}
        title="Revoke & re-issue key"
      >
        <p className="muted" style={{ fontSize: 13.5, marginBottom: 16 }}>
          The current key is revoked and a <strong>brand-new key pair</strong> is
          issued — the <strong>endpoint URL changes</strong>. Every caller must
          be repointed at the new URL and secret. Use this if a public key may
          have leaked.
        </p>
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button className="btn btn-sm" onClick={() => setModal(null)}>
            Cancel
          </button>
          <button
            className="btn btn-danger btn-sm"
            onClick={doRevoke}
            disabled={busy}
          >
            {busy ? "Revoking…" : "Revoke & re-issue"}
          </button>
        </div>
      </Modal>

      <Modal
        open={!!reveal}
        onClose={closeReveal}
        title={reveal?.kind === "revoke" ? "New key issued" : "New secret"}
        width={620}
      >
        {reveal && (
          <KeyReveal
            endpoint={`${origin}/api/ingest/${reveal.publicKey}`}
            publicKey={reveal.publicKey}
            secret={reveal.secret}
            authMode={reveal.authMode}
            showSnippets={reveal.kind === "revoke"}
          >
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button className="btn btn-primary btn-sm" onClick={closeReveal}>
                Done
              </button>
            </div>
          </KeyReveal>
        )}
      </Modal>

      <ToastViewport toasts={toasts} />
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div style={{ minWidth: 0 }}>
      <div className="label" style={{ marginBottom: 4 }}>
        {label}
      </div>
      {children}
    </div>
  );
}

function AuthBadge({ mode }: { mode: string }) {
  const color = mode === "token" ? COLORS.amber : COLORS.blue;
  return (
    <span
      className="badge"
      style={{
        color,
        background: tint(color, 0.12),
        borderColor: tint(color, 0.28),
      }}
    >
      {mode.toUpperCase()}
    </span>
  );
}

const DELIVERY_TONE: Record<string, string> = {
  accepted: COLORS.green,
  duplicate: COLORS.blue,
  rejected: COLORS.red,
  failed: COLORS.amber,
};

function DeliveryLog({
  deliveries,
  onReplay,
}: {
  deliveries: DeliveryRow[] | null;
  onReplay: (id: string) => void;
}) {
  if (deliveries === null) {
    return (
      <div style={{ padding: 16, display: "grid", gap: 10 }}>
        {[0, 1, 2].map((i) => (
          <div key={i} className="skeleton" style={{ height: 18 }} />
        ))}
      </div>
    );
  }
  if (deliveries.length === 0) {
    return (
      <div className="empty">
        <span className="empty-title">No deliveries yet</span>
        <span style={{ fontSize: 13 }}>
          Every request that hits the endpoint is logged here.
        </span>
      </div>
    );
  }
  return (
    <div className="scroll-x">
      <table className="table">
        <thead>
          <tr>
            <th>Status</th>
            <th>HTTP</th>
            <th>Latency</th>
            <th>Received</th>
            <th>Detail</th>
            <th style={{ textAlign: "right" }} />
          </tr>
        </thead>
        <tbody>
          {deliveries.map((d) => {
            const tone = DELIVERY_TONE[d.status] ?? COLORS.grey;
            const canReplay =
              (d.status === "rejected" || d.status === "failed") && d.hasRaw;
            return (
              <tr key={d.id}>
                <td>
                  <span
                    className="badge"
                    style={{
                      color: tone,
                      background: tint(tone, 0.12),
                      borderColor: tint(tone, 0.28),
                    }}
                  >
                    {d.status}
                  </span>
                </td>
                <td className="mono" style={{ fontSize: 12 }}>
                  {d.httpStatus}
                </td>
                <td className="mono" style={{ fontSize: 12, color: "var(--text-2)" }}>
                  {d.latencyMs != null ? `${d.latencyMs}ms` : "—"}
                </td>
                <td style={{ fontSize: 12 }}>
                  <RelativeTime value={d.receivedAt} />
                </td>
                <td
                  className="truncate"
                  style={{ maxWidth: 280, fontSize: 12, color: "var(--text-2)" }}
                  title={d.error ?? undefined}
                >
                  {d.error ?? <span className="faint">—</span>}
                </td>
                <td style={{ textAlign: "right" }}>
                  {canReplay && (
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => onReplay(d.id)}
                    >
                      Replay
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function FirstEventListener({
  projectId,
  onFound,
}: {
  projectId: string;
  onFound: () => void;
}) {
  const [found, setFound] = useState(false);

  const check = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/events?limit=1`, {
        cache: "no-store",
      });
      if (!res.ok) return;
      const json = (await res.json()) as EventsResponse;
      if (json.events.length > 0) {
        setFound(true);
        onFound();
      }
    } catch {
      // best-effort
    }
  }, [projectId, onFound]);

  usePolling(check, 2000, !found);

  const color = found ? COLORS.green : COLORS.amber;
  return (
    <section
      className="card"
      style={{
        padding: "14px 18px",
        display: "flex",
        alignItems: "center",
        gap: 12,
        borderColor: tint(color, 0.35),
        background: tint(color, 0.06),
      }}
    >
      {found ? (
        <span className="dot" style={{ background: color }} aria-hidden />
      ) : (
        <span className="ping-wrap" aria-hidden style={{ width: 9, height: 9 }}>
          <span className="ping" style={{ background: color }} />
          <span
            className="dot"
            style={{ width: 9, height: 9, background: color }}
          />
        </span>
      )}
      <span style={{ fontSize: 13.5, color }}>
        {found ? "First event received ✓" : "Waiting for first event…"}
      </span>
      <span className="faint" style={{ fontSize: 12 }}>
        {found
          ? "This project is now sending data."
          : "Send one with the button above or from the client system."}
      </span>
    </section>
  );
}
