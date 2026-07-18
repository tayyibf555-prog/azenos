"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useDictation, formatElapsed } from "../lib/useDictation";
import { openAskPalette } from "./ask/paletteEvents";
import { TINTS } from "./system/tokens";

/**
 * Push-to-talk (owner brief 2026-07-17): hold Control+Option (⌃⌥) anywhere in
 * the app → a Siri-style listening overlay → release → transcribe (Whisper via
 * the shared useDictation hook) → drop the transcript into the Ask palette,
 * focused, ready to send.
 *
 * Mounted once, globally, in AppFrame. The hold-to-talk state machine handles
 * the fiddly bits: key auto-repeat (start fires once), releasing EITHER
 * modifier ends it, a real ⌃⌥+letter shortcut aborts instead of recording,
 * window blur / tab hide is a safety release, and a sub-threshold tap is
 * treated as "you didn't mean it" rather than an empty recording.
 */

const MIN_HOLD_MS = 350; // below this, a ⌃⌥ tap is ignored (accidental)
const AI = TINTS.lavender; // the co-pilot's tint

type Phase = "idle" | "listening" | "thinking" | "denied";

export function PushToTalk() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [note, setNote] = useState<string | null>(null);

  // The transcript accumulates here; useDictation replaces it via setValue.
  const bufferRef = useRef("");
  const startedAtRef = useRef(0);
  // Holds the auto-dismiss timer for the "denied" overlay so it can be cleared
  // if we start again (or unmount) before it fires — no setState after unmount.
  const deniedTimerRef = useRef<number | undefined>(undefined);

  const dictation = useDictation({
    getValue: useCallback(() => bufferRef.current, []),
    setValue: useCallback((next: string) => {
      bufferRef.current = next;
    }, []),
  });

  // Window listeners are registered once; they must reach the LATEST values,
  // so route everything through refs rather than re-registering per render.
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const ctlRef = useRef(dictation);
  ctlRef.current = dictation;

  // Show the transient "denied" overlay for ~2.2s, owning its dismiss timer in
  // deniedTimerRef (cleared on re-entry / unmount) so no setState races a gone
  // component.
  const showDenied = useCallback((message: string) => {
    if (deniedTimerRef.current !== undefined) {
      window.clearTimeout(deniedTimerRef.current);
    }
    setNote(message);
    setPhase("denied");
    deniedTimerRef.current = window.setTimeout(() => {
      setPhase((p) => (p === "denied" ? "idle" : p));
      setNote(null);
      deniedTimerRef.current = undefined;
    }, 2200);
  }, []);

  const begin = useCallback(() => {
    if (phaseRef.current !== "idle") return;
    // A prior denied overlay may still be counting down — drop its timer.
    if (deniedTimerRef.current !== undefined) {
      window.clearTimeout(deniedTimerRef.current);
      deniedTimerRef.current = undefined;
    }
    const c = ctlRef.current;
    if (c.tier === "none" || c.unavailable) {
      // No capture path / no OPENAI_API_KEY + no Web Speech — say so, briefly.
      showDenied(
        c.unavailable
          ? "Voice needs OPENAI_API_KEY in .env"
          : "This browser can't capture audio",
      );
      return;
    }
    bufferRef.current = "";
    startedAtRef.current = Date.now();
    setNote(null);
    setPhase("listening");
    c.start();
  }, [showDenied]);

  const cancel = useCallback(() => {
    if (phaseRef.current === "idle" || phaseRef.current === "denied") return;
    // cancel() (not stop()) — discard the clip, never bill a transcribe call.
    ctlRef.current.cancel();
    bufferRef.current = "";
    setPhase("idle");
    setNote(null);
  }, []);

  const finish = useCallback(() => {
    if (phaseRef.current !== "listening") return;
    if (Date.now() - startedAtRef.current < MIN_HOLD_MS) {
      // Too quick to be real speech — discard (cancel, no transcription).
      ctlRef.current.cancel();
      bufferRef.current = "";
      setPhase("idle");
      setNote(null);
      return;
    }
    setPhase("thinking");
    ctlRef.current.stop();
  }, []);

  // Route the transcript once the controller comes fully to rest after release.
  useEffect(() => {
    if (phase !== "thinking") return;
    if (dictation.recState === "idle" && !dictation.listening) {
      const text = bufferRef.current.trim();
      if (text) {
        setPhase("idle");
        setNote(null);
        openAskPalette(text);
      } else if (dictation.unavailable) {
        // Mid-session the tier fell back to "none" (Whisper reported no key and
        // no Web Speech fallback) — the clip is gone. Say so instead of
        // silently blinking back to idle.
        showDenied("Voice needs OPENAI_API_KEY in .env");
      } else {
        setPhase("idle");
        setNote(null);
      }
    }
  }, [phase, dictation.recState, dictation.listening, dictation.unavailable, showDenied]);

  // Surface a capture error (mic permission denied mid-session, network).
  // Keyed on errorNonce (not the string) so a REPEAT of the same failure
  // re-shows the overlay; guarded on >0 so it never fires on mount.
  useEffect(() => {
    if (dictation.errorNonce > 0 && dictation.error && phaseRef.current !== "idle") {
      setNote(dictation.error);
      setPhase("denied");
      const t = window.setTimeout(() => {
        setPhase((p) => (p === "denied" ? "idle" : p));
        setNote(null);
      }, 2600);
      return () => window.clearTimeout(t);
    }
  }, [dictation.errorNonce]);

  // No setState after unmount — drop the denied auto-dismiss timer on teardown.
  useEffect(() => {
    return () => {
      if (deniedTimerRef.current !== undefined) {
        window.clearTimeout(deniedTimerRef.current);
      }
    };
  }, []);

  // The global ⌃⌥ hold-to-talk listeners.
  useEffect(() => {
    const isMods = (e: KeyboardEvent) =>
      e.ctrlKey && e.altKey && !e.metaKey && !e.shiftKey;

    const onDown = (e: KeyboardEvent) => {
      if (e.key === "Control" || e.key === "Alt") {
        // Start only once BOTH are down (the second keydown carries both flags).
        if (isMods(e)) begin();
      } else if (phaseRef.current === "listening") {
        // A real ⌃⌥+key shortcut while holding — the user meant the shortcut.
        cancel();
      }
    };
    const onUp = (e: KeyboardEvent) => {
      if (phaseRef.current !== "listening") return;
      // Releasing either modifier (or losing the combo) ends the utterance.
      if (e.key === "Control" || e.key === "Alt" || !e.ctrlKey || !e.altKey) {
        finish();
      }
    };
    const onBlur = () => cancel();
    const onHide = () => {
      if (document.visibilityState === "hidden") cancel();
    };

    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onHide);
    };
  }, [begin, cancel, finish]);

  if (phase === "idle") return null;

  const denied = phase === "denied";
  return (
    <div
      className="ptt-scrim"
      role="status"
      aria-live="polite"
      aria-label="Voice to Azen"
    >
      <div className="ptt-panel">
        <div
          className={"ptt-orb" + (phase === "listening" ? " is-listening" : "")}
          style={{ background: AI.bg, color: AI.fg }}
          aria-hidden
        >
          {denied ? (
            <span className="ptt-glyph">🔇</span>
          ) : phase === "thinking" ? (
            <span className="ptt-spin" />
          ) : (
            <span className="ptt-bars">
              <i />
              <i />
              <i />
              <i />
              <i />
            </span>
          )}
        </div>

        <div className="ptt-copy">
          <div className="ptt-title">
            {denied
              ? "Voice unavailable"
              : phase === "thinking"
                ? "Thinking…"
                : "Listening…"}
          </div>
          <div className="ptt-sub">
            {note ??
              (phase === "listening" ? (
                dictation.tier === "whisper" ? (
                  <>
                    {formatElapsed(dictation.elapsedSeconds)} · release{" "}
                    <span className="kbd">⌃⌥</span> to send
                  </>
                ) : (
                  // Web Speech has no elapsed ticker — don't show a frozen 0:00.
                  <>
                    release <span className="kbd">⌃⌥</span> to send
                  </>
                )
              ) : (
                "Sending to Ask Azen"
              ))}
          </div>
        </div>
      </div>
    </div>
  );
}
