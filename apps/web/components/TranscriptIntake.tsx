"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { KeyReveal } from "./KeyReveal";
import { DraftCard } from "./DraftCard";
import { IntakeCopilot, type ChatMessage } from "./IntakeCopilot";
import { COLORS, tint } from "./ui";
import type { ApiError, CreateProjectResponse } from "./types";
import type {
  IntakeResponse,
  ProjectDraft,
  RefineResponse,
} from "../lib/server/intake/schema";

const MIN_CHARS = 100;
const MAX_CHARS = 100_000;
const MAX_UPLOAD_BYTES = 200 * 1024;
const ACCEPT = ".txt,.md,.vtt";

const DRAFT_FIELDS: ReadonlyArray<keyof ProjectDraft> = [
  "name",
  "client",
  "type",
  "stack",
  "description",
  "retainerPenceMonthly",
  "buildFeePence",
  "hourlyRatePence",
  "goals",
  "suggestedEventTypes",
  "assumptions",
];

/** Which top-level fields changed between two drafts (drives the flash). */
function diffDraft(prev: ProjectDraft, next: ProjectDraft): string[] {
  return DRAFT_FIELDS.filter(
    (k) => JSON.stringify(prev[k]) !== JSON.stringify(next[k]),
  );
}

/** Map a finalized draft to the POST /api/projects body (contract mapping). */
function toCreateBody(draft: ProjectDraft): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: draft.name,
    type: draft.type,
    stack: draft.stack,
  };
  if (draft.description.trim()) body.description = draft.description.trim();
  if (draft.retainerPenceMonthly !== null && draft.retainerPenceMonthly >= 0) {
    body.retainerPenceMonthly = draft.retainerPenceMonthly;
  }
  if (draft.buildFeePence !== null && draft.buildFeePence >= 0) {
    body.buildFeePence = draft.buildFeePence;
  }
  if (draft.hourlyRatePence !== null && draft.hourlyRatePence > 0) {
    body.hourlyRatePence = Math.min(draft.hourlyRatePence, 100_000);
  }
  if (draft.goals.length > 0) body.goals = draft.goals;
  if (draft.client.match === "existing" && draft.client.clientId) {
    body.clientId = draft.client.clientId;
  } else {
    body.newClient = {
      name: draft.client.name.trim() || draft.name.trim(),
      ...(draft.client.industrySlug
        ? { industrySlug: draft.client.industrySlug }
        : {}),
    };
  }
  return body;
}

const AUTH_BANNER =
  "Anthropic API key missing or invalid — set ANTHROPIC_API_KEY in .env to enable intake. The manual form still works.";

export function TranscriptIntake() {
  const [transcript, setTranscript] = useState("");
  const [draft, setDraft] = useState<ProjectDraft | null>(null);
  const [changedKeys, setChangedKeys] = useState<string[]>([]);

  const [identifying, setIdentifying] = useState(false);
  const [identifyError, setIdentifyError] = useState<string | null>(null);
  const [authError, setAuthError] = useState(false);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [refining, setRefining] = useState(false);
  const [refineError, setRefineError] = useState<string | null>(null);

  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreateProjectResponse | null>(null);

  const fileRef = useRef<HTMLInputElement | null>(null);
  const msgId = useRef(0);
  const nextMsgId = () => ++msgId.current;
  // Every runId this session receives (intake + refines) — attributed to the
  // project after creation for cost billing (contract addendum §B).
  const runIdsRef = useRef<string[]>([]);

  const charCount = transcript.length;
  const tooShort = charCount < MIN_CHARS;

  function onUpload(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file
    if (!file) return;
    if (file.size > MAX_UPLOAD_BYTES) {
      setIdentifyError("File is larger than 200KB — paste the relevant part instead.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const text = typeof reader.result === "string" ? reader.result : "";
      setTranscript(text.slice(0, MAX_CHARS));
      setIdentifyError(null);
    };
    reader.onerror = () => setIdentifyError("Could not read that file.");
    reader.readAsText(file);
  }

  async function identify() {
    if (tooShort || identifying) return;
    setIdentifying(true);
    setIdentifyError(null);
    setAuthError(false);
    try {
      const res = await fetch("/api/projects/intake", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transcript }),
      });
      const json = (await res.json()) as IntakeResponse | ApiError;
      if (!res.ok || "error" in json) {
        const err = "error" in json ? json.error : `Request failed (${res.status})`;
        if (err === "anthropic_auth") setAuthError(true);
        else setIdentifyError(intakeErrorText(err));
        return;
      }
      runIdsRef.current.push(json.runId);
      setDraft(json.draft);
      setChangedKeys([]);
      setMessages([]);
    } catch {
      setIdentifyError("Network error — please try again.");
    } finally {
      setIdentifying(false);
    }
  }

  async function refine(instruction: string) {
    if (!draft || refining) return;
    setRefining(true);
    setRefineError(null);
    setMessages((prev) => [
      ...prev,
      { id: nextMsgId(), role: "user", text: instruction },
    ]);
    try {
      const res = await fetch("/api/projects/intake/refine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          draft,
          instruction,
          transcript: transcript || undefined,
        }),
      });
      const json = (await res.json()) as RefineResponse | ApiError;
      if (!res.ok || "error" in json) {
        const err = "error" in json ? json.error : `Request failed (${res.status})`;
        if (err === "anthropic_auth") setAuthError(true);
        setRefineError(intakeErrorText(err));
        return;
      }
      runIdsRef.current.push(json.runId);
      setChangedKeys(diffDraft(draft, json.draft));
      setDraft(json.draft);
      setMessages((prev) => [
        ...prev,
        { id: nextMsgId(), role: "assistant", text: json.note },
      ]);
    } catch {
      setRefineError("Network error — please try again.");
    } finally {
      setRefining(false);
    }
  }

  async function create() {
    if (!draft || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(toCreateBody(draft)),
      });
      const json = (await res.json()) as CreateProjectResponse | ApiError;
      if (!res.ok || "error" in json) {
        setCreateError("error" in json ? json.error : `Request failed (${res.status})`);
        return;
      }
      attributeIntakeRuns(json.project.id);
      setCreated(json);
    } catch {
      setCreateError("Network error — please try again.");
    } finally {
      setCreating(false);
    }
  }

  /** Fire-and-forget cost attribution (addendum §B) — failures console-only. */
  function attributeIntakeRuns(projectId: string) {
    const runIds = runIdsRef.current.slice(-100); // route caps at 100
    if (runIds.length === 0) return;
    fetch("/api/projects/intake/attribute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runIds, projectId }),
    })
      .then((res) => {
        if (!res.ok) console.error("[intake] cost attribution failed:", res.status);
      })
      .catch((err) => console.error("[intake] cost attribution failed:", err));
  }

  if (created) {
    return <ProjectCreatedReveal result={created} />;
  }

  return (
    <div style={{ display: "grid", gap: 18 }}>
      {authError && (
        <div
          role="alert"
          style={{
            padding: "11px 13px",
            borderRadius: "var(--radius-tile)",
            fontSize: 13,
            color: COLORS.amber,
            background: tint(COLORS.amber, 0.14),
          }}
        >
          {AUTH_BANNER}
        </div>
      )}

      {/* transcript input */}
      <div style={{ display: "grid", gap: 8 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <label className="label" htmlFor="intake-transcript" style={{ margin: 0 }}>
            Call transcript
          </label>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span
              className="faint"
              style={{ fontSize: 12, fontVariantNumeric: "tabular-nums" }}
            >
              {charCount.toLocaleString("en-GB")} chars
            </span>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => fileRef.current?.click()}
            >
              Upload .txt
            </button>
            <input
              ref={fileRef}
              type="file"
              accept={ACCEPT}
              onChange={onUpload}
              style={{ display: "none" }}
              aria-hidden
              tabIndex={-1}
            />
          </div>
        </div>
        <textarea
          id="intake-transcript"
          className="input"
          value={transcript}
          onChange={(e) => setTranscript(e.target.value.slice(0, MAX_CHARS))}
          placeholder="Paste the discovery / sales call transcript here…"
          style={{ minHeight: 160, fontFamily: "var(--mono)", fontSize: 12.5 }}
        />
        <div
          style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}
        >
          <button
            type="button"
            className="btn btn-primary"
            onClick={identify}
            disabled={tooShort || identifying}
          >
            {identifying ? "Sonnet is reading the call…" : "Identify project"}
          </button>
          {tooShort && charCount > 0 && (
            <span className="faint" style={{ fontSize: 12.5 }}>
              At least {MIN_CHARS} characters needed.
            </span>
          )}
          {identifyError && (
            <span style={{ color: COLORS.red, fontSize: 12.5 }}>
              {identifyError}
            </span>
          )}
        </div>
      </div>

      {/* draft + copilot */}
      {draft && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
          <div style={{ flex: "1 1 440px", minWidth: 0, display: "grid", gap: 12 }}>
            <DraftCard
              draft={draft}
              changedKeys={changedKeys}
              onNameChange={(name) => setDraft({ ...draft, name })}
            />
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <button
                type="button"
                className="btn btn-primary"
                onClick={create}
                disabled={creating}
              >
                {creating ? "Creating…" : "Create project"}
              </button>
              {createError && (
                <span style={{ color: COLORS.red, fontSize: 12.5 }}>
                  {createError}
                </span>
              )}
            </div>
          </div>
          <div style={{ flex: "1 1 320px", minWidth: 0 }}>
            <IntakeCopilot
              messages={messages}
              onSend={refine}
              busy={refining}
              error={refineError}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function intakeErrorText(error: string): string {
  switch (error) {
    case "anthropic_rate_limited":
      return "Rate limited by Anthropic — wait a moment and try again.";
    case "intake_parse_failed":
      return "The model returned an unusable draft — try again.";
    case "intake_failed":
      return "Intake failed — try again in a moment.";
    default:
      return error;
  }
}

/**
 * Shared post-creation reveal. Reused by BOTH the transcript flow and the
 * manual form (NewProjectForm imports it) so the reveal UI is never forked.
 * Wraps the existing KeyReveal component.
 */
export function ProjectCreatedReveal({
  result,
}: {
  result: CreateProjectResponse;
}) {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const endpoint = `${origin}/api/ingest/${result.key.publicKey}`;
  return (
    <div style={{ maxWidth: 640 }}>
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>
        {result.project.name} is live
      </h1>
      <p className="muted" style={{ marginBottom: 20, fontSize: 13.5 }}>
        Wire the client&apos;s system to this endpoint, then watch events arrive
        in the ticker.
      </p>
      <KeyReveal
        endpoint={endpoint}
        publicKey={result.key.publicKey}
        secret={result.key.secret}
        authMode={result.key.authMode}
      >
        <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
          <Link
            href={`/projects/${result.project.id}?tab=setup`}
            className="btn btn-primary"
          >
            Go to project →
          </Link>
          <Link href="/projects" className="btn">
            All projects
          </Link>
        </div>
      </KeyReveal>
    </div>
  );
}
