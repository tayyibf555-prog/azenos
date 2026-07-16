import {
  db,
  events,
  mirrorBookingEvents,
  webhookDeliveries,
  type MirrorableEventRow,
} from "@azen/db";
import {
  normalizeEventType,
  parseEvent,
  type NormalizedEvent,
  type ParseEventResult,
} from "@azen/events";
import { NextResponse } from "next/server";
import { jsonError } from "../http";
import { authenticate, lookupKey } from "./auth";
import { checkRateLimit } from "./rate-limit";
import { scheduleIngestReactions } from "./react";

/**
 * §6.3 ingest pipeline, steps 1–11 in contract order. Steps 5–10 live in
 * processIngestBody so delivery replays can re-run them without the
 * size/auth/rate gates. Budget <300ms: one key select, one events insert,
 * one counter upsert, one delivery insert; mirror only on booking.* inserts.
 */

export const MAX_BODY_BYTES = 262_144;
export const MAX_BATCH_EVENTS = 100;

export interface IngestContext {
  keyId: string;
  orgId: string;
  projectId: string;
  clientId: string;
  projectName: string;
  source: "sdk";
}

// Every ingest event is sourced as "sdk" regardless of auth mode: HMAC callers
// sign, token-mode no-code callers send a header, but both land on the same
// project webhook and share the one ingest source bucket.
export function sourceForAuthMode(_authMode: "hmac" | "token"): "sdk" {
  return "sdk";
}

interface RejectedEvent {
  index: number;
  reason: string;
}

export async function handleIngestRequest(
  req: Request,
  publicKey: string,
): Promise<NextResponse> {
  const startedAt = performance.now();

  // 1. size cap — declared header first (skip reading oversize bodies), then
  // the actual bytes. No delivery row: the key isn't loaded yet by design.
  const declared = Number(req.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    console.error(`[ingest] ${publicKey}: declared payload ${declared}B > cap`);
    return jsonError(413, "payload_too_large");
  }
  const raw = await req.text();
  if (Buffer.byteLength(raw) > MAX_BODY_BYTES) {
    console.error(`[ingest] ${publicKey}: payload ${Buffer.byteLength(raw)}B > cap`);
    return jsonError(413, "payload_too_large");
  }

  // 2. key lookup — unknown/revoked keys get no delivery row (org unknowable)
  const key = await lookupKey(publicKey);
  if (!key) {
    console.error(`[ingest] unknown or revoked public key ${publicKey}`);
    return jsonError(401, "unauthorized");
  }
  // Phase 7 §B least privilege: feedback keys are browser-embeddable and may
  // ONLY create feedback.submitted via /api/feedback/[publicKey]. Reject them
  // here with the same generic 401 as an unknown key (never reveal the reason).
  if (key.kind !== "ingest") {
    console.error(`[ingest] ${publicKey}: rejected non-ingest key kind=${key.kind}`);
    return jsonError(401, "unauthorized");
  }
  const ctx: IngestContext = {
    keyId: key.keyId,
    orgId: key.orgId,
    projectId: key.projectId,
    clientId: key.clientId,
    projectName: key.projectName,
    source: sourceForAuthMode(key.authMode),
  };

  // 3. auth — generic 401 body; the real reason goes to the delivery log (§15)
  const auth = authenticate(key, raw, req.headers);
  if (!auth.ok) {
    await recordDelivery({
      ctx,
      status: "rejected",
      httpStatus: 401,
      startedAt,
      error: auth.reason,
      raw: jsonSafeRaw(raw),
    });
    return jsonError(401, "unauthorized");
  }

  // 4. rate limit — raw NOT kept on rate-limited rejections
  const rate = await checkRateLimit(key.keyId, key.rateLimitPer10s);
  if (rate.limited) {
    await recordDelivery({
      ctx,
      status: "rejected",
      httpStatus: 429,
      startedAt,
      error: "rate_limited",
    });
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "retry-after": String(rate.retryAfterS) } },
    );
  }

  // 5a. parse — unparseable bodies are dead-lettered (raw kept)
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    await recordDelivery({
      ctx,
      status: "rejected",
      httpStatus: 400,
      startedAt,
      error: "invalid_json",
      raw,
    });
    return jsonError(400, "invalid_json");
  }

  return processIngestBody({
    body,
    ctx,
    startedAt,
    rawForRejected: body ?? raw,
    usedPostgresRateLimit: rate.usedPostgres,
  });
}

export interface ProcessIngestOptions {
  /** Parsed JSON value: single event, bare array, or {events:[...]}. */
  body: unknown;
  ctx: IngestContext;
  startedAt: number;
  /** Stored on the delivery row when the outcome is `rejected`. */
  rawForRejected: unknown;
  usedPostgresRateLimit: boolean;
  /** Replay: forces the delivery row's error to "replay of <id>". */
  errorOverride?: string;
}

/** Steps 5b–10 — shared by the live endpoint and delivery replay. */
export async function processIngestBody(
  opts: ProcessIngestOptions,
): Promise<NextResponse> {
  const { body, ctx, startedAt, errorOverride } = opts;

  const items = extractEvents(body);
  if (items === null) {
    await recordDelivery({
      ctx,
      status: "rejected",
      httpStatus: 400,
      startedAt,
      error: errorOverride ?? "invalid_json",
      raw: opts.rawForRejected,
    });
    return jsonError(400, "invalid_json");
  }
  if (items.length > MAX_BATCH_EVENTS) {
    await recordDelivery({
      ctx,
      status: "rejected",
      httpStatus: 400,
      startedAt,
      error: errorOverride ?? "batch_too_large",
      raw: opts.rawForRejected,
    });
    return jsonError(400, "batch_too_large");
  }

  // 6. validate/normalize — unknown types were remapped to custom.* above
  // parseEvent, so only hard envelope/data failures land in rejected[]
  interface Candidate {
    index: number;
    original: unknown;
    event: NormalizedEvent;
  }
  const candidates: Candidate[] = [];
  const rejected: RejectedEvent[] = [];
  items.forEach((item, index) => {
    const parsed = parseEvent(withNormalizedType(item));
    if (parsed.ok) candidates.push({ index, original: item, event: parsed.event });
    else rejected.push({ index, reason: terseReason(parsed) });
  });

  // 7. store — one multi-row insert, deduped by events_dedup_uq
  // (org_id, project_id, idempotency_key). Duplicates = attempted − returned.
  const returned =
    candidates.length > 0
      ? await db
          .insert(events)
          .values(
            candidates.map((c) => ({
              orgId: ctx.orgId,
              projectId: ctx.projectId,
              type: c.event.type,
              source: ctx.source,
              idempotencyKey: c.event.idempotency_key,
              occurredAt: new Date(c.event.occurred_at),
              actor: c.event.actor ?? null,
              subject: c.event.subject ?? null,
              data: c.event.data,
              valuePence: c.event.value_pence ?? null,
              currency: c.event.currency,
              minutesSaved: c.event.minutes_saved ?? null,
              raw: c.original,
            })),
          )
          .onConflictDoNothing({
            target: [events.orgId, events.projectId, events.idempotencyKey],
          })
          .returning({
            id: events.id,
            idempotencyKey: events.idempotencyKey,
            type: events.type,
          })
      : [];

  const returnedByKey = new Map(returned.map((r) => [r.idempotencyKey, r]));
  const insertedRows: MirrorableEventRow[] = [];
  for (const c of candidates) {
    const row = returnedByKey.get(c.event.idempotency_key);
    if (!row) continue; // duplicate (pre-existing or repeated in this batch)
    returnedByKey.delete(c.event.idempotency_key);
    insertedRows.push({
      id: row.id,
      orgId: ctx.orgId,
      projectId: ctx.projectId,
      clientId: ctx.clientId,
      type: c.event.type,
      idempotencyKey: c.event.idempotency_key,
      subject: c.event.subject ?? null,
      data: c.event.data,
      raw: c.original,
    });
  }
  const accepted = returned.length;
  const duplicates = candidates.length - accepted;

  // 8. mirror — best-effort like everything after the atomic events insert
  if (insertedRows.some((r) => r.type.startsWith("booking."))) {
    try {
      await mirrorBookingEvents(db, insertedRows);
    } catch (err) {
      console.error("[ingest] booking mirror failed:", err);
    }
  }

  // 9. delivery log — one row per request
  const status =
    accepted > 0 ? "accepted" : duplicates > 0 ? "duplicate" : "rejected";
  const rejectedSummary =
    rejected.length > 0
      ? `${rejected.length} rejected: ${rejected
          .map((r) => `[${r.index}] ${r.reason}`)
          .join("; ")}`
      : items.length === 0
        ? "empty batch"
        : null;
  await recordDelivery({
    ctx,
    status,
    httpStatus: 200,
    startedAt,
    error: errorOverride ?? rejectedSummary,
    eventId: insertedRows[0]?.id ?? null,
    raw: opts.rawForRejected,
  });

  // 10. react after the response; 11. respond
  scheduleIngestReactions({
    keyId: ctx.keyId,
    orgId: ctx.orgId,
    projectId: ctx.projectId,
    projectName: ctx.projectName,
    insertedRows: insertedRows.map((r) => ({ id: r.id, type: r.type })),
    usedPostgresRateLimit: opts.usedPostgresRateLimit,
  });
  return NextResponse.json({ accepted, duplicates, rejected });
}

function extractEvents(body: unknown): unknown[] | null {
  if (Array.isArray(body)) return body;
  if (body !== null && typeof body === "object") {
    const nested = (body as { events?: unknown }).events;
    if (Array.isArray(nested)) return nested;
    if (nested === undefined) return [body];
    return null; // an object claiming {events: ...} with a non-array payload
  }
  return null;
}

function withNormalizedType(item: unknown): unknown {
  if (item !== null && typeof item === "object" && !Array.isArray(item)) {
    const type = (item as { type?: unknown }).type;
    if (typeof type === "string") {
      return {
        ...(item as Record<string, unknown>),
        type: normalizeEventType(type).type,
      };
    }
  }
  return item;
}

function terseReason(parsed: Extract<ParseEventResult, { ok: false }>): string {
  const issue = parsed.issues?.[0];
  if (!issue) return truncate(parsed.error, 160);
  const path = issue.path.join(".");
  return truncate(path ? `${path}: ${issue.message}` : issue.message, 160);
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function jsonSafeRaw(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

interface DeliveryRecord {
  ctx: IngestContext;
  status: "accepted" | "duplicate" | "rejected";
  httpStatus: number;
  startedAt: number;
  error?: string | null;
  eventId?: string | null;
  /** Persisted only when status is `rejected` (dead-letter for replay). */
  raw?: unknown;
}

/** Best-effort: a logging failure must never fail the request itself. */
async function recordDelivery(record: DeliveryRecord): Promise<void> {
  try {
    await db.insert(webhookDeliveries).values({
      orgId: record.ctx.orgId,
      projectKeyId: record.ctx.keyId,
      status: record.status,
      httpStatus: record.httpStatus,
      latencyMs: Math.max(0, Math.round(performance.now() - record.startedAt)),
      error: record.error ? truncate(record.error, 500) : null,
      eventId: record.eventId ?? null,
      raw: record.status === "rejected" ? (record.raw ?? null) : null,
    });
  } catch (err) {
    console.error("[ingest] delivery log write failed:", err);
  }
}
