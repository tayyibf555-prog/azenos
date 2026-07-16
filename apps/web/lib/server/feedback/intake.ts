import { createHash } from "node:crypto";
import { db, events, feedbackItems, projectKeys } from "@azen/db";
import { dataSchemaFor } from "@azen/events";
import { and, eq, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { checkFeedbackRateLimit } from "./rate-limit";

/**
 * Phase 7 §B — the PUBLIC, least-privilege feedback webhook. A browser-embedded
 * widget (or a raw curl) POSTs one feedback.submitted here. Contract order:
 *   size cap → key lookup (feedback-kind, not revoked) → dual rate limit →
 *   JSON parse → honeypot → Zod → events insert + feedback_items mirror (one
 *   transaction). Every response is generic {ok:true} / {error} — org and
 *   project ids are NEVER leaked, and the widget is embedded cross-origin so
 *   POST/OPTIONS carry permissive CORS.
 */

export const MAX_FEEDBACK_BYTES = 8_192;

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
};

function ok(): NextResponse {
  return NextResponse.json({ ok: true }, { status: 200, headers: CORS_HEADERS });
}

function fail(status: number, error: string, extra?: Record<string, string>) {
  return NextResponse.json(
    { error },
    { status, headers: { ...CORS_HEADERS, ...extra } },
  );
}

export function feedbackOptions(): NextResponse {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

interface FeedbackKey {
  keyId: string;
  orgId: string;
  projectId: string;
}

/** Unknown, revoked, or non-feedback keys are all indistinguishable (401). */
async function lookupFeedbackKey(publicKey: string): Promise<FeedbackKey | null> {
  const [row] = await db
    .select({
      keyId: projectKeys.id,
      orgId: projectKeys.orgId,
      projectId: projectKeys.projectId,
      kind: projectKeys.kind,
    })
    .from(projectKeys)
    .where(
      and(eq(projectKeys.publicKey, publicKey), isNull(projectKeys.revokedAt)),
    )
    .limit(1);
  if (!row || row.kind !== "feedback") return null;
  return { keyId: row.keyId, orgId: row.orgId, projectId: row.projectId };
}

/**
 * The rate-limit source IP. `X-Forwarded-For` is a client-writable header: the
 * LEFTMOST token is fully attacker-controlled, so trusting it (as `split(",")[0]`
 * did) lets one host mint a fresh per-IP bucket per request and defeat the 10/min
 * per-IP cap entirely. We trust XFF ONLY when we know how many reverse proxies we
 * sit behind: `TRUSTED_PROXY_HOPS=N` means the real client IP is the token N
 * positions from the RIGHT (the value written by our outermost trusted proxy),
 * and any leftmost tokens the client spoofed are ignored. Unset/0 ⇒ XFF is not
 * trusted at all and we fall back to `x-real-ip` (set by the proxy) or "unknown".
 */
function clientIp(headers: Headers): string {
  const hops = Number(process.env.TRUSTED_PROXY_HOPS ?? Number.NaN);
  if (Number.isFinite(hops) && hops > 0) {
    const fwd = headers.get("x-forwarded-for");
    if (fwd) {
      const parts = fwd
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s !== "");
      const idx = parts.length - hops;
      if (idx >= 0 && parts[idx]) return parts[idx]!;
    }
  }
  return headers.get("x-real-ip")?.trim() || "unknown";
}

/**
 * Read the request body while enforcing a hard byte ceiling as bytes arrive.
 * `req.text()` would buffer the ENTIRE stream into memory before any size check,
 * so a chunked / absent-Content-Length request (the header fast-path can't catch
 * it) could stream hundreds of MB pre-auth. We instead pull chunks and abort the
 * instant the running total exceeds `max`, returning null (→ 413).
 */
async function readCappedBody(req: Request, max: number): Promise<string | null> {
  const stream = req.body;
  if (!stream) {
    const text = await req.text();
    return Buffer.byteLength(text) > max ? null : text;
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > max) {
          await reader.cancel();
          return null;
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
}

interface FeedbackData {
  kind: "bug" | "feature" | "question" | "praise" | "other";
  message: string;
  severity?: 1 | 2 | 3;
  submitter?: { name?: string; email?: string };
  page_url?: string;
}

export async function handleFeedbackRequest(
  req: Request,
  publicKey: string,
): Promise<NextResponse> {
  // 1. size cap — declared header is a fast reject, but it only reflects what
  // the CLIENT claims; a chunked / absent-Content-Length body skips it. The real
  // ceiling is enforced by readCappedBody, which aborts the stream mid-flight.
  const declared = Number(req.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > MAX_FEEDBACK_BYTES) {
    return fail(413, "payload_too_large");
  }
  const raw = await readCappedBody(req, MAX_FEEDBACK_BYTES);
  if (raw === null) {
    return fail(413, "payload_too_large");
  }

  // 2. key lookup — feedback-kind + not revoked; else a generic 401
  const key = await lookupFeedbackKey(publicKey);
  if (!key) return fail(401, "unauthorized");

  // 3. dual rate limit — 30/min per key AND 10/min per IP
  const ip = clientIp(req.headers);
  const rate = await checkFeedbackRateLimit(key.keyId, ip);
  if (rate.limited) {
    return fail(429, "rate_limited", { "retry-after": String(rate.retryAfterS) });
  }

  // 4. parse JSON — malformed bodies are a 400
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return fail(400, "invalid_json");
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return fail(400, "invalid_body");
  }
  const record = body as Record<string, unknown>;

  // 5. honeypot — a filled "website" means a bot; ACK 200 but write NOTHING. A
  // human leaves the hidden field empty (omitted, null, or ""); ANYTHING else —
  // a non-empty string OR any non-string value (number/bool/object/array a bot
  // might stuff in) — trips the trap.
  const honeypot = record.website;
  const honeypotEmpty =
    honeypot === undefined ||
    honeypot === null ||
    (typeof honeypot === "string" && honeypot.trim() === "");
  if (!honeypotEmpty) {
    return ok();
  }

  // 6. Zod validate the feedback payload (strict — strips honeypot & extras)
  const schema = dataSchemaFor("feedback.submitted");
  if (!schema) return fail(500, "internal_error");
  const parsed = schema.safeParse(record);
  if (!parsed.success) return fail(400, "invalid_feedback");
  const data = parsed.data as FeedbackData;

  // 7. events insert + feedback_items mirror in ONE transaction. Idempotency
  // key = sha256(publicKey + ip + message + minute-bucket): a genuine double-
  // submit (same user double-clicking) dedups to one event, but TWO DIFFERENT
  // submitters who happen to type the same short/templated text ("test",
  // "Great app!") in the same minute are NOT silently collapsed — the per-IP
  // discriminator keeps their feedback distinct.
  const minuteBucket = Math.floor(Date.now() / 60_000);
  const idempotencyKey = createHash("sha256")
    .update(`${publicKey}:${ip}:${data.message}:${minuteBucket}`)
    .digest("hex");
  const now = new Date();

  try {
    await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(events)
        .values({
          orgId: key.orgId,
          projectId: key.projectId,
          type: "feedback.submitted",
          source: "feedback",
          idempotencyKey,
          occurredAt: now,
          actor: data.submitter?.name
            ? { kind: "human", name: data.submitter.name }
            : { kind: "human" },
          subject: null,
          data: data as unknown as Record<string, unknown>,
          currency: "gbp",
          raw: data,
        })
        .onConflictDoNothing({
          target: [events.orgId, events.projectId, events.idempotencyKey],
        })
        .returning({ id: events.id });

      // Duplicate within the minute bucket: the event already exists (and was
      // already mirrored) — ACK without a second mirror row.
      const eventId = inserted[0]?.id;
      if (!eventId) return;

      await tx.insert(feedbackItems).values({
        orgId: key.orgId,
        projectId: key.projectId,
        eventId,
        kind: data.kind,
        message: data.message,
        severity: data.severity ?? null,
        submitterName: data.submitter?.name ?? null,
        submitterEmail: data.submitter?.email ?? null,
        pageUrl: data.page_url ?? null,
        status: "new",
        // Pin the mirror's created_at to the event's occurredAt (not the DB
        // now() default) so both tables attribute this item to the SAME London
        // day even for a submission that lands microseconds before midnight —
        // matching the seed's `createdAt: r.occurredAt` invariant.
        createdAt: now,
      });
    });
  } catch (err) {
    console.error("[feedback] write failed:", err);
    return fail(500, "internal_error");
  }

  return ok();
}
