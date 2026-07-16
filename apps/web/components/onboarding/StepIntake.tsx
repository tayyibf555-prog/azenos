"use client";

import { useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { DraftCard } from "../DraftCard";
import { IntakeCopilot, type ChatMessage } from "../IntakeCopilot";
import { DictationMic } from "../ask/DictationMic";
import { useDictation } from "../../lib/useDictation";
import { diffDraft } from "../../lib/onboarding/wizard";
import { COLORS, tint } from "../ui";
import type { ApiError } from "../types";
import type {
  IntakeResponse,
  ProjectDraft,
  RefineResponse,
} from "../../lib/server/intake/schema";

const MIN_CHARS = 100;
const MAX_CHARS = 100_000;
const MAX_UPLOAD_BYTES = 200 * 1024;
const ACCEPT = ".txt,.md,.vtt";

const AUTH_BANNER =
  "Anthropic API key missing or invalid — set ANTHROPIC_API_KEY in .env to enable intake. Skip ahead and fill the details in manually.";

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
 * Step 2 — optional transcript intake. Reuses the SAME identify/refine
 * routes and the SAME DraftCard/IntakeCopilot components as the standalone
 * "From call transcript" flow (components/TranscriptIntake.tsx) — this is a
 * new orchestration of those pieces for the stepper, not a fork of them. The
 * transcript box additionally gets the shared dictation hook (Whisper /
 * Web Speech tiers) so it's paste-OR-dictate, per the owner's co-pilot-
 * anytime requirement.
 *
 * Fully skippable: a project with no drafted fields flows straight to step 3
 * for manual entry.
 */
export function StepIntake({
  transcript,
  onTranscriptChange,
  draft,
  onDraftChange,
  messages,
  onMessagesChange,
  onRunId,
}: {
  transcript: string;
  onTranscriptChange: (v: string) => void;
  draft: ProjectDraft;
  onDraftChange: (draft: ProjectDraft) => void;
  messages: ChatMessage[];
  onMessagesChange: (messages: ChatMessage[]) => void;
  onRunId: (runId: string) => void;
}) {
  // The wizard's draft is a single object shared across every step (never
  // null) — so "has intake actually produced something yet" needs its own
  // flag rather than truthiness-checking `draft`, otherwise the DraftCard +
  // copilot would render immediately with the still-blank starting draft.
  const [identified, setIdentified] = useState(false);
  const [identifying, setIdentifying] = useState(false);
  const [identifyError, setIdentifyError] = useState<string | null>(null);
  const [authError, setAuthError] = useState(false);
  const [refining, setRefining] = useState(false);
  const [refineError, setRefineError] = useState<string | null>(null);
  const [changedKeys, setChangedKeys] = useState<string[]>([]);

  const fileRef = useRef<HTMLInputElement | null>(null);
  const msgId = useRef(0);
  const nextMsgId = () => ++msgId.current;

  const dictation = useDictation({
    getValue: () => transcript,
    setValue: onTranscriptChange,
  });

  const charCount = transcript.length;
  const tooShort = charCount < MIN_CHARS;

  function onUpload(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (file.size > MAX_UPLOAD_BYTES) {
      setIdentifyError("File is larger than 200KB — paste the relevant part instead.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const text = typeof reader.result === "string" ? reader.result : "";
      onTranscriptChange(text.slice(0, MAX_CHARS));
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
      onRunId(json.runId);
      setChangedKeys([]);
      // Keep the client chosen in step 1 — the transcript's own guess at
      // client identity is redundant now that identity was already resolved
      // explicitly; every OTHER field comes from the transcript read.
      onDraftChange({ ...json.draft, client: draft.client });
      onMessagesChange([]);
      setIdentified(true);
    } catch {
      setIdentifyError("Network error — please try again.");
    } finally {
      setIdentifying(false);
    }
  }

  async function refine(instruction: string) {
    if (refining) return;
    setRefining(true);
    setRefineError(null);
    const withUser = [
      ...messages,
      { id: nextMsgId(), role: "user" as const, text: instruction },
    ];
    onMessagesChange(withUser);
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
      onRunId(json.runId);
      setChangedKeys(diffDraft(draft, json.draft));
      onDraftChange(json.draft);
      onMessagesChange([
        ...withUser,
        { id: nextMsgId(), role: "assistant" as const, text: json.note },
      ]);
    } catch {
      setRefineError("Network error — please try again.");
    } finally {
      setRefining(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: 18 }}>
      {authError && (
        <div
          role="alert"
          style={{
            padding: "11px 13px",
            borderRadius: "var(--radius-sm)",
            fontSize: 13,
            color: COLORS.amber,
            background: tint(COLORS.amber, 0.1),
            border: `1px solid ${tint(COLORS.amber, 0.3)}`,
          }}
        >
          {AUTH_BANNER}
        </div>
      )}

      <div style={{ display: "grid", gap: 8 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <label className="label" htmlFor="wiz-transcript" style={{ margin: 0 }}>
            Call transcript <span className="faint">(optional — paste or dictate)</span>
          </label>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span className="faint" style={{ fontSize: 12, fontVariantNumeric: "tabular-nums" }}>
              {charCount.toLocaleString("en-GB")} chars
            </span>
            <button type="button" className="btn btn-sm" onClick={() => fileRef.current?.click()}>
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
        <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
          <textarea
            id="wiz-transcript"
            className="input"
            value={transcript}
            onChange={(e) => onTranscriptChange(e.target.value.slice(0, MAX_CHARS))}
            placeholder="Paste the discovery / sales call transcript here, or use the mic…"
            style={{ minHeight: 160, fontFamily: "var(--mono)", fontSize: 12.5, flex: 1 }}
          />
          <DictationMic controller={dictation} />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
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
            <span style={{ color: COLORS.red, fontSize: 12.5 }}>{identifyError}</span>
          )}
        </div>
      </div>

      {identified && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
          <div style={{ flex: "1 1 440px", minWidth: 0 }}>
            <DraftCard
              draft={draft}
              changedKeys={changedKeys}
              onNameChange={(name) => onDraftChange({ ...draft, name })}
            />
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
