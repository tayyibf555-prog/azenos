import type { Actor, KnownEventType, Subject } from "@azen/events";

/** Known taxonomy types get autocomplete; any other string (e.g. `custom.*`) is allowed. */
export type EventType = KnownEventType | (string & {});

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface AzenOSOptions {
  /** Project public key (`azn_pk_...`) — routes the request, safe to expose. */
  key: string;
  /** Project secret (`azn_sk_...`) — signs requests (hmac) or is sent verbatim (token). */
  secret: string;
  /** Ingest origin, default `https://os.azen.ai`. Trailing slashes are stripped. */
  baseUrl?: string;
  /** `hmac` signs every request; `token` sends `X-Azen-Token` instead. Default `hmac`. */
  authMode?: "hmac" | "token";
  /** Retries after the first attempt (so 3 → up to 4 attempts). Default 3. */
  maxRetries?: number;
  /** Per-attempt timeout, enforced with an AbortController. Default 5000. */
  timeoutMs?: number;
  /** Injectable fetch for tests or custom transports. Default `globalThis.fetch`. */
  fetch?: FetchLike;
  /** Fires once per call, with the final failure, after retries are exhausted. */
  onError?: (failure: TrackFailure) => void;
}

export interface TrackOptions {
  data?: Record<string, unknown>;
  subject?: Subject;
  actor?: Actor;
  /** Date or ISO-8601 string. Default: now. */
  occurredAt?: Date | string;
  /** Default: a fresh UUID, generated once and reused across retries. */
  idempotencyKey?: string;
  valuePence?: number;
  minutesSaved?: number;
  /** 3-letter ISO code; the server defaults it to `gbp`. */
  currency?: string;
}

export interface TrackSuccess {
  ok: true;
  accepted: number;
  duplicates: number;
}

export interface TrackFailure {
  ok: false;
  status?: number;
  error: string;
}

export type TrackResult = TrackSuccess | TrackFailure;

export type BatchEvent = TrackOptions & { type: EventType };

export interface ConversationOptions extends Omit<TrackOptions, "data"> {
  conversationId?: string;
  channel: "voice" | "webchat" | "whatsapp" | "sms" | "email";
  turns?: number;
  durationSeconds?: number;
  intent?: string;
  resolution: "resolved" | "escalated" | "abandoned";
  summary?: string;
  topics?: string[];
  sentiment?: "positive" | "neutral" | "negative";
  transcriptRef?: string;
}

export interface HeartbeatOptions {
  agentId: string;
  name?: string;
  version?: string;
  purpose?: string;
  status?: "ok" | "degraded" | "down";
}

export type MetricOptions = Omit<TrackOptions, "data">;

/** Event as sent over the wire — the @azen/events envelope shape (spec §7). */
export interface WireEvent {
  type: string;
  occurred_at: string;
  idempotency_key: string;
  actor?: Actor;
  subject?: Subject;
  data: Record<string, unknown>;
  value_pence?: number;
  currency?: string;
  minutes_saved?: number;
}
