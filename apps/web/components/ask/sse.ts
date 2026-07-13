import type { AskContext, AskStreamEvent } from "./types";

/**
 * Minimal SSE-over-fetch client for POST /api/ask.
 *
 * The route streams Server-Sent Events: newline-delimited frames, each carrying
 * one `data: <json>` line whose JSON is a loop event (`text` / `tool` /
 * `tool_result` / `done` / `error`). We POST (so a request body can be sent —
 * EventSource is GET-only), read the response body as a stream, reassemble
 * frames across chunk boundaries, and hand each parsed event to `onEvent`.
 *
 * Defensive by construction: unparseable frames are skipped, a non-OK HTTP
 * status surfaces as a synthetic error event, and an aborted stream resolves
 * quietly. Never throws to the caller.
 */

export interface StreamHandlers {
  onEvent: (event: AskStreamEvent) => void;
  /** Fired once with the response so callers can read headers (e.g. session id). */
  onResponse?: (res: Response) => void;
}

export interface AskRequestBody {
  message: string;
  sessionId?: string;
  context?: AskContext;
}

const SESSION_HEADER = "x-session-id";

/** Pull a session id off a header if the route advertises one that way. */
function sessionFromHeaders(res: Response): string | undefined {
  const v = res.headers.get(SESSION_HEADER);
  return v && v.length > 0 ? v : undefined;
}

function parseFrame(frame: string): AskStreamEvent | null {
  // A frame may contain comment lines (`:`), an `event:` line, and one or more
  // `data:` lines. Per the SSE spec the `event:` line carries the discriminant;
  // the route sends its terminal `done`/`error`/budget-halt frames with the type
  // ONLY on that line (the data payload omits `type`). We must therefore read the
  // event line and fall back to it — ignoring it silently dropped those frames,
  // breaking session-id capture, the missing-key banner, and budget messages.
  const dataLines: string[] = [];
  let eventName: string | undefined;
  for (const rawLine of frame.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
    else if (line.startsWith("event:")) eventName = line.slice(6).replace(/^ /, "").trim();
  }
  if (dataLines.length === 0) return null;
  const payload = dataLines.join("\n").trim();
  if (payload === "" || payload === "[DONE]") return null;
  try {
    const obj = JSON.parse(payload) as unknown;
    if (!obj || typeof obj !== "object") return null;
    const rec = obj as Record<string, unknown>;
    // Data payload carries its own type → trust it (text/tool/tool_result are
    // relayed as `send(ev.type, ev)`, so ev.type is embedded). Otherwise adopt
    // the SSE event-line name as the discriminant.
    if (typeof rec.type === "string") return rec as unknown as AskStreamEvent;
    if (eventName) return { ...rec, type: eventName } as unknown as AskStreamEvent;
    return null;
  } catch {
    return null;
  }
}

export async function streamAsk(
  body: AskRequestBody,
  handlers: StreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch("/api/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (signal?.aborted) return;
    handlers.onEvent({
      type: "error",
      error: err instanceof Error ? err.message : "network error",
    });
    return;
  }

  handlers.onResponse?.(res);
  const headerSession = sessionFromHeaders(res);
  if (headerSession) handlers.onEvent({ type: "meta", sessionId: headerSession });

  if (!res.ok || !res.body) {
    handlers.onEvent({
      type: "error",
      error: `request failed (${res.status})`,
    });
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Frames are separated by a blank line. Handle both \n\n and \r\n\r\n.
      let sep = findFrameSeparator(buffer);
      while (sep) {
        const frame = buffer.slice(0, sep.index);
        buffer = buffer.slice(sep.index + sep.length);
        const event = parseFrame(frame);
        if (event) handlers.onEvent(event);
        sep = findFrameSeparator(buffer);
      }
    }
    // Flush any trailing frame that never got a blank-line terminator.
    const tail = parseFrame(buffer);
    if (tail) handlers.onEvent(tail);
  } catch (err) {
    if (signal?.aborted) return;
    handlers.onEvent({
      type: "error",
      error: err instanceof Error ? err.message : "stream error",
    });
  } finally {
    reader.releaseLock();
  }
}

function findFrameSeparator(
  buffer: string,
): { index: number; length: number } | null {
  const a = buffer.indexOf("\n\n");
  const b = buffer.indexOf("\r\n\r\n");
  if (a === -1 && b === -1) return null;
  if (a === -1) return { index: b, length: 4 };
  if (b === -1) return { index: a, length: 2 };
  return a < b ? { index: a, length: 2 } : { index: b, length: 4 };
}
