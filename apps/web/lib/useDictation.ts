"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Shared client-side dictation hook — the co-pilot-anywhere requirement
 * (owner brief: "⌘K and Ask need voice, not just IntakeCopilot"). Extracted
 * from apps/web/components/IntakeCopilot.tsx's proven mic tiers so the
 * CommandPalette and the /ask composer get the same behaviour without
 * duplicating (or coupling to) that component:
 *
 *   1. whisper   — MediaRecorder capture → POST /api/transcribe (OpenAI
 *      whisper-1). Recording auto-stops at 90s; the returned text is handed
 *      back to the caller to append however it owns its input.
 *   2. webspeech — Web Speech API (en-GB, interim results), the silent
 *      fallback when MediaRecorder is unsupported, or the server reports
 *      `openai_auth` (no OPENAI_API_KEY).
 *   3. none      — no capture path exists. If that's specifically because
 *      Whisper confirmed no key *and* there's no Web Speech fallback either,
 *      `unavailable` is set so callers can show a one-line hint instead of a
 *      dead button; otherwise (browser simply lacks both APIs) the caller
 *      should render nothing, exactly as IntakeCopilot does today.
 *
 * The hook owns no draft text — callers supply `getValue`/`setValue` so the
 * palette and the Ask screen keep dictated text in their own existing input
 * state (mirrors IntakeCopilot's `setInput`/baseTextRef append pattern).
 *
 * Framework-free pieces (feature detection, mime/ext mapping, the transcribe
 * fetch + response classification, the getUserMedia wrapper) are exported
 * standalone so they're unit-testable without a DOM — see
 * apps/web/test/dictation/useDictation.test.ts.
 */

export type DictationTier = "whisper" | "webspeech" | "none";
export type DictationRecState = "idle" | "recording" | "transcribing";

export const MAX_RECORD_SECONDS = 90;

const RECORDER_MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/mp4",
];

// ── feature detection ───────────────────────────────────────────────────────

export function mediaRecorderSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof MediaRecorder !== "undefined" &&
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function"
  );
}

// ── minimal Web Speech API typings (not in the DOM lib) ─────────────────────

interface SpeechAlternativeLike {
  readonly transcript: string;
}
interface SpeechResultLike {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: SpeechAlternativeLike;
}
interface SpeechResultListLike {
  readonly length: number;
  readonly [index: number]: SpeechResultLike;
}
interface SpeechRecognitionEventLike {
  readonly resultIndex: number;
  readonly results: SpeechResultListLike;
}
interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

export function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function pickRecorderMime(): string | undefined {
  return RECORDER_MIME_CANDIDATES.find((c) => MediaRecorder.isTypeSupported(c));
}

export function extForMime(type: string): string {
  if (/ogg/i.test(type)) return "ogg";
  if (/mp4/i.test(type)) return "mp4";
  if (/wav/i.test(type)) return "wav";
  return "webm";
}

export function formatElapsed(s: number): string {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// ── transcribe fetch + typed classification (pure, DOM-free) ────────────────

export type TranscribeOutcome =
  | { kind: "text"; text: string }
  | { kind: "empty" }
  | { kind: "auth-missing" } // 502 openai_auth — no OPENAI_API_KEY
  | { kind: "failed" }; // any other non-OK response or network error

/** POST the clip to /api/transcribe and classify the result. Never throws. */
export async function transcribeBlob(
  blob: Blob,
  fetchImpl: typeof fetch = fetch,
): Promise<TranscribeOutcome> {
  try {
    const form = new FormData();
    form.append("audio", blob, `clip.${extForMime(blob.type)}`);
    const res = await fetchImpl("/api/transcribe", { method: "POST", body: form });
    const json = (await res.json()) as { text?: unknown; error?: unknown };
    if (res.ok && typeof json.text === "string") {
      const text = json.text.trim();
      return text ? { kind: "text", text } : { kind: "empty" };
    }
    if (json.error === "openai_auth") return { kind: "auth-missing" };
    return { kind: "failed" };
  } catch {
    return { kind: "failed" };
  }
}

// ── mic permission wrapper (pure-ish, DOM-free aside from the MediaDevices arg) ─

export type MicRequestOutcome =
  | { ok: true; stream: MediaStream }
  | { ok: false; reason: "permission-denied" };

export async function requestMicStream(
  mediaDevices: Pick<MediaDevices, "getUserMedia"> | undefined = typeof navigator !==
  "undefined"
    ? navigator.mediaDevices
    : undefined,
): Promise<MicRequestOutcome> {
  try {
    if (!mediaDevices) return { ok: false, reason: "permission-denied" };
    const stream = await mediaDevices.getUserMedia({ audio: true });
    return { ok: true, stream };
  } catch {
    return { ok: false, reason: "permission-denied" };
  }
}

// ── the hook ─────────────────────────────────────────────────────────────────

export interface UseDictationOptions {
  /** Read the caller's live input value at the instant text needs appending. */
  getValue: () => string;
  /** Receive the full replacement value once dictation produces text. */
  setValue: (next: string) => void;
}

export interface DictationController {
  tier: DictationTier;
  recState: DictationRecState;
  /** Web Speech tier only: true while actively listening. */
  listening: boolean;
  /** Whisper tier only: seconds elapsed in the current recording. */
  elapsedSeconds: number;
  /** Calm, user-facing error string (mic permission, network) — or null. */
  error: string | null;
  /** True once Whisper confirmed no OPENAI_API_KEY and no Web Speech fallback exists. */
  unavailable: boolean;
  /** Start capture (whisper) or start listening (webspeech). No-op otherwise. */
  start: () => void;
  /** Stop capture/listening. No-op if idle. */
  stop: () => void;
  /** Start if idle/not-listening, stop if active. The one handler a mic button needs. */
  toggle: () => void;
}

export function useDictation({ getValue, setValue }: UseDictationOptions): DictationController {
  const [tier, setTier] = useState<DictationTier>("none");
  const [recState, setRecState] = useState<DictationRecState>("idle");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [listening, setListening] = useState(false);
  const [unavailable, setUnavailable] = useState(false);

  const recRef = useRef<{ recorder: MediaRecorder; stream: MediaStream } | null>(
    null,
  );
  const tickerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const baseTextRef = useRef("");

  // Latest getValue/setValue without forcing callback identities to change
  // every render (callers rarely memoize inline closures).
  const getValueRef = useRef(getValue);
  const setValueRef = useRef(setValue);
  getValueRef.current = getValue;
  setValueRef.current = setValue;

  // Tier detection after mount only — server render shows no mic, avoiding
  // hydration skew (same reasoning as IntakeCopilot).
  useEffect(() => {
    if (mediaRecorderSupported()) setTier("whisper");
    else if (getSpeechRecognitionCtor()) setTier("webspeech");
  }, []);

  useEffect(() => {
    return () => {
      recognitionRef.current?.stop();
      if (tickerRef.current) clearInterval(tickerRef.current);
      const rec = recRef.current;
      if (rec) {
        rec.recorder.onstop = null;
        rec.recorder.ondataavailable = null;
        if (rec.recorder.state !== "inactive") rec.recorder.stop();
        rec.stream.getTracks().forEach((t) => t.stop());
      }
    };
  }, []);

  const appendText = useCallback((text: string) => {
    const prev = getValueRef.current();
    setValueRef.current(prev.trim() ? `${prev.trimEnd()} ${text}` : text);
  }, []);

  // ── whisper capture ─────────────────────────────────────────────────────

  const stopRecording = useCallback(() => {
    if (tickerRef.current) {
      clearInterval(tickerRef.current);
      tickerRef.current = null;
    }
    const rec = recRef.current;
    if (rec && rec.recorder.state !== "inactive") rec.recorder.stop();
  }, []);

  const transcribe = useCallback(async (blob: Blob) => {
    if (blob.size === 0) {
      setRecState("idle");
      return;
    }
    setRecState("transcribing");
    const outcome = await transcribeBlob(blob);
    switch (outcome.kind) {
      case "text":
        appendText(outcome.text);
        break;
      case "auth-missing": {
        const fallback = getSpeechRecognitionCtor() ? "webspeech" : "none";
        setTier(fallback);
        if (fallback === "none") setUnavailable(true);
        break;
      }
      case "failed":
        setError("Transcription failed — try again.");
        break;
      case "empty":
      default:
        break;
    }
    setRecState("idle");
  }, [appendText]);

  const startRecording = useCallback(async () => {
    if (recState !== "idle") return;
    setError(null);
    const mic = await requestMicStream();
    if (!mic.ok) {
      setError("Microphone unavailable — check browser permissions.");
      return;
    }
    const { stream } = mic;
    let recorder: MediaRecorder;
    try {
      const mime = pickRecorderMime();
      recorder = mime
        ? new MediaRecorder(stream, { mimeType: mime })
        : new MediaRecorder(stream);
    } catch {
      stream.getTracks().forEach((t) => t.stop());
      setError("Recording is not supported in this browser.");
      return;
    }
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    recorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      recRef.current = null;
      void transcribe(new Blob(chunks, { type: recorder.mimeType || "audio/webm" }));
    };
    recRef.current = { recorder, stream };
    setElapsedSeconds(0);
    setRecState("recording");
    const startedAt = Date.now();
    tickerRef.current = setInterval(() => {
      const s = Math.floor((Date.now() - startedAt) / 1000);
      setElapsedSeconds(Math.min(s, MAX_RECORD_SECONDS));
      if (s >= MAX_RECORD_SECONDS) stopRecording();
    }, 250);
    recorder.start();
  }, [recState, stopRecording, transcribe]);

  // ── webspeech fallback ───────────────────────────────────────────────────

  const toggleWebSpeech = useCallback(() => {
    if (listening) {
      recognitionRef.current?.stop();
      return;
    }
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) return;
    setError(null);
    const rec = new Ctor();
    rec.lang = "en-GB";
    rec.interimResults = true;
    rec.continuous = false;
    rec.maxAlternatives = 1;
    const current = getValueRef.current();
    baseTextRef.current = current ? `${current.trimEnd()} ` : "";
    rec.onresult = (event) => {
      let transcript = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result && result.length > 0) transcript += result[0]?.transcript ?? "";
      }
      setValueRef.current(baseTextRef.current + transcript);
    };
    rec.onend = () => {
      setListening(false);
      recognitionRef.current = null;
    };
    rec.onerror = () => {
      setListening(false);
      recognitionRef.current = null;
    };
    recognitionRef.current = rec;
    setListening(true);
    rec.start();
  }, [listening]);

  const start = useCallback(() => {
    if (tier === "whisper") void startRecording();
    else if (tier === "webspeech" && !listening) toggleWebSpeech();
  }, [tier, listening, startRecording, toggleWebSpeech]);

  const stop = useCallback(() => {
    if (tier === "whisper") stopRecording();
    else if (tier === "webspeech" && listening) toggleWebSpeech();
  }, [tier, listening, stopRecording, toggleWebSpeech]);

  const toggle = useCallback(() => {
    if (tier === "whisper") {
      if (recState === "idle") void startRecording();
      else if (recState === "recording") stopRecording();
    } else if (tier === "webspeech") {
      toggleWebSpeech();
    }
  }, [tier, recState, startRecording, stopRecording, toggleWebSpeech]);

  return {
    tier,
    recState,
    listening,
    elapsedSeconds,
    error,
    unavailable,
    start,
    stop,
    toggle,
  };
}
