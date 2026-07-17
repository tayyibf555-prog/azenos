"use client";

import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { formatLondonDate } from "../lib/format";
import { Modal } from "./Modal";
import { ToastViewport, useToasts } from "./Toast";
import { COLORS, tint } from "./ui";
import type { ApiError } from "./types";

/**
 * Connections tab (docs/phase7/PLAN.md §C2) — the Connections Vault UI over
 * the §C1 server core (`lib/server/credentials.ts` + the credentials API
 * routes). The OWNER types each key once; it is encrypted at rest
 * (AES-256-GCM) and never shown again — only `····{last4}` is ever displayed.
 * There is no import/paste automation of secrets anywhere on this screen.
 */

type CredentialProvider = "anthropic" | "openai" | "twilio" | "higgsfield" | "custom";

interface MaskedCredential {
  id: string;
  provider: CredentialProvider;
  label: string;
  last4: string;
  createdAt: string;
}

interface CredentialsResponse {
  credentials: MaskedCredential[];
}

interface CreateCredentialResponse {
  credential: MaskedCredential;
}

type State =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; data: MaskedCredential[] };

const PROVIDERS: {
  id: CredentialProvider;
  name: string;
  placeholder: string;
}[] = [
  { id: "anthropic", name: "Anthropic", placeholder: "sk-ant-…" },
  { id: "openai", name: "OpenAI", placeholder: "sk-…" },
  { id: "twilio", name: "Twilio", placeholder: "Auth token" },
  { id: "higgsfield", name: "Higgsfield", placeholder: "API key" },
  { id: "custom", name: "Custom", placeholder: "Secret value" },
];

const PROVIDER_COLOR: Record<CredentialProvider, string> = {
  anthropic: COLORS.blue,
  openai: COLORS.teal,
  twilio: COLORS.violet,
  higgsfield: COLORS.magenta,
  custom: COLORS.grey,
};

function providerName(p: CredentialProvider): string {
  return PROVIDERS.find((x) => x.id === p)?.name ?? p;
}

export function ConnectionsTab({ projectId }: { projectId: string }) {
  const { toasts, show } = useToasts();
  const [state, setState] = useState<State>({ status: "loading" });
  const [revokeTarget, setRevokeTarget] = useState<MaskedCredential | null>(
    null,
  );
  const [revokeBusy, setRevokeBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/credentials`, {
        cache: "no-store",
      });
      const json = (await res.json()) as CredentialsResponse | ApiError;
      if (!res.ok || "error" in json) {
        setState({ status: "error" });
        return;
      }
      setState({ status: "ready", data: json.credentials });
    } catch {
      setState({ status: "error" });
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  function onCreated(cred: MaskedCredential) {
    setState((s) => ({
      status: "ready",
      data: [cred, ...(s.status === "ready" ? s.data : [])],
    }));
    show(`${providerName(cred.provider)} key saved · ${cred.label}`, "success");
  }

  async function doRevoke() {
    if (!revokeTarget) return;
    setRevokeBusy(true);
    try {
      const res = await fetch(
        `/api/projects/${projectId}/credentials/${revokeTarget.id}`,
        { method: "DELETE" },
      );
      const json = (await res.json()) as { ok?: boolean } | ApiError;
      if (!res.ok || "error" in json) {
        show("error" in json ? json.error : "Revoke failed", "error");
        return;
      }
      setState((s) => ({
        status: "ready",
        data:
          s.status === "ready"
            ? s.data.filter((c) => c.id !== revokeTarget.id)
            : [],
      }));
      show(`Revoked ${providerName(revokeTarget.provider)} · ${revokeTarget.label}`, "success");
      setRevokeTarget(null);
    } catch {
      show("Network error revoking credential", "error");
    } finally {
      setRevokeBusy(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: 22 }}>
      <section className="card" style={{ padding: 18 }}>
        <h3 style={{ fontSize: 14, marginBottom: 6 }}>Connections</h3>
        <p className="muted" style={{ fontSize: 13, marginBottom: 16 }}>
          Keys are entered by you, encrypted at rest (AES-256-GCM), never shown
          again, revocable. This project&rsquo;s co-pilot and integrations use
          them server-side only — nothing is ever echoed back to the browser.
        </p>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))",
            gap: 12,
          }}
        >
          {PROVIDERS.map((p) => (
            <ProviderCard
              key={p.id}
              projectId={projectId}
              provider={p.id}
              name={p.name}
              placeholder={p.placeholder}
              onCreated={onCreated}
              onError={(msg) => show(msg, "error")}
            />
          ))}
        </div>
      </section>

      <section className="card" style={{ padding: 0 }}>
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            justifyContent: "space-between",
            padding: "14px 18px",
          }}
        >
          <h3 style={{ fontSize: 14 }}>Stored keys</h3>
          {state.status === "ready" && (
            <span className="faint" style={{ fontSize: 12 }}>
              {state.data.length} active
            </span>
          )}
        </div>

        {state.status === "loading" && (
          <div style={{ padding: 16, display: "grid", gap: 10 }}>
            {[0, 1].map((i) => (
              <div key={i} className="skeleton" style={{ height: 40 }} />
            ))}
          </div>
        )}

        {state.status === "error" && (
          <div className="empty">
            <span className="empty-title">Couldn&apos;t load connections</span>
            <span style={{ fontSize: 13 }}>
              The vault may not be configured for this environment yet.
            </span>
          </div>
        )}

        {state.status === "ready" && state.data.length === 0 && (
          <div className="empty">
            <span className="empty-title">No keys stored yet</span>
            <span style={{ fontSize: 13 }}>
              Add one above — it&rsquo;s encrypted immediately and never shown
              again.
            </span>
          </div>
        )}

        {state.status === "ready" && state.data.length > 0 && (
          <div style={{ display: "grid", gap: 1, padding: "6px 0" }}>
            {state.data.map((c) => (
              <CredentialRow
                key={c.id}
                credential={c}
                onRevoke={() => setRevokeTarget(c)}
              />
            ))}
          </div>
        )}
      </section>

      <Modal
        open={!!revokeTarget}
        onClose={() => setRevokeTarget(null)}
        title="Revoke connection"
      >
        {revokeTarget && (
          <>
            <p className="muted" style={{ fontSize: 13.5, marginBottom: 16 }}>
              This removes{" "}
              <strong>
                {providerName(revokeTarget.provider)} · {revokeTarget.label}
              </strong>{" "}
              (····{revokeTarget.last4}) from this project. Anything using it
              server-side will stop working immediately. This cannot be
              undone.
            </p>
            <div
              style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}
            >
              <button
                className="btn btn-sm"
                onClick={() => setRevokeTarget(null)}
              >
                Cancel
              </button>
              <button
                className="btn btn-danger btn-sm"
                onClick={doRevoke}
                disabled={revokeBusy}
              >
                {revokeBusy ? "Revoking…" : "Revoke"}
              </button>
            </div>
          </>
        )}
      </Modal>

      <ToastViewport toasts={toasts} />
    </div>
  );
}

function ProviderCard({
  projectId,
  provider,
  name,
  placeholder,
  onCreated,
  onError,
}: {
  projectId: string;
  provider: CredentialProvider;
  name: string;
  placeholder: string;
  onCreated: (cred: MaskedCredential) => void;
  onError: (msg: string) => void;
}) {
  const [label, setLabel] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const color = PROVIDER_COLOR[provider];

  const canSubmit = label.trim().length > 0 && secret.length >= 8 && !busy;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/credentials`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, label: label.trim(), secret }),
      });
      const json = (await res.json()) as CreateCredentialResponse | ApiError;
      if (!res.ok || "error" in json) {
        onError(
          "error" in json
            ? json.error === "vault_unavailable"
              ? "Vault not configured — set INGEST_SECRET_ENC_KEY to enable connections."
              : json.error
            : "Save failed",
        );
        return;
      }
      onCreated(json.credential);
      setLabel("");
      setSecret("");
    } catch {
      onError("Network error saving key");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      className="card"
      style={{
        padding: 14,
        display: "grid",
        gap: 8,
        background: tint(color, 0.055),
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          className="dot"
          aria-hidden
          style={{ width: 8, height: 8, background: color, flex: "none" }}
        />
        <span style={{ fontSize: 13, fontWeight: 650 }}>{name}</span>
      </div>
      <input
        className="input"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder="Label — e.g. production"
        aria-label={`${name} key label`}
        maxLength={60}
      />
      <input
        className="input"
        type="password"
        value={secret}
        onChange={(e) => setSecret(e.target.value)}
        placeholder={placeholder}
        aria-label={`${name} secret`}
        autoComplete="off"
      />
      <button
        type="submit"
        className="btn btn-primary btn-sm"
        disabled={!canSubmit}
      >
        {busy ? "Saving…" : "Save"}
      </button>
    </form>
  );
}

function CredentialRow({
  credential,
  onRevoke,
}: {
  credential: MaskedCredential;
  onRevoke: () => void;
}) {
  const color = PROVIDER_COLOR[credential.provider];
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        padding: "10px 18px",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          minWidth: 0,
        }}
      >
        <span
          className="badge badge-mono"
          style={{
            color,
            background: tint(color, 0.12),
            flex: "none",
          }}
        >
          {providerName(credential.provider)}
        </span>
        <span
          className="truncate"
          style={{ fontSize: 13, fontWeight: 550 }}
          title={credential.label}
        >
          {credential.label}
        </span>
        <span className="mono faint" style={{ fontSize: 12.5 }}>
          ····{credential.last4}
        </span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 14, flex: "none" }}>
        <span className="faint" style={{ fontSize: 12 }}>
          {formatLondonDate(credential.createdAt)}
        </span>
        <button className="btn btn-danger btn-sm" onClick={onRevoke}>
          Revoke
        </button>
      </div>
    </div>
  );
}
