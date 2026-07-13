"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { humanize } from "./ui";
import { ProjectCreatedReveal, TranscriptIntake } from "./TranscriptIntake";
import type {
  ClientsResponse,
  CreateProjectResponse,
  ClientRow,
  ApiError,
} from "./types";

type Mode = "transcript" | "manual";

/**
 * New-project experience. Defaults to the transcript intake co-pilot; a toggle
 * flips to the classic manual form. Both funnel into the SAME key-reveal screen
 * (ProjectCreatedReveal) — the reveal is shared, never forked.
 */
export function NewProjectForm({
  types,
  stacks,
}: {
  types: string[];
  stacks: string[];
}) {
  const [mode, setMode] = useState<Mode>("transcript");
  return (
    <div>
      <ModeToggle mode={mode} onChange={setMode} />
      {mode === "transcript" ? (
        <TranscriptIntake />
      ) : (
        <ManualProjectForm types={types} stacks={stacks} />
      )}
    </div>
  );
}

function ModeToggle({
  mode,
  onChange,
}: {
  mode: Mode;
  onChange: (m: Mode) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="New project mode"
      style={{
        display: "inline-flex",
        gap: 3,
        padding: 3,
        marginBottom: 22,
        background: "var(--card-2)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-sm)",
      }}
    >
      <SegButton active={mode === "transcript"} onClick={() => onChange("transcript")}>
        From call transcript
      </SegButton>
      <SegButton active={mode === "manual"} onClick={() => onChange("manual")}>
        Manual form
      </SegButton>
    </div>
  );
}

function SegButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      className={active ? "btn btn-primary btn-sm" : "btn btn-ghost btn-sm"}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function ManualProjectForm({
  types,
  stacks,
}: {
  types: string[];
  stacks: string[];
}) {
  const [clients, setClients] = useState<ClientRow[]>([]);
  const [newClientMode, setNewClientMode] = useState(false);

  const [name, setName] = useState("");
  const [clientId, setClientId] = useState("");
  const [newClientName, setNewClientName] = useState("");
  const [newClientIndustry, setNewClientIndustry] = useState("");
  const [type, setType] = useState(types[0] ?? "ai_agent");
  const [stack, setStack] = useState(stacks[0] ?? "custom_code");
  const [description, setDescription] = useState("");
  const [retainer, setRetainer] = useState("");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CreateProjectResponse | null>(null);

  useEffect(() => {
    fetch("/api/clients", { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<ClientsResponse>) : null))
      .then((j) => {
        if (!j) return;
        setClients(j.clients);
        if (j.clients.length === 0) setNewClientMode(true);
      })
      .catch(() => setNewClientMode(true));
  }, []);

  const clientValid = newClientMode
    ? newClientName.trim().length > 0
    : clientId.length > 0;
  const canSubmit = name.trim().length > 0 && clientValid && !busy;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);

    const pounds = parseFloat(retainer);
    const retainerPenceMonthly =
      Number.isFinite(pounds) && pounds > 0 ? Math.round(pounds * 100) : 0;

    const body: Record<string, unknown> = {
      name: name.trim(),
      type,
      stack,
      retainerPenceMonthly,
    };
    if (description.trim()) body.description = description.trim();
    if (newClientMode) {
      body.newClient = {
        name: newClientName.trim(),
        ...(newClientIndustry.trim()
          ? { industrySlug: newClientIndustry.trim() }
          : {}),
      };
    } else {
      body.clientId = clientId;
    }

    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as CreateProjectResponse | ApiError;
      if (!res.ok || "error" in json) {
        setError("error" in json ? json.error : `Request failed (${res.status})`);
        return;
      }
      setResult(json);
    } catch {
      setError("Network error — please try again.");
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    return <ProjectCreatedReveal result={result} />;
  }

  return (
    <form onSubmit={onSubmit} style={{ maxWidth: 560, display: "grid", gap: 16 }}>
      <div>
        <label className="label" htmlFor="np-name">
          Project name
        </label>
        <input
          id="np-name"
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Reception voice agent"
          required
        />
      </div>

      <div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 6,
          }}
        >
          <label className="label" htmlFor="np-client" style={{ margin: 0 }}>
            Client
          </label>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setNewClientMode((v) => !v)}
          >
            {newClientMode ? "Pick existing" : "+ New client"}
          </button>
        </div>
        {newClientMode ? (
          <div style={{ display: "grid", gap: 8 }}>
            <input
              className="input"
              value={newClientName}
              onChange={(e) => setNewClientName(e.target.value)}
              placeholder="Client name"
              aria-label="New client name"
            />
            <input
              className="input"
              value={newClientIndustry}
              onChange={(e) => setNewClientIndustry(e.target.value)}
              placeholder="Industry slug (optional) — e.g. dental"
              aria-label="Industry slug"
            />
          </div>
        ) : (
          <select
            id="np-client"
            className="input"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
          >
            <option value="">Select a client…</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        )}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div>
          <label className="label" htmlFor="np-type">
            Type
          </label>
          <select
            id="np-type"
            className="input"
            value={type}
            onChange={(e) => setType(e.target.value)}
          >
            {types.map((t) => (
              <option key={t} value={t}>
                {humanize(t)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="np-stack">
            Stack
          </label>
          <select
            id="np-stack"
            className="input"
            value={stack}
            onChange={(e) => setStack(e.target.value)}
          >
            {stacks.map((s) => (
              <option key={s} value={s}>
                {humanize(s)}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <label className="label" htmlFor="np-retainer">
          Monthly retainer (£)
        </label>
        <input
          id="np-retainer"
          className="input"
          type="number"
          min="0"
          step="1"
          value={retainer}
          onChange={(e) => setRetainer(e.target.value)}
          placeholder="1500"
        />
      </div>

      <div>
        <label className="label" htmlFor="np-desc">
          Description <span className="faint">(optional)</span>
        </label>
        <textarea
          id="np-desc"
          className="input"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What this system does for the client…"
        />
      </div>

      {stack === "ghl" && (
        <p className="faint" style={{ fontSize: 12.5, margin: 0 }}>
          GHL projects are issued a token-mode key so GoHighLevel&apos;s no-code
          webhook can authenticate without signing.
        </p>
      )}

      {error && (
        <p style={{ color: "var(--red)", fontSize: 13, margin: 0 }}>{error}</p>
      )}

      <div style={{ display: "flex", gap: 10 }}>
        <button type="submit" className="btn btn-primary" disabled={!canSubmit}>
          {busy ? "Creating…" : "Create project"}
        </button>
        <Link href="/projects" className="btn">
          Cancel
        </Link>
      </div>
    </form>
  );
}
