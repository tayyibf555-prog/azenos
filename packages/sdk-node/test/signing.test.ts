import { describe, expect, it } from "vitest";
import {
  parseSignatureHeader,
  signBody as canonicalSignBody,
  verifySignature,
} from "@azen/events/signing";
import { computeSignature, signBody } from "../src/signing";

const SECRET = "azn_sk_test_4f6f8e2d";
const BODY = JSON.stringify({
  type: "booking.created",
  occurred_at: "2026-07-12T09:30:00Z",
  idempotency_key: "call_789:booking",
  data: { service: "Checkup", starts_at: "2026-07-14T10:00:00Z" },
});

describe("SDK signing vs @azen/events/signing (anti-drift)", () => {
  it("produces a byte-identical header for the same secret/timestamp/body", () => {
    const ts = 1_780_000_000;
    expect(signBody(SECRET, BODY, ts)).toBe(canonicalSignBody(SECRET, BODY, ts));
  });

  it("is accepted by the canonical verifySignature", () => {
    const ts = 1_780_000_000;
    const header = signBody(SECRET, BODY, ts);
    expect(verifySignature(SECRET, BODY, header, { nowS: ts })).toEqual({
      ok: true,
      timestamp: ts,
    });
  });

  it("survives multi-byte payloads", () => {
    const body = JSON.stringify({ note: "Zoë booked ✅ £85" });
    const ts = 1_780_000_123;
    expect(signBody(SECRET, body, ts)).toBe(canonicalSignBody(SECRET, body, ts));
    expect(
      verifySignature(SECRET, body, signBody(SECRET, body, ts), { nowS: ts }).ok,
    ).toBe(true);
  });

  it("defaults the timestamp to now (unix seconds)", () => {
    const before = Math.floor(Date.now() / 1000);
    const parsed = parseSignatureHeader(signBody(SECRET, BODY));
    const after = Math.floor(Date.now() / 1000);
    if (parsed === null) throw new Error("header did not parse");
    expect(parsed.timestamp).toBeGreaterThanOrEqual(before);
    expect(parsed.timestamp).toBeLessThanOrEqual(after);
    expect(parsed.signature).toBe(
      computeSignature(SECRET, parsed.timestamp, BODY),
    );
  });

  it("does not verify a tampered body", () => {
    const ts = 1_780_000_000;
    const header = signBody(SECRET, BODY, ts);
    expect(verifySignature(SECRET, `${BODY} `, header, { nowS: ts })).toEqual({
      ok: false,
      reason: "mismatch",
    });
  });
});
