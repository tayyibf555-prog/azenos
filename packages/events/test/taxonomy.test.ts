import { describe, expect, it } from "vitest";
import {
  EVENT_TYPES,
  exampleCustomEvent,
  exampleEvents,
  isCustomEventType,
  normalizeEventType,
  parseEvent,
} from "../src/index.js";

describe("taxonomy coverage (spec §7)", () => {
  it("implements all 41 known event types (6 leads + 5 bookings + 9 money + 6 agents + 1 llm + 6 comms + 5 ops + 3 system)", () => {
    expect(EVENT_TYPES.length).toBe(41);
  });

  it("has a validating fixture for every known type", () => {
    for (const type of EVENT_TYPES) {
      const fixture = exampleEvents[type];
      expect(fixture, `missing fixture for ${type}`).toBeDefined();
      const result = parseEvent(fixture);
      expect(
        result.ok,
        `fixture for ${type} failed: ${!result.ok ? JSON.stringify(result.issues ?? result.error) : ""}`,
      ).toBe(true);
    }
  });

  it("accepts custom.* events with free-form data", () => {
    const result = parseEvent(exampleCustomEvent);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event.data).toMatchObject({ points: 50 });
    }
  });

  it("keeps unknown extra keys in data payloads (never drop data)", () => {
    const result = parseEvent({
      ...exampleEvents["booking.created"],
      data: {
        ...(exampleEvents["booking.created"].data as object),
        practice_room: "B2",
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.event.data.practice_room).toBe("B2");
  });
});

describe("envelope validation", () => {
  it("rejects a missing idempotency_key", () => {
    const { idempotency_key: _dropped, ...rest } =
      exampleEvents["lead.created"];
    expect(parseEvent(rest).ok).toBe(false);
  });

  it("rejects a malformed occurred_at", () => {
    const result = parseEvent({
      ...exampleEvents["lead.created"],
      occurred_at: "yesterday",
    });
    expect(result.ok).toBe(false);
  });

  it("accepts offset timestamps (Europe/London summer time)", () => {
    const result = parseEvent({
      ...exampleEvents["lead.created"],
      occurred_at: "2026-07-10T10:15:00+01:00",
    });
    expect(result.ok).toBe(true);
  });

  it("defaults currency to gbp and lowercases it", () => {
    const noCurrency = parseEvent(exampleEvents["payment.captured"]);
    expect(noCurrency.ok && noCurrency.event.currency).toBe("gbp");
    const upper = parseEvent({
      ...exampleEvents["payment.captured"],
      currency: "EUR",
    });
    expect(upper.ok && upper.event.currency).toBe("eur");
  });

  it("rejects negative minutes_saved", () => {
    const result = parseEvent({
      ...exampleEvents["booking.created"],
      minutes_saved: -5,
    });
    expect(result.ok).toBe(false);
  });
});

describe("per-type data rules", () => {
  it("rejects booking.created without starts_at", () => {
    const result = parseEvent({
      ...exampleEvents["booking.created"],
      data: { service: "Checkup" },
    });
    expect(result.ok).toBe(false);
  });

  it("rejects payment.captured without amount_pence", () => {
    const result = parseEvent({
      ...exampleEvents["payment.captured"],
      data: { method: "card" },
    });
    expect(result.ok).toBe(false);
  });

  it("rejects review.received rating outside 1-5", () => {
    const result = parseEvent({
      ...exampleEvents["review.received"],
      data: { rating: 6 },
    });
    expect(result.ok).toBe(false);
  });

  it("rejects llm.conversation with an unknown channel", () => {
    const result = parseEvent({
      ...exampleEvents["llm.conversation"],
      data: {
        ...(exampleEvents["llm.conversation"].data as object),
        channel: "carrier_pigeon",
      },
    });
    expect(result.ok).toBe(false);
  });

  it("caps llm.conversation summary at 500 chars", () => {
    const result = parseEvent({
      ...exampleEvents["llm.conversation"],
      data: {
        ...(exampleEvents["llm.conversation"].data as object),
        summary: "x".repeat(501),
      },
    });
    expect(result.ok).toBe(false);
  });
});

describe("unknown-type policy (spec §6.3 step 4)", () => {
  it("parseEvent rejects unknown non-custom types", () => {
    const result = parseEvent({
      ...exampleEvents["lead.created"],
      type: "totally.made_up",
    });
    expect(result.ok).toBe(false);
  });

  it("normalizeEventType remaps unknown types into custom.* and flags them", () => {
    const { type, wasUnknown } = normalizeEventType("Totally Made Up!!");
    expect(wasUnknown).toBe(true);
    expect(isCustomEventType(type)).toBe(true);
    expect(parseEvent({
      ...exampleEvents["lead.created"],
      type,
    }).ok).toBe(true);
  });

  it("passes known and custom types through untouched", () => {
    expect(normalizeEventType("booking.created")).toEqual({
      type: "booking.created",
      wasUnknown: false,
    });
    expect(normalizeEventType("custom.my_metric")).toEqual({
      type: "custom.my_metric",
      wasUnknown: false,
    });
  });
});
