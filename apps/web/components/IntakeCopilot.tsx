"use client";

import { useEffect, useRef, useState } from "react";
import { COLORS, tint } from "./ui";

/**
 * Chat panel that drives the refine loop. Message history + text input + send,
 * plus mic dictation in tiers (contract addendum §A):
 *   1. whisper — MediaRecorder capture → POST /api/transcribe (OpenAI
 *      whisper-1); recording UI = pulse + elapsed seconds + stop button,
 *      auto-stop at 90s; text is APPENDED to the input for review.
 *   2. webspeech — the original Web Speech path (en-GB, interim results),
 *      kept as the silent fallback when Whisper is unavailable (no
 *      MediaRecorder, or the server reports openai_auth).
 *   3. none — mic button hidden entirely.
 *
 * Stateless from the copilot's view: it owns no draft. `onSend` fires a refine
 * request; the parent appends the returned note as an assistant message.
 */

export interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  text: string;
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

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

// ── whisper tier ─────────────────────────────────────────────────────────────

type MicTier = "whisper" | "webspeech" | "none";
type RecState = "idle" | "recording" | "transcribing";

const MAX_RECORD_SECONDS = 90;

const RECORDER_MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/mp4",
];

function mediaRecorderSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof MediaRecorder !== "undefined" &&
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function"
  );
}

function pickRecorderMime(): string | undefined {
  return RECORDER_MIME_CANDIDATES.find((c) => MediaRecorder.isTypeSupported(c));
}

function extForMime(type: string): string {
  if (/ogg/i.test(type)) return "ogg";
  if (/mp4/i.test(type)) return "mp4";
  if (/wav/i.test(type)) return "wav";
  return "webm";
}

function formatElapsed(s: number): string {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function IntakeCopilot({
  messages,
  onSend,
  busy,
  error,
}: {
  messages: ChatMessage[];
  onSend: (text: string) => void;
  busy: boolean;
  error: string | null;
}) {
  const [input, setInput] = useState("");
  const [micTier, setMicTier] = useState<MicTier>("none");
  const [micError, setMicError] = useState<string | null>(null);

  // whisper tier state
  const [recState, setRecState] = useState<RecState>("idle");
  const [elapsed, setElapsed] = useState(0);
  const recRef = useRef<{ recorder: MediaRecorder; stream: MediaStream } | null>(
    null,
  );
  const tickerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // webspeech fallback state
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const baseTextRef = useRef("");

  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Tier detection after mount (server render shows no mic — no hydration skew).
  useEffect(() => {
    if (mediaRecorderSupported()) setMicTier("whisper");
    else if (getSpeechRecognitionCtor()) setMicTier("webspeech");
  }, []);

  useEffect(() => {
    // Autoscroll the transcript on new messages.
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, busy]);

  useEffect(() => {
    // Release recognition, timers, recorder and mic hardware on unmount.
    return () => {
      recognitionRef.current?.stop();
      if (tickerRef.current) clearInterval(tickerRef.current);
      const rec = recRef.current;
      if (rec) {
        rec.recorder.onstop = null; // drop the pending transcription
        rec.recorder.ondataavailable = null;
        if (rec.recorder.state !== "inactive") rec.recorder.stop();
        rec.stream.getTracks().forEach((t) => t.stop());
      }
    };
  }, []);

  // ── whisper capture ────────────────────────────────────────────────────────

  async function startRecording() {
    if (recState !== "idle") return;
    setMicError(null);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setMicError("Microphone unavailable — check browser permissions.");
      return;
    }
    let recorder: MediaRecorder;
    try {
      const mime = pickRecorderMime();
      recorder = mime
        ? new MediaRecorder(stream, { mimeType: mime })
        : new MediaRecorder(stream);
    } catch {
      stream.getTracks().forEach((t) => t.stop());
      setMicError("Recording is not supported in this browser.");
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
    setElapsed(0);
    setRecState("recording");
    const startedAt = Date.now();
    tickerRef.current = setInterval(() => {
      const s = Math.floor((Date.now() - startedAt) / 1000);
      setElapsed(Math.min(s, MAX_RECORD_SECONDS));
      if (s >= MAX_RECORD_SECONDS) stopRecording(); // hard 90s cap
    }, 250);
    recorder.start();
  }

  function stopRecording() {
    if (tickerRef.current) {
      clearInterval(tickerRef.current);
      tickerRef.current = null;
    }
    const rec = recRef.current;
    if (rec && rec.recorder.state !== "inactive") rec.recorder.stop();
  }

  async function transcribe(blob: Blob) {
    if (blob.size === 0) {
      setRecState("idle");
      return;
    }
    setRecState("transcribing");
    try {
      const form = new FormData();
      form.append("audio", blob, `clip.${extForMime(blob.type)}`);
      const res = await fetch("/api/transcribe", { method: "POST", body: form });
      const json = (await res.json()) as { text?: unknown; error?: unknown };
      if (res.ok && typeof json.text === "string") {
        const text = json.text.trim();
        if (text) {
          setInput((prev) => (prev.trim() ? `${prev.trimEnd()} ${text}` : text));
        }
      } else if (json.error === "openai_auth") {
        // Whisper not configured — silently fall back (addendum §A).
        setMicTier(getSpeechRecognitionCtor() ? "webspeech" : "none");
      } else {
        setMicError("Transcription failed — try again.");
      }
    } catch {
      setMicError("Network error — dictation failed.");
    } finally {
      setRecState("idle");
    }
  }

  // ── webspeech fallback ─────────────────────────────────────────────────────

  function toggleMic() {
    if (listening) {
      recognitionRef.current?.stop();
      return;
    }
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) return;
    setMicError(null);
    const rec = new Ctor();
    rec.lang = "en-GB";
    rec.interimResults = true;
    rec.continuous = false;
    rec.maxAlternatives = 1;
    baseTextRef.current = input ? `${input.trimEnd()} ` : "";
    rec.onresult = (event) => {
      let transcript = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result && result.length > 0) transcript += result[0]?.transcript ?? "";
      }
      setInput(baseTextRef.current + transcript);
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
  }

  function submit() {
    const text = input.trim();
    if (!text || busy) return;
    recognitionRef.current?.stop();
    onSend(text);
    setInput("");
  }

  const placeholder =
    recState === "recording"
      ? "Recording… press stop when done"
      : listening
        ? "Listening…"
        : "Ask for a change…";

  return (
    <div
      className="card"
      style={{ display: "flex", flexDirection: "column", minHeight: 340 }}
    >
      <div
        style={{
          padding: "12px 14px",
          fontSize: 13,
          fontWeight: 600,
        }}
      >
        Refine with the co-pilot
        <span className="faint" style={{ fontWeight: 400 }}>
          {" "}
          — type or dictate a change
        </span>
      </div>

      <div
        ref={scrollRef}
        style={{
          flex: 1,
          overflowY: "auto",
          padding: 14,
          display: "flex",
          flexDirection: "column",
          gap: 10,
          maxHeight: 380,
        }}
      >
        {messages.length === 0 && (
          <p className="faint" style={{ fontSize: 13, lineHeight: 1.55 }}>
            e.g. &ldquo;set the retainer to £2,000 a month&rdquo;, &ldquo;this
            is for an existing client, Bright Smile Dental&rdquo;, or &ldquo;add
            a goal of 30 bookings a week&rdquo;.
          </p>
        )}
        {messages.map((m) => (
          <Bubble key={m.id} role={m.role} text={m.text} />
        ))}
        {busy && (
          <div className="pulse faint" style={{ fontSize: 12.5 }}>
            Sonnet is updating the draft…
          </div>
        )}
        {error && (
          <p style={{ color: COLORS.red, fontSize: 12.5 }}>{error}</p>
        )}
      </div>

      <div
        style={{
          padding: 10,
          display: "grid",
          gap: 6,
        }}
      >
        <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
          <textarea
            className="input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={placeholder}
            rows={2}
            aria-label="Refinement instruction"
            style={{ minHeight: 40, flex: 1 }}
          />
          {micTier === "whisper" &&
            (recState === "recording" ? (
              <button
                type="button"
                className="btn btn-sm pulse"
                onClick={stopRecording}
                aria-label="Stop recording"
                title="Stop recording (auto-stops at 1:30)"
                style={{
                  color: COLORS.red,
                  borderColor: tint(COLORS.red, 0.5),
                  background: tint(COLORS.red, 0.12),
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                ■ {formatElapsed(elapsed)}
              </button>
            ) : (
              <button
                type="button"
                className={`btn btn-sm${recState === "transcribing" ? " pulse" : ""}`}
                onClick={startRecording}
                disabled={recState === "transcribing"}
                aria-label="Start dictation"
                title={
                  recState === "transcribing" ? "Transcribing…" : "Dictate (Whisper)"
                }
              >
                {recState === "transcribing" ? "…" : "🎙"}
              </button>
            ))}
          {micTier === "webspeech" && (
            <button
              type="button"
              className={`btn btn-sm${listening ? " pulse" : ""}`}
              onClick={toggleMic}
              aria-label={listening ? "Stop dictation" : "Start dictation"}
              title={listening ? "Stop dictation" : "Dictate (en-GB)"}
              style={
                listening
                  ? {
                      color: COLORS.red,
                      borderColor: tint(COLORS.red, 0.5),
                      background: tint(COLORS.red, 0.12),
                    }
                  : undefined
              }
            >
              {listening ? "● Rec" : "🎙"}
            </button>
          )}
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={submit}
            disabled={busy || input.trim().length === 0}
          >
            Send
          </button>
        </div>
        {micError && (
          <p style={{ color: COLORS.red, fontSize: 12 }}>{micError}</p>
        )}
      </div>
    </div>
  );
}

function Bubble({ role, text }: { role: "user" | "assistant"; text: string }) {
  const isUser = role === "user";
  return (
    <div
      style={{
        alignSelf: isUser ? "flex-end" : "flex-start",
        maxWidth: "85%",
        padding: "8px 11px",
        borderRadius: "var(--radius-tile)",
        fontSize: 13,
        lineHeight: 1.5,
        background: isUser ? tint(COLORS.blue, 0.14) : "var(--bg-well)",
        color: "var(--text)",
      }}
    >
      {text}
    </div>
  );
}
