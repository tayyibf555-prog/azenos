import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Webhook signature verifiers for the org-level agency Stripe + Calendly
 * accounts (Phase 4, docs/phase4/CONTRACTS.md §P4-HOOKS). Mirrors the ingest
 * signing scheme in @azen/events/signing: a `t=<unix>,v1=<hex>` header whose
 * v1 value is HMAC-SHA256(secret, `${t}.${rawBody}`), within a ±5 minute
 * replay window, compared in constant time. Node-only (node:crypto) — import
 * from server code only.
 *
 * Stripe's real `Stripe-Signature` header uses exactly this `t=…,v1=…` scheme
 * (signed payload = `${t}.${rawBody}`); Calendly's `Calendly-Webhook-
 * Signature` header does too. So one core covers both — only the secret and
 * the header name differ.
 */

export const STRIPE_SIGNATURE_HEADER = "stripe-signature";
export const CALENDLY_SIGNATURE_HEADER = "calendly-webhook-signature";
export const HOOK_SIGNING_VERSION = "v1";
/** ±5 minutes replay window (§6.3 / §P4-HOOKS). */
export const HOOK_TOLERANCE_S = 300;

export type HookVerifyResult =
  | { ok: true; timestamp: number }
  | { ok: false; reason: "missing_secret" | "malformed" | "stale" | "mismatch" };

interface ParsedSignature {
  timestamp: number;
  /** All v1 signatures present (Stripe may send several during key rotation). */
  signatures: string[];
}

/**
 * Parse a `t=<unix>,v1=<hex>[,v1=<hex>…]` signature header. Tolerates the
 * `v0=`/scheme fields Stripe interleaves and multiple `v1` values.
 */
export function parseHookSignatureHeader(
  header: string,
): ParsedSignature | null {
  let timestamp = Number.NaN;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    const key = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (key === "t") timestamp = Number(value);
    else if (key === HOOK_SIGNING_VERSION && /^[0-9a-f]{64}$/.test(value)) {
      signatures.push(value);
    }
  }
  if (!Number.isInteger(timestamp) || timestamp <= 0 || signatures.length === 0) {
    return null;
  }
  return { timestamp, signatures };
}

function verifyHookSignature(
  secret: string | undefined | null,
  rawBody: string,
  header: string | null | undefined,
  opts: { toleranceS?: number; nowS?: number } = {},
): HookVerifyResult {
  if (!secret) return { ok: false, reason: "missing_secret" };
  if (!header) return { ok: false, reason: "malformed" };
  const parsed = parseHookSignatureHeader(header);
  if (!parsed) return { ok: false, reason: "malformed" };

  const now = opts.nowS ?? Math.floor(Date.now() / 1000);
  const tolerance = opts.toleranceS ?? HOOK_TOLERANCE_S;
  if (Math.abs(now - parsed.timestamp) > tolerance) {
    return { ok: false, reason: "stale" };
  }

  const expected = createHmac("sha256", secret)
    .update(`${parsed.timestamp}.${rawBody}`)
    .digest();
  const matched = parsed.signatures.some((candidate) => {
    const given = Buffer.from(candidate, "hex");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  return matched
    ? { ok: true, timestamp: parsed.timestamp }
    : { ok: false, reason: "mismatch" };
}

/** Verify an agency-account `Stripe-Signature` header. */
export function verifyStripeSignature(
  secret: string | undefined | null,
  rawBody: string,
  header: string | null | undefined,
  opts: { toleranceS?: number; nowS?: number } = {},
): HookVerifyResult {
  return verifyHookSignature(secret, rawBody, header, opts);
}

/** Verify an agency-account `Calendly-Webhook-Signature` header. */
export function verifyCalendlySignature(
  secret: string | undefined | null,
  rawBody: string,
  header: string | null | undefined,
  opts: { toleranceS?: number; nowS?: number } = {},
): HookVerifyResult {
  return verifyHookSignature(secret, rawBody, header, opts);
}

/**
 * Sign a raw body the way the agency provider would — used by the local
 * simulators (packages/db/src/seed/simulate-money.ts) and the hook tests so
 * both exercise the real verifier without a live account.
 */
export function signHookBody(
  secret: string,
  rawBody: string,
  timestamp: number = Math.floor(Date.now() / 1000),
): string {
  const sig = createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");
  return `t=${timestamp},${HOOK_SIGNING_VERSION}=${sig}`;
}
