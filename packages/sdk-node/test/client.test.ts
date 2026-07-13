import { afterEach, describe, expect, it, vi } from "vitest";
import { parseEvent } from "@azen/events";
import { verifySignature } from "@azen/events/signing";
import { AzenOS } from "../src/index";
import type { BatchEvent, FetchLike, WireEvent } from "../src/index";

const KEY = "azn_pk_test_sdk";
const SECRET = "azn_sk_test_sdk_secret";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function ok(accepted = 1, duplicates = 0): Response {
  return jsonResponse(200, { accepted, duplicates, rejected: [] });
}

interface RecordedRequest {
  url: string;
  init: RequestInit;
  body: string;
  headers: Headers;
}

function recordingFetch(respond: (attempt: number) => Response | Error) {
  const requests: RecordedRequest[] = [];
  const impl: FetchLike = (url, init) => {
    requests.push({
      url,
      init,
      body: String(init.body),
      headers: new Headers(init.headers),
    });
    const result = respond(requests.length - 1);
    return result instanceof Error
      ? Promise.reject(result)
      : Promise.resolve(result);
  };
  return { fetch: vi.fn(impl), requests };
}

function req(requests: RecordedRequest[], index: number): RecordedRequest {
  const r = requests[index];
  if (!r) throw new Error(`no request recorded at index ${index}`);
  return r;
}

function eventOf(r: RecordedRequest): WireEvent {
  const parsed: unknown = JSON.parse(r.body);
  return parsed as WireEvent;
}

function eventsOf(r: RecordedRequest): WireEvent[] {
  const parsed: unknown = JSON.parse(r.body);
  if (!Array.isArray(parsed)) throw new Error("body is not a JSON array");
  return parsed as WireEvent[];
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("request shape & auth", () => {
  it("POSTs one signed event to <baseUrl>/api/ingest/<key> and returns the server counts", async () => {
    const { fetch, requests } = recordingFetch(() =>
      jsonResponse(200, { accepted: 1, duplicates: 2, rejected: [] }),
    );
    const os = new AzenOS({ key: KEY, secret: SECRET, fetch });

    const result = await os.track("booking.created", {
      subject: { kind: "customer", id: "cus_123", name: "Jane D" },
      actor: { kind: "ai_agent", id: "receptionist-v2", name: "AI Receptionist" },
      data: { service: "Checkup", starts_at: "2026-07-14T10:00:00Z", channel: "voice" },
      valuePence: 8500,
      minutesSaved: 12,
      idempotencyKey: "call_789:booking",
    });

    expect(result).toEqual({ ok: true, accepted: 1, duplicates: 2 });
    expect(requests).toHaveLength(1);
    const r = req(requests, 0);
    expect(r.url).toBe(`https://os.azen.ai/api/ingest/${KEY}`);
    expect(r.init.method).toBe("POST");
    expect(r.headers.get("content-type")).toBe("application/json");
    expect(r.headers.get("user-agent")).toBe("azen-os-sdk/0.1.0");

    const event = eventOf(r);
    expect(event).toMatchObject({
      type: "booking.created",
      idempotency_key: "call_789:booking",
      value_pence: 8500,
      minutes_saved: 12,
      subject: { kind: "customer", id: "cus_123", name: "Jane D" },
      actor: { kind: "ai_agent", id: "receptionist-v2", name: "AI Receptionist" },
      data: { service: "Checkup", starts_at: "2026-07-14T10:00:00Z", channel: "voice" },
    });
    // the wire shape passes the server's own validator
    expect(parseEvent(event).ok).toBe(true);
  });

  it("signs each request so the canonical @azen/events verifier accepts it (anti-drift)", async () => {
    const { fetch, requests } = recordingFetch(() => ok());
    const os = new AzenOS({ key: KEY, secret: SECRET, fetch });
    await os.track("custom.ping", { data: { n: 1 } });

    const r = req(requests, 0);
    const header = r.headers.get("x-azen-signature");
    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(verifySignature(SECRET, r.body, header)).toMatchObject({ ok: true });
    expect(verifySignature("wrong_secret", r.body, header).ok).toBe(false);
  });

  it("token mode sends X-Azen-Token instead of a signature", async () => {
    const { fetch, requests } = recordingFetch(() => ok());
    const os = new AzenOS({ key: KEY, secret: SECRET, authMode: "token", fetch });
    await os.track("custom.ping");

    const r = req(requests, 0);
    expect(r.headers.get("x-azen-token")).toBe(SECRET);
    expect(r.headers.get("x-azen-signature")).toBeNull();
  });

  it("strips trailing slashes from baseUrl", async () => {
    const { fetch, requests } = recordingFetch(() => ok());
    const os = new AzenOS({
      key: KEY,
      secret: SECRET,
      baseUrl: "http://localhost:3000/",
      fetch,
    });
    await os.track("custom.ping");
    expect(req(requests, 0).url).toBe(`http://localhost:3000/api/ingest/${KEY}`);
  });

  it("occurredAt accepts a Date, an ISO string, and defaults to now", async () => {
    const { fetch, requests } = recordingFetch(() => ok());
    const os = new AzenOS({ key: KEY, secret: SECRET, fetch });

    await os.track("custom.ping", { occurredAt: new Date("2026-07-01T10:00:00.000Z") });
    await os.track("custom.ping", { occurredAt: "2026-07-01T11:00:00+01:00" });
    const before = Date.now();
    await os.track("custom.ping");
    const after = Date.now();

    expect(eventOf(req(requests, 0)).occurred_at).toBe("2026-07-01T10:00:00.000Z");
    expect(eventOf(req(requests, 1)).occurred_at).toBe("2026-07-01T11:00:00+01:00");
    const defaulted = Date.parse(eventOf(req(requests, 2)).occurred_at);
    expect(defaulted).toBeGreaterThanOrEqual(before);
    expect(defaulted).toBeLessThanOrEqual(after);
  });

  it("tolerates a 2xx response with an unparseable body", async () => {
    const fetch: FetchLike = () =>
      Promise.resolve(new Response("not json", { status: 200 }));
    const os = new AzenOS({ key: KEY, secret: SECRET, fetch });
    await expect(os.track("custom.ping")).resolves.toEqual({
      ok: true,
      accepted: 0,
      duplicates: 0,
    });
  });
});

describe("sugar methods", () => {
  it("metric() sends custom.metric with data {key, value}", async () => {
    const { fetch, requests } = recordingFetch(() => ok());
    const os = new AzenOS({ key: KEY, secret: SECRET, fetch });
    await os.metric("chairs_filled", 7, { subject: { kind: "location", id: "loc_1" } });

    const event = eventOf(req(requests, 0));
    expect(event.type).toBe("custom.metric");
    expect(event.data).toEqual({ key: "chairs_filled", value: 7 });
    expect(event.subject).toEqual({ kind: "location", id: "loc_1" });
    expect(parseEvent(event).ok).toBe(true);
  });

  it("heartbeat() sends agent.heartbeat with snake_case data", async () => {
    const { fetch, requests } = recordingFetch(() => ok());
    const os = new AzenOS({ key: KEY, secret: SECRET, fetch });
    await os.heartbeat({
      agentId: "receptionist-v2",
      name: "AI Receptionist",
      version: "2.1.0",
      purpose: "books appointments",
      status: "ok",
    });

    const event = eventOf(req(requests, 0));
    expect(event.type).toBe("agent.heartbeat");
    expect(event.data).toEqual({
      agent_id: "receptionist-v2",
      name: "AI Receptionist",
      version: "2.1.0",
      purpose: "books appointments",
      status: "ok",
    });
    expect(parseEvent(event).ok).toBe(true);
  });

  it("heartbeat() with only agentId omits the absent optional fields", async () => {
    const { fetch, requests } = recordingFetch(() => ok());
    const os = new AzenOS({ key: KEY, secret: SECRET, fetch });
    await os.heartbeat({ agentId: "a1" });
    expect(eventOf(req(requests, 0)).data).toEqual({ agent_id: "a1" });
  });

  it("conversation() sends llm.conversation with mapped data + envelope extras", async () => {
    const { fetch, requests } = recordingFetch(() => ok());
    const os = new AzenOS({ key: KEY, secret: SECRET, fetch });
    await os.conversation({
      conversationId: "conv_42",
      channel: "voice",
      turns: 6,
      durationSeconds: 190,
      intent: "book_appointment",
      resolution: "resolved",
      summary: "Booked a checkup for Tuesday",
      topics: ["booking", "pricing"],
      sentiment: "positive",
      transcriptRef: "s3://transcripts/conv_42",
      subject: { kind: "customer", name: "Jane D" },
      minutesSaved: 9,
      idempotencyKey: "conv_42:summary",
    });

    const event = eventOf(req(requests, 0));
    expect(event.type).toBe("llm.conversation");
    expect(event.idempotency_key).toBe("conv_42:summary");
    expect(event.minutes_saved).toBe(9);
    expect(event.subject).toEqual({ kind: "customer", name: "Jane D" });
    expect(event.data).toEqual({
      conversation_id: "conv_42",
      channel: "voice",
      turns: 6,
      duration_seconds: 190,
      intent: "book_appointment",
      resolution: "resolved",
      summary: "Booked a checkup for Tuesday",
      topics: ["booking", "pricing"],
      sentiment: "positive",
      transcript_ref: "s3://transcripts/conv_42",
    });
    expect(parseEvent(event).ok).toBe(true);
  });

  it("flush() resolves (no-op today)", async () => {
    const { fetch } = recordingFetch(() => ok());
    const os = new AzenOS({ key: KEY, secret: SECRET, fetch });
    await expect(os.flush()).resolves.toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("retries & backoff", () => {
  it("retries 5xx with 250ms·2^n backoff plus full jitter, then succeeds", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const { fetch } = recordingFetch((attempt) =>
      attempt < 2 ? jsonResponse(500, { error: "db_down" }) : ok(1, 0),
    );
    const os = new AzenOS({ key: KEY, secret: SECRET, fetch });
    const pending = os.track("custom.ping");

    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(1);

    // retry 1: 250·2^0 + 0.5·250 = 375ms
    await vi.advanceTimersByTimeAsync(374);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(2);

    // retry 2: 250·2^1 + 0.5·500 = 750ms
    await vi.advanceTimersByTimeAsync(749);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(3);

    await expect(pending).resolves.toEqual({ ok: true, accepted: 1, duplicates: 0 });
  });

  it("respects Retry-After (seconds) on 429", async () => {
    vi.useFakeTimers();
    const { fetch } = recordingFetch((attempt) =>
      attempt === 0
        ? jsonResponse(429, { error: "rate_limited" }, { "retry-after": "7" })
        : ok(),
    );
    const os = new AzenOS({ key: KEY, secret: SECRET, fetch });
    const pending = os.track("custom.ping");

    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(6999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(2);

    await expect(pending).resolves.toEqual({ ok: true, accepted: 1, duplicates: 0 });
  });

  it("falls back to exponential backoff on 429 without Retry-After", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { fetch } = recordingFetch((attempt) =>
      attempt === 0 ? jsonResponse(429, { error: "rate_limited" }) : ok(),
    );
    const os = new AzenOS({ key: KEY, secret: SECRET, fetch });
    const pending = os.track("custom.ping");

    await vi.advanceTimersByTimeAsync(249);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    await expect(pending).resolves.toMatchObject({ ok: true });
  });

  it("does not retry 4xx (except 429) and fires onError once", async () => {
    const onError = vi.fn();
    const { fetch } = recordingFetch(() => jsonResponse(400, { error: "invalid_json" }));
    const os = new AzenOS({ key: KEY, secret: SECRET, fetch, onError });

    const result = await os.track("custom.ping");
    expect(result).toEqual({ ok: false, status: 400, error: "invalid_json" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(result);
  });

  it("retries network errors and fires onError once after the final failure", async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const { fetch } = recordingFetch(() => new Error("socket hang up"));
    const os = new AzenOS({ key: KEY, secret: SECRET, maxRetries: 2, fetch, onError });

    const pending = os.track("custom.ping");
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(fetch).toHaveBeenCalledTimes(3); // 1 attempt + 2 retries
    expect(result).toEqual({ ok: false, error: "socket hang up" });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(result);
  });

  it("defaults to 3 retries (4 attempts) and returns the last failure", async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const { fetch } = recordingFetch(() => jsonResponse(503, { error: "unavailable" }));
    const os = new AzenOS({ key: KEY, secret: SECRET, fetch, onError });

    const pending = os.track("custom.ping");
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(fetch).toHaveBeenCalledTimes(4);
    expect(result).toEqual({ ok: false, status: 503, error: "unavailable" });
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("generates the idempotency key once — stable across retries of the same call", async () => {
    vi.useFakeTimers();
    const { fetch, requests } = recordingFetch((attempt) =>
      attempt === 0 ? jsonResponse(500, { error: "boom" }) : ok(),
    );
    const os = new AzenOS({ key: KEY, secret: SECRET, fetch });

    const pending = os.track("custom.ping", { data: { n: 1 } });
    await vi.runAllTimersAsync();
    await pending;

    expect(requests).toHaveLength(2);
    const first = eventOf(req(requests, 0)).idempotency_key;
    expect(first).toMatch(UUID_RE);
    expect(eventOf(req(requests, 1)).idempotency_key).toBe(first);
    // the whole retried body is byte-identical
    expect(req(requests, 1).body).toBe(req(requests, 0).body);
  });

  it("generates a fresh idempotency key per track call", async () => {
    const { fetch, requests } = recordingFetch(() => ok());
    const os = new AzenOS({ key: KEY, secret: SECRET, fetch });
    await os.track("custom.ping");
    await os.track("custom.ping");
    const a = eventOf(req(requests, 0)).idempotency_key;
    const b = eventOf(req(requests, 1)).idempotency_key;
    expect(a).toMatch(UUID_RE);
    expect(b).toMatch(UUID_RE);
    expect(b).not.toBe(a);
  });
});

describe("trackBatch", () => {
  it("sends ONE POST whose body is a signed JSON array", async () => {
    const { fetch, requests } = recordingFetch(() =>
      jsonResponse(200, { accepted: 2, duplicates: 1, rejected: [] }),
    );
    const os = new AzenOS({ key: KEY, secret: SECRET, fetch });

    const result = await os.trackBatch([
      { type: "lead.created", data: { name: "Sam" }, idempotencyKey: "lead:1" },
      { type: "custom.metric", data: { key: "x", value: 1 } },
      { type: "booking.created", data: { starts_at: "2026-07-14T10:00:00Z" } },
    ]);

    expect(result).toEqual({ ok: true, accepted: 2, duplicates: 1 });
    expect(fetch).toHaveBeenCalledTimes(1);

    const r = req(requests, 0);
    const events = eventsOf(r);
    expect(events.map((e) => e.type)).toEqual([
      "lead.created",
      "custom.metric",
      "booking.created",
    ]);
    expect(new Set(events.map((e) => e.idempotency_key)).size).toBe(3);
    for (const event of events) expect(parseEvent(event).ok).toBe(true);
    expect(
      verifySignature(SECRET, r.body, r.headers.get("x-azen-signature")).ok,
    ).toBe(true);
  });

  it("accepts exactly 100 events", async () => {
    const { fetch, requests } = recordingFetch(() =>
      jsonResponse(200, { accepted: 100, duplicates: 0, rejected: [] }),
    );
    const os = new AzenOS({ key: KEY, secret: SECRET, fetch });
    const events: BatchEvent[] = Array.from({ length: 100 }, (_, i) => ({
      type: "custom.metric",
      data: { key: "i", value: i },
    }));

    const result = await os.trackBatch(events);
    expect(result).toEqual({ ok: true, accepted: 100, duplicates: 0 });
    expect(eventsOf(req(requests, 0))).toHaveLength(100);
  });

  it("rejects 101 events locally without any fetch call", async () => {
    const onError = vi.fn();
    const { fetch } = recordingFetch(() => ok());
    const os = new AzenOS({ key: KEY, secret: SECRET, fetch, onError });
    const events: BatchEvent[] = Array.from({ length: 101 }, () => ({
      type: "custom.ping",
    }));

    const result = await os.trackBatch(events);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a failure");
    expect(result.error).toContain("101");
    expect(result.status).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(result);
  });
});

describe("timeouts & never-throws", () => {
  it("aborts a hung request via AbortController after timeoutMs, then retries", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const impl: FetchLike = (_url, init) => {
      attempts += 1;
      if (attempts === 1) {
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" }));
          });
        });
      }
      return Promise.resolve(ok());
    };
    const fetch = vi.fn(impl);
    const os = new AzenOS({ key: KEY, secret: SECRET, timeoutMs: 1000, fetch });

    const pending = os.track("custom.ping");
    await vi.advanceTimersByTimeAsync(999);
    expect(fetch).toHaveBeenCalledTimes(1); // still hung, not yet aborted
    await vi.runAllTimersAsync(); // abort at 1000ms, back off, retry
    await expect(pending).resolves.toEqual({ ok: true, accepted: 1, duplicates: 0 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("reports a timeout failure when retries are exhausted", async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const impl: FetchLike = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" }));
        });
      });
    const os = new AzenOS({
      key: KEY,
      secret: SECRET,
      timeoutMs: 750,
      maxRetries: 0,
      fetch: vi.fn(impl),
      onError,
    });

    const pending = os.track("custom.ping");
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(result).toEqual({ ok: false, error: "timed out after 750ms" });
    expect(onError).toHaveBeenCalledWith(result);
  });

  it("track never throws — even when fetch itself throws synchronously", async () => {
    const impl: FetchLike = () => {
      throw new Error("fetch is broken");
    };
    const os = new AzenOS({ key: KEY, secret: SECRET, maxRetries: 0, fetch: impl });
    await expect(os.track("custom.ping")).resolves.toEqual({
      ok: false,
      error: "fetch is broken",
    });
  });

  it("swallows a throwing onError callback", async () => {
    const { fetch } = recordingFetch(() => jsonResponse(400, { error: "bad" }));
    const os = new AzenOS({
      key: KEY,
      secret: SECRET,
      fetch,
      onError: () => {
        throw new Error("callback bug");
      },
    });
    await expect(os.track("custom.ping")).resolves.toEqual({
      ok: false,
      status: 400,
      error: "bad",
    });
  });
});
