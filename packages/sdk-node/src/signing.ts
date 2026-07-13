import { createHmac } from "node:crypto";

/**
 * HMAC request signing — spec §6.2:
 *
 *   X-Azen-Signature: t=<unix_seconds>,v1=HMAC-SHA256(secret, `${t}.${rawBody}`)
 *
 * Deliberately re-implements @azen/events/signing so the published SDK stays
 * zero-dependency. test/signing.test.ts cross-verifies every signature against
 * the canonical module, so the two formats can never drift.
 */

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
  return `t=${timestamp},v1=${computeSignature(secret, timestamp, rawBody)}`;
}
