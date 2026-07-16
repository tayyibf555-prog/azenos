"use client";

import { COLORS, tint } from "../ui";
import { formatElapsed, type DictationController } from "../../lib/useDictation";

/**
 * Presentational mic affordance shared by the ⌘K palette and the /ask
 * composer — both wrap the same `useDictation()` controller and render this,
 * so "co-pilot accessible anytime" gets one behaviour, not two. Deliberately
 * dumb (no hooks of its own) so it's renderable in isolation for tests
 * without a DOM (see apps/web/test/dictation/mic.test.ts).
 *
 * States: idle → recording (quiet ice-blue pulse via the existing global `.pulse`,
 * which `prefers-reduced-motion: reduce` already neutralises) → transcribing
 * (subtle spinner). When dictation has confirmed there's no OPENAI_API_KEY
 * and no Web Speech fallback, a one-line faint hint replaces the button
 * instead of leaving a dead control. When the browser simply lacks both
 * capture APIs (tier "none", not yet known to be a key issue), render
 * nothing — matching IntakeCopilot's existing silent behaviour.
 */
export function DictationMic({
  controller,
}: {
  controller: Pick<
    DictationController,
    "tier" | "recState" | "listening" | "elapsedSeconds" | "unavailable" | "toggle"
  >;
}) {
  const { tier, recState, listening, elapsedSeconds, unavailable, toggle } = controller;

  if (tier === "none") {
    if (!unavailable) return null;
    return (
      <span className="faint" style={{ fontSize: 11, whiteSpace: "nowrap" }}>
        voice needs OPENAI_API_KEY
      </span>
    );
  }

  if (tier === "whisper") {
    if (recState === "recording") {
      return (
        <button
          type="button"
          className="btn btn-sm pulse"
          onClick={toggle}
          aria-label="Stop recording"
          title="Stop recording (auto-stops at 1:30)"
          style={{
            color: COLORS.teal,
            borderColor: tint(COLORS.teal, 0.5),
            background: tint(COLORS.teal, 0.14),
            fontVariantNumeric: "tabular-nums",
          }}
        >
          ■ {formatElapsed(elapsedSeconds)}
        </button>
      );
    }
    if (recState === "transcribing") {
      return (
        <button
          type="button"
          className="btn btn-sm"
          disabled
          aria-label="Transcribing"
          title="Transcribing…"
        >
          <span className="dict-spinner" aria-hidden />
        </button>
      );
    }
    return (
      <button
        type="button"
        className="btn btn-sm"
        onClick={toggle}
        aria-label="Start dictation"
        title="Dictate (Whisper)"
      >
        🎙
      </button>
    );
  }

  // webspeech
  return (
    <button
      type="button"
      className={listening ? "btn btn-sm pulse" : "btn btn-sm"}
      onClick={toggle}
      aria-label={listening ? "Stop dictation" : "Start dictation"}
      title={listening ? "Stop dictation" : "Dictate (en-GB)"}
      style={
        listening
          ? {
              color: COLORS.teal,
              borderColor: tint(COLORS.teal, 0.5),
              background: tint(COLORS.teal, 0.14),
            }
          : undefined
      }
    >
      {listening ? "● Rec" : "🎙"}
    </button>
  );
}
