import { describe, expect, it } from "vitest";
import {
  DEFAULT_TOLERANCE_S,
  computeSignature,
  parseSignatureHeader,
  signBody,
  verifySignature,
} from "../src/signing";

const SECRET = "azn_sk_test_0123456789abcdef";
const BODY = JSON.stringify({ type: "booking.created", data: { service: "Checkup" } });
const NOW = 1_750_000_000;

describe("ingest signing (spec §6.2)", () => {
  it("round-trips: sign → verify", () => {
    const header = signBody(SECRET, BODY, NOW);
    expect(verifySignature(SECRET, BODY, header, { nowS: NOW })).toEqual({
      ok: true,
      timestamp: NOW,
    });
  });

  it("produces the documented header format", () => {
    const header = signBody(SECRET, BODY, NOW);
    expect(header).toBe(`t=${NOW},v1=${computeSignature(SECRET, NOW, BODY)}`);
    expect(parseSignatureHeader(header)).toEqual({
      timestamp: NOW,
      signature: computeSignature(SECRET, NOW, BODY),
    });
  });

  it("rejects a tampered body", () => {
    const header = signBody(SECRET, BODY, NOW);
    const verdict = verifySignature(SECRET, BODY.replace("Checkup", "Filling"), header, {
      nowS: NOW,
    });
    expect(verdict).toEqual({ ok: false, reason: "mismatch" });
  });

  it("rejects the wrong secret", () => {
    const header = signBody("azn_sk_other", BODY, NOW);
    expect(verifySignature(SECRET, BODY, header, { nowS: NOW })).toEqual({
      ok: false,
      reason: "mismatch",
    });
  });

  it("rejects timestamps outside the ±5 min window (replay protection)", () => {
    const past = signBody(SECRET, BODY, NOW - DEFAULT_TOLERANCE_S - 1);
    const future = signBody(SECRET, BODY, NOW + DEFAULT_TOLERANCE_S + 1);
    expect(verifySignature(SECRET, BODY, past, { nowS: NOW })).toEqual({
      ok: false,
      reason: "stale",
    });
    expect(verifySignature(SECRET, BODY, future, { nowS: NOW })).toEqual({
      ok: false,
      reason: "stale",
    });
  });

  it("accepts timestamps just inside the window", () => {
    const edge = signBody(SECRET, BODY, NOW - DEFAULT_TOLERANCE_S);
    expect(verifySignature(SECRET, BODY, edge, { nowS: NOW }).ok).toBe(true);
  });

  it("rejects malformed headers without throwing", () => {
    for (const bad of [
      undefined,
      null,
      "",
      "v1=abc",
      "t=notanum,v1=deadbeef",
      `t=${NOW}`,
      `t=${NOW},v1=nothex`,
      `t=${NOW},v1=${"a".repeat(63)}`,
      "t=-5,v1=" + "a".repeat(64),
    ]) {
      expect(verifySignature(SECRET, BODY, bad as never, { nowS: NOW })).toEqual({
        ok: false,
        reason: "malformed",
      });
    }
  });
});
