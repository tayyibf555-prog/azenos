"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { streamAsk } from "./sse";
import type {
  AskContext,
  AskStreamEvent,
  ChatMessage,
  ToolTraceItem,
} from "./types";

/**
 * Conversation state machine shared by the command-K palette and the /ask
 * screen. Owns the message list + the live session id, drives one streaming
 * turn at a time, and hydrates prior sessions from GET /api/ask/sessions/[id].
 *
 * Streaming is additive: text deltas append to the open assistant message, tool
 * events accrete its "how I got this" trace. A per-turn AbortController lets an
 * unmount (palette close / navigation) cancel the fetch cleanly.
 */

let localSeq = 0;
const nextId = (): string => `m${Date.now().toString(36)}_${(localSeq++).toString(36)}`;

/** Missing-key detection → the specific banner copy the contract mandates. */
function isAuthError(msg: string): boolean {
  const l = msg.toLowerCase();
  return l.includes("anthropic_api_key") || l.includes("api key") || l.includes("api_key");
}
const AUTH_COPY = "Ask needs ANTHROPIC_API_KEY — set it in .env";

export interface UseAskChat {
  messages: ChatMessage[];
  sessionId: string | undefined;
  busy: boolean;
  /** True once a turn failed for a missing key — surface the setup banner. */
  needsKey: boolean;
  send: (text: string, context?: AskContext) => void;
  loadSession: (id: string) => Promise<void>;
  reset: () => void;
}

export function useAskChat(initialSessionId?: string): UseAskChat {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sessionId, setSessionId] = useState<string | undefined>(initialSessionId);
  const [busy, setBusy] = useState(false);
  const [needsKey, setNeedsKey] = useState(false);

  // Keep the live session id readable inside async callbacks without re-binding.
  const sessionRef = useRef<string | undefined>(initialSessionId);
  const abortRef = useRef<AbortController | null>(null);
  const busyRef = useRef(false);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  const patchLast = useCallback(
    (fn: (m: ChatMessage) => ChatMessage) => {
      setMessages((prev) => {
        if (prev.length === 0) return prev;
        const last = prev[prev.length - 1];
        if (!last || last.role !== "assistant") return prev;
        return [...prev.slice(0, -1), fn(last)];
      });
    },
    [],
  );

  const send = useCallback(
    (text: string, context?: AskContext) => {
      const message = text.trim();
      if (message === "" || busyRef.current) return;

      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      busyRef.current = true;
      setBusy(true);
      setNeedsKey(false);

      const userMsg: ChatMessage = {
        id: nextId(),
        role: "user",
        content: message,
        trace: [],
        streaming: false,
      };
      const answerMsg: ChatMessage = {
        id: nextId(),
        role: "assistant",
        content: "",
        trace: [],
        streaming: true,
      };
      setMessages((prev) => [...prev, userMsg, answerMsg]);

      const onEvent = (event: AskStreamEvent): void => {
        switch (event.type) {
          case "text":
            if (typeof event.delta === "string") {
              patchLast((m) => ({ ...m, content: m.content + event.delta }));
            }
            break;
          case "tool":
            patchLast((m) => ({
              ...m,
              trace: [...m.trace, { name: event.name, input: event.input }],
            }));
            break;
          case "tool_result":
            patchLast((m) => ({ ...m, trace: markResult(m.trace, event.name, event.ok, event.resultSummary) }));
            break;
          case "meta":
          case "session": {
            const id = event.sessionId ?? (event as { id?: string }).id;
            if (id) {
              sessionRef.current = id;
              setSessionId(id);
            }
            break;
          }
          case "done":
            if (event.sessionId) {
              sessionRef.current = event.sessionId;
              setSessionId(event.sessionId);
            }
            break;
          case "error": {
            const raw = event.error ?? event.message ?? "Something went wrong.";
            const friendly = isAuthError(raw) ? AUTH_COPY : raw;
            if (isAuthError(raw)) setNeedsKey(true);
            patchLast((m) => ({ ...m, error: friendly }));
            break;
          }
          default:
            break;
        }
      };

      void streamAsk(
        { message, sessionId: sessionRef.current, context },
        {
          onEvent,
          onResponse: (res) => {
            const h = res.headers.get("x-session-id");
            if (h) {
              sessionRef.current = h;
              setSessionId(h);
            }
          },
        },
        ac.signal,
      ).finally(() => {
        if (ac.signal.aborted) return;
        busyRef.current = false;
        setBusy(false);
        patchLast((m) => ({
          ...m,
          streaming: false,
          // A turn that produced neither text nor an explicit error still needs
          // to say *something* rather than render a blank bubble.
          content:
            m.content === "" && !m.error && m.trace.length === 0
              ? "_No answer was returned._"
              : m.content,
        }));
      });
    },
    [patchLast],
  );

  const loadSession = useCallback(async (id: string): Promise<void> => {
    // Aborting an in-flight turn makes that turn's streamAsk().finally early-
    // return on `signal.aborted`, so it never clears busy. Clear it here or the
    // composer wedges (Send stays disabled, send() stays guarded) until reset().
    abortRef.current?.abort();
    busyRef.current = false;
    setBusy(false);
    setNeedsKey(false);
    sessionRef.current = id;
    setSessionId(id);
    try {
      const res = await fetch(`/api/ask/sessions/${id}`, { cache: "no-store" });
      if (!res.ok) {
        setMessages([]);
        return;
      }
      const json = (await res.json()) as unknown;
      setMessages(parseSessionMessages(json));
    } catch {
      setMessages([]);
    }
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    busyRef.current = false;
    sessionRef.current = undefined;
    setSessionId(undefined);
    setMessages([]);
    setBusy(false);
    setNeedsKey(false);
  }, []);

  return { messages, sessionId, busy, needsKey, send, loadSession, reset };
}

/** Attach ok/result to the most recent trace item for `name` still awaiting one. */
function markResult(
  trace: ToolTraceItem[],
  name: string,
  ok: boolean,
  resultSummary: unknown,
): ToolTraceItem[] {
  for (let i = trace.length - 1; i >= 0; i--) {
    const item = trace[i];
    if (item && item.name === name && item.ok === undefined) {
      const next = [...trace];
      next[i] = { ...item, ok, ...(resultSummary !== undefined ? { resultSummary } : {}) };
      return next;
    }
  }
  // No matching pending call (e.g. a result without a start marker): append one.
  return [...trace, { name, ok, ...(resultSummary !== undefined ? { resultSummary } : {}) }];
}

/* ── History hydration (defensive against camel/snake drift) ────────────────── */

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function pick(obj: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return undefined;
}

function parseTrace(raw: unknown): ToolTraceItem[] {
  if (!Array.isArray(raw)) return [];
  const out: ToolTraceItem[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const o = entry as Record<string, unknown>;
    const name = asString(pick(o, "name", "tool", "toolName"));
    if (!name) continue;
    const okRaw = pick(o, "ok", "success");
    out.push({
      name,
      input: pick(o, "input", "args"),
      ok: typeof okRaw === "boolean" ? okRaw : undefined,
      resultSummary: pick(o, "resultSummary", "result_summary", "result", "data"),
    });
  }
  return out;
}

export function parseSessionMessages(json: unknown): ChatMessage[] {
  const container = (json ?? {}) as Record<string, unknown>;
  const rawList = Array.isArray(json)
    ? json
    : Array.isArray(container.messages)
      ? (container.messages as unknown[])
      : [];
  const out: ChatMessage[] = [];
  for (const entry of rawList) {
    if (!entry || typeof entry !== "object") continue;
    const o = entry as Record<string, unknown>;
    const role = asString(pick(o, "role")) === "user" ? "user" : "assistant";
    const content = asString(pick(o, "contentMd", "content_md", "content")) ?? "";
    out.push({
      id: asString(pick(o, "id")) ?? nextId(),
      role,
      content,
      trace: parseTrace(pick(o, "toolCalls", "tool_calls", "trace")),
      streaming: false,
    });
  }
  return out;
}
