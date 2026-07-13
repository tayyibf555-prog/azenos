/**
 * Shared client types for Ask Azen (command-K palette + /ask screen).
 *
 * The chat route + persistence are built by P3B-CHAT concurrently; these types
 * mirror the CONTRACTS.md wire shapes and are read DEFENSIVELY everywhere (every
 * field optional / fallback-guarded) so a minor shape drift degrades to a plain
 * render rather than a crash.
 */

/** Page context injected into a turn. Stored on chat_sessions.context ({project_id}). */
export interface AskContext {
  project_id?: string;
}

/** One tool invocation in the "how I got this" trace (chat's data_snapshot). */
export interface ToolTraceItem {
  name: string;
  input?: unknown;
  ok?: boolean;
  /** Compact result preview — string OR structured (series / rows / object). */
  resultSummary?: unknown;
}

export type ChatRole = "user" | "assistant";

export interface ChatMessage {
  /** Client-local id (stable for React keys). */
  id: string;
  role: ChatRole;
  content: string;
  trace: ToolTraceItem[];
  streaming: boolean;
  /** Inline, user-facing error for this turn (never a raw provider error). */
  error?: string | null;
}

/** Session summary from GET /api/ask/sessions. */
export interface SessionSummary {
  id: string;
  title: string | null;
  createdAt?: string | null;
  messageCount?: number | null;
}

/* ── SSE loop events (P3B-CHAT relays loop.ts events as `data:` JSON frames) ── */

export interface TextEvent {
  type: "text";
  delta: string;
}
export interface ToolEvent {
  type: "tool";
  name: string;
  input?: unknown;
}
export interface ToolResultEvent {
  type: "tool_result";
  name: string;
  ok: boolean;
  resultSummary?: unknown;
}
export interface DoneEvent {
  type: "done";
  usage?: unknown;
  sessionId?: string;
}
export interface ErrorEvent {
  type: "error";
  error?: string;
  message?: string;
}
/** Best-effort session announcement (some builders emit it up front). */
export interface MetaEvent {
  type: "session" | "meta";
  sessionId?: string;
  id?: string;
}

export type AskStreamEvent =
  | TextEvent
  | ToolEvent
  | ToolResultEvent
  | DoneEvent
  | ErrorEvent
  | MetaEvent;
