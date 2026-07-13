import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Canonical ingest signing scheme (spec §6.2) — the single implementation
 * the server verifies with and simulate signs with. The published SDK
 * re-implements it to stay zero-dependency; its test suite cross-verifies
 * against this module so the formats can never drift.
 *
 *   X-Azen-Signature: t=<unix_seconds>,v1=HMAC-SHA256(secret, `${t}.${rawBody}`)
 *
 * Node-only (node:crypto): import via "@azen/events/signing", never from the
 * package root — the root must stay portable for client bundles.
 */

export const SIGNATURE_HEADER = "x-azen-signature";
/** Fallback auth for no-code callers that can't sign (§6.3 step 1). */
export const TOKEN_HEADER = "x-azen-token";
export const SIGNING_VERSION = "v1";
/** ±5 minutes replay window (§6.3). */
export const DEFAULT_TOLERANCE_S = 300;

export function computeSignature(
  secret: string,
  timestamp: number,
  rawBody: string,
): string {
  return createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");
}

/** Full header value for a request: `t=<ts>,v1=<hex>`. */
export function signBody(
  secret: string,
  rawBody: string,
  timestamp: number = Math.floor(Date.now() / 1000),
): string {
  return `t=${timestamp},${SIGNING_VERSION}=${computeSignature(secret, timestamp, rawBody)}`;
}

export type VerifyResult =
  | { ok: true; timestamp: number }
  | { ok: false; reason: "malformed" | "stale" | "mismatch" };

export function parseSignatureHeader(
  header: string,
): { timestamp: number; signature: string } | null {
  const parts = new Map(
    header.split(",").map((p) => {
      const i = p.indexOf("=");
      return [p.slice(0, i).trim(), p.slice(i + 1).trim()] as const;
    }),
  );
  const t = Number(parts.get("t"));
  const signature = parts.get(SIGNING_VERSION);
  if (!Number.isInteger(t) || t <= 0 || !signature || !/^[0-9a-f]{64}$/.test(signature)) {
    return null;
  }
  return { timestamp: t, signature };
}

export function verifySignature(
  secret: string,
  rawBody: string,
  header: string | null | undefined,
  opts: { toleranceS?: number; nowS?: number } = {},
): VerifyResult {
  if (!header) return { ok: false, reason: "malformed" };
  const parsed = parseSignatureHeader(header);
  if (!parsed) return { ok: false, reason: "malformed" };

  const now = opts.nowS ?? Math.floor(Date.now() / 1000);
  const tolerance = opts.toleranceS ?? DEFAULT_TOLERANCE_S;
  if (Math.abs(now - parsed.timestamp) > tolerance) {
    return { ok: false, reason: "stale" };
  }

  const expected = computeSignature(secret, parsed.timestamp, rawBody);
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(parsed.signature, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "mismatch" };
  }
  return { ok: true, timestamp: parsed.timestamp };
}
