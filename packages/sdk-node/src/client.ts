import { randomUUID } from "node:crypto";
import { signBody } from "./signing";
import type {
  AzenOSOptions,
  BatchEvent,
  ConversationOptions,
  EventType,
  FetchLike,
  HeartbeatOptions,
  MetricOptions,
  TrackFailure,
  TrackOptions,
  TrackResult,
  WireEvent,
} from "./types";

const DEFAULT_BASE_URL = "https://os.azen.ai";
const USER_AGENT = "azen-os-sdk/0.1.0";
const BACKOFF_BASE_MS = 250;
const MAX_BATCH_SIZE = 100;

/**
 * Fire-and-forget Azen OS event client — spec §6.2. Every method resolves to
 * a TrackResult and never throws; `onError` fires once after a final failure.
 */
export class AzenOS {
  private readonly url: string;
  private readonly secret: string;
  private readonly authMode: "hmac" | "token";
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;
  private readonly onError: ((failure: TrackFailure) => void) | undefined;

  constructor(options: AzenOSOptions) {
    const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.url = `${baseUrl}/api/ingest/${options.key}`;
    this.secret = options.secret;
    this.authMode = options.authMode ?? "hmac";
    this.maxRetries = Math.max(0, Math.floor(options.maxRetries ?? 3));
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.fetchImpl =
      options.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.onError = options.onError;
  }

  async track(
    type: EventType,
    options: TrackOptions = {},
  ): Promise<TrackResult> {
    try {
      return await this.post(JSON.stringify(this.buildEvent(type, options)));
    } catch (error) {
      return this.fail({ ok: false, error: errorMessage(error) });
    }
  }

  /** Single POST with a JSON-array body, hard-capped at 100 events (§6.3 step 5). */
  async trackBatch(events: BatchEvent[]): Promise<TrackResult> {
    try {
      if (events.length > MAX_BATCH_SIZE) {
        return this.fail({
          ok: false,
          error: `batch_too_large: ${events.length} events (max ${MAX_BATCH_SIZE})`,
        });
      }
      if (events.length === 0) return { ok: true, accepted: 0, duplicates: 0 };
      const wire = events.map(({ type, ...options }) =>
        this.buildEvent(type, options),
      );
      return await this.post(JSON.stringify(wire));
    } catch (error) {
      return this.fail({ ok: false, error: errorMessage(error) });
    }
  }

  /** Sugar for `llm.conversation` events. */
  async conversation(options: ConversationOptions): Promise<TrackResult> {
    const {
      conversationId,
      channel,
      turns,
      durationSeconds,
      intent,
      resolution,
      summary,
      topics,
      sentiment,
      transcriptRef,
      ...envelope
    } = options;
    return this.track("llm.conversation", {
      ...envelope,
      data: {
        conversation_id: conversationId,
        channel,
        turns,
        duration_seconds: durationSeconds,
        intent,
        resolution,
        summary,
        topics,
        sentiment,
        transcript_ref: transcriptRef,
      },
    });
  }

  /** Sugar for `agent.heartbeat` events. */
  async heartbeat(options: HeartbeatOptions): Promise<TrackResult> {
    return this.track("agent.heartbeat", {
      data: {
        agent_id: options.agentId,
        name: options.name,
        version: options.version,
        purpose: options.purpose,
        status: options.status,
      },
    });
  }

  /** Sugar for arbitrary gauges: `custom.metric` with data `{key, value}`. */
  async metric(
    key: string,
    value: number,
    options: MetricOptions = {},
  ): Promise<TrackResult> {
    return this.track("custom.metric", { ...options, data: { key, value } });
  }

  /** No-op today; exists so callers can already `await os.flush()` (API stability). */
  async flush(): Promise<void> {}

  private buildEvent(type: EventType, options: TrackOptions): WireEvent {
    return {
      type,
      occurred_at: toIsoString(options.occurredAt),
      // Pre-generated once per call (never per attempt) so the server's
      // idempotency dedup collapses retries into a single stored event.
      idempotency_key: options.idempotencyKey ?? randomUUID(),
      actor: options.actor,
      subject: options.subject,
      data: options.data ?? {},
      value_pence: options.valuePence,
      currency: options.currency,
      minutes_saved: options.minutesSaved,
    };
  }

  private async post(rawBody: string): Promise<TrackResult> {
    let failure: TrackFailure = { ok: false, error: "no attempt made" };
    let retryAfterMs: number | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        const base = BACKOFF_BASE_MS * 2 ** (attempt - 1);
        await sleep(retryAfterMs ?? base + Math.random() * base);
      }
      retryAfterMs = undefined;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let response: Response;
      try {
        response = await this.fetchImpl(this.url, {
          method: "POST",
          headers: this.headersFor(rawBody),
          body: rawBody,
          signal: controller.signal,
        });
      } catch (error) {
        failure = {
          ok: false,
          error: isAbortError(error)
            ? `timed out after ${this.timeoutMs}ms`
            : errorMessage(error),
        };
        continue;
      } finally {
        clearTimeout(timer);
      }

      if (response.ok) return parseSuccess(response);

      failure = {
        ok: false,
        status: response.status,
        error: await errorFrom(response),
      };
      if (response.status !== 429 && response.status < 500) {
        return this.fail(failure);
      }
      if (response.status === 429) retryAfterMs = retryAfterToMs(response);
    }

    return this.fail(failure);
  }

  private headersFor(rawBody: string): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "user-agent": USER_AGENT,
    };
    if (this.authMode === "token") {
      headers["x-azen-token"] = this.secret;
    } else {
      // Signed per attempt: a long retry tail must not push the timestamp
      // outside the server's ±300s replay window.
      headers["x-azen-signature"] = signBody(this.secret, rawBody);
    }
    return headers;
  }

  private fail(failure: TrackFailure): TrackFailure {
    try {
      this.onError?.(failure);
    } catch {
      // track() never throws — a throwing onError callback must not escape.
    }
    return failure;
  }
}

function toIsoString(value: Date | string | undefined): string {
  if (value === undefined) return new Date().toISOString();
  return value instanceof Date ? value.toISOString() : value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function parseSuccess(response: Response): Promise<TrackResult> {
  const body: unknown = await response.json().catch(() => undefined);
  return {
    ok: true,
    accepted: numberField(body, "accepted"),
    duplicates: numberField(body, "duplicates"),
  };
}

function numberField(body: unknown, key: string): number {
  if (body === null || typeof body !== "object") return 0;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

async function errorFrom(response: Response): Promise<string> {
  const body: unknown = await response.json().catch(() => undefined);
  if (body !== null && typeof body === "object") {
    const error = (body as Record<string, unknown>)["error"];
    if (typeof error === "string" && error.length > 0) return error;
  }
  return `HTTP ${response.status}`;
}

function retryAfterToMs(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  if (header === null) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

function isAbortError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "name" in error &&
    error.name === "AbortError"
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}
