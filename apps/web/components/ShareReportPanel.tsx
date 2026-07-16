"use client";

import { useState } from "react";
import type { ShareTokenRecord } from "../lib/server/share";
import { COLORS, tint } from "./ui";

/**
 * Owner-side "Share report" affordance (§P8-REPORT). Creates / copies / revokes
 * the public monthly-report link for one client and surfaces its view count.
 * Reused on the Briefs client-report view and the Client 360 detail. All state
 * changes go through the org-scoped /api/share route; the token string never
 * leaves this owner-only surface.
 *
 * At-rest ruling: the raw token is NOT stored, so a re-rendered live token has
 * no link in hand until the owner asks for it. The mint call returns the raw
 * token once (held in `links` for this session); any later "copy link" reveals
 * it via the authenticated, org-scoped GET /api/share (which decrypts the
 * ciphertext server-side) — never on any public path.
 */

function isLive(t: ShareTokenRecord): boolean {
  if (t.revokedAt !== null) return false;
  if (t.expiresAt !== null && new Date(t.expiresAt).getTime() <= Date.now()) {
    return false;
  }
  return true;
}

function shareUrl(token: string): string {
  const origin =
    typeof window !== "undefined" ? window.location.origin : "";
  return `${origin}/share/${token}`;
}

export function ShareReportPanel({
  clientId,
  initialTokens,
}: {
  clientId: string;
  initialTokens: ShareTokenRecord[];
}) {
  const [tokens, setTokens] = useState<ShareTokenRecord[]>(initialTokens);
  // tokenId → full share URL held for THIS session only: populated when a token
  // is minted (raw token returned once) or revealed on demand. Never persisted.
  const [links, setLinks] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const live = tokens.find(isLive) ?? null;
  const liveUrl = live ? links[live.id] : undefined;

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/share", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "monthly_report", clientId }),
      });
      if (!res.ok) {
        setError(
          res.status === 503
            ? "Sharing isn't configured yet. Try again once the vault is set up."
            : "Couldn't create the link. Try again.",
        );
        return;
      }
      const data = (await res.json()) as { record: ShareTokenRecord; token: string };
      const url = shareUrl(data.token);
      setTokens((prev) => [data.record, ...prev]);
      setLinks((m) => ({ ...m, [data.record.id]: url }));
      await copyUrl(url);
    } finally {
      setBusy(false);
    }
  }

  /**
   * Copy the live link. If we already hold it this session (just minted /
   * revealed), copy straight away; otherwise reveal it server-side (the
   * authenticated GET decrypts the ciphertext) then copy.
   */
  async function copyLive() {
    if (!live) return;
    setError(null);
    let url = links[live.id];
    if (!url) {
      setBusy(true);
      try {
        const res = await fetch(`/api/share?tokenId=${live.id}`, { cache: "no-store" });
        if (!res.ok) {
          setError(
            res.status === 503
              ? "Sharing isn't configured yet."
              : "Couldn't load the link. Try again.",
          );
          return;
        }
        const data = (await res.json()) as { token: string };
        url = shareUrl(data.token);
        setLinks((m) => ({ ...m, [live.id]: url! }));
      } finally {
        setBusy(false);
      }
    }
    await copyUrl(url);
  }

  async function copyUrl(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard blocked (e.g. insecure context) — the field is still selectable.
    }
  }

  async function revoke(tokenId: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/share", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tokenId }),
      });
      if (!res.ok) {
        setError("Couldn't revoke the link. Try again.");
        return;
      }
      setTokens((prev) =>
        prev.map((t) =>
          t.id === tokenId
            ? { ...t, revokedAt: new Date().toISOString() }
            : t,
        ),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      className="card"
      style={{ padding: 0, overflow: "hidden" }}
      aria-label="Share this report"
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "13px 18px",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <span
          className="dot"
          style={{ width: 7, height: 7, background: COLORS.blue }}
          aria-hidden
        />
        <h3 style={{ fontSize: 13.5, fontWeight: 620 }}>Share with client</h3>
        {live && (
          <span
            className="badge tnum"
            style={{
              marginLeft: "auto",
              color: COLORS.green,
              background: tint(COLORS.green, 0.12),
              borderColor: tint(COLORS.green, 0.28),
            }}
          >
            {live.viewCount} view{live.viewCount === 1 ? "" : "s"}
          </span>
        )}
      </div>

      <div style={{ padding: "16px 18px", display: "grid", gap: 12 }}>
        {live ? (
          <>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <input
                readOnly
                value={liveUrl ?? `${shareUrl("")}••••••••••`}
                onFocus={(e) => e.currentTarget.select()}
                className="mono"
                aria-label="Share link"
                style={{
                  flex: "1 1 240px",
                  minWidth: 0,
                  padding: "8px 10px",
                  fontSize: 12,
                  color: "var(--text-2)",
                  background: "var(--input)",
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                }}
              />
              <button
                type="button"
                className="btn btn-sm btn-primary"
                onClick={copyLive}
                disabled={busy}
              >
                {copied ? "Copied" : liveUrl ? "Copy link" : "Reveal & copy"}
              </button>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => revoke(live.id)}
                disabled={busy}
              >
                Revoke
              </button>
            </div>
            <p style={{ fontSize: 12, color: "var(--text-3)", margin: 0 }}>
              Anyone with this link can view the latest monthly report — no login.
              {live.lastViewedAt
                ? ` Last opened ${new Date(live.lastViewedAt).toLocaleString("en-GB", { timeZone: "Europe/London", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}.`
                : " Not opened yet."}
            </p>
          </>
        ) : (
          <>
            <p style={{ fontSize: 13, color: "var(--text-2)", margin: 0 }}>
              Create a private, white-label link to the client&apos;s latest
              monthly value report. No login required; revoke anytime.
            </p>
            <div>
              <button
                type="button"
                className="btn btn-sm btn-primary"
                onClick={create}
                disabled={busy}
              >
                {busy ? "Creating…" : "Create share link"}
              </button>
            </div>
          </>
        )}
        {error && (
          <p style={{ fontSize: 12, color: "var(--red)", margin: 0 }}>{error}</p>
        )}
      </div>
    </section>
  );
}
