import { afterEach, describe, expect, it, vi } from "vitest";
import {
  extForMime,
  formatElapsed,
  mediaRecorderSupported,
  pickRecorderMime,
  requestMicStream,
  transcribeBlob,
} from "../../lib/useDictation";

/**
 * useDictation is a React hook (useState/useRef/useEffect throughout), and
 * this repo has neither jsdom nor @testing-library/react-hooks installed
 * (checked: no *.test.tsx file, no renderHook usage anywhere in the repo) —
 * adding either would violate the "no new deps" ground rule. So the hook's
 * actual decision logic — the three paths the brief calls out (transcribe
 * success, no-key 502, mic-permission-denied) — is implemented as small,
 * framework-free functions the hook calls internally, exported here so they
 * can be exercised directly with a mocked fetch/getUserMedia and no DOM.
 * See test/dictation/mic.test.ts for the presentational side (what the
 * palette/composer actually render for each state).
 */

function audioBlob(bytes = 64, type = "audio/webm"): Blob {
  return new Blob([new Uint8Array(bytes)], { type });
}

describe("transcribeBlob", () => {
  it("posts the clip to /api/transcribe and returns the transcribed text (success path)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ text: "book a follow-up call" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const outcome = await transcribeBlob(audioBlob(), fetchMock as unknown as typeof fetch);
    expect(outcome).toEqual({ kind: "text", text: "book a follow-up call" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/transcribe");
    expect(init.method).toBe("POST");
    const body = init.body as FormData;
    expect(body.get("audio")).toBeInstanceOf(Blob);
  });

  it("trims whitespace-only transcripts down to empty rather than appending nothing useful", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ text: "   " }), { status: 200 }));
    const outcome = await transcribeBlob(audioBlob(), fetchMock as unknown as typeof fetch);
    expect(outcome).toEqual({ kind: "empty" });
  });

  it("classifies a 502 {error: openai_auth} as auth-missing — the no-OPENAI_API_KEY path", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ error: "openai_auth" }), { status: 502 }));
    const outcome = await transcribeBlob(audioBlob(), fetchMock as unknown as typeof fetch);
    expect(outcome).toEqual({ kind: "auth-missing" });
  });

  it("classifies any other non-OK response as failed, not auth-missing", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "transcribe_failed" }), { status: 502 }),
    );
    const outcome = await transcribeBlob(audioBlob(), fetchMock as unknown as typeof fetch);
    expect(outcome).toEqual({ kind: "failed" });
  });

  it("classifies a network error as failed and never throws", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    await expect(transcribeBlob(audioBlob(), fetchMock as unknown as typeof fetch)).resolves.toEqual(
      { kind: "failed" },
    );
  });
});

describe("requestMicStream", () => {
  it("resolves ok with the stream once the browser grants permission", async () => {
    const fakeStream = { getTracks: () => [] } as unknown as MediaStream;
    const getUserMedia = vi.fn().mockResolvedValue(fakeStream);
    const outcome = await requestMicStream({ getUserMedia } as unknown as MediaDevices);
    expect(outcome).toEqual({ ok: true, stream: fakeStream });
  });

  it("surfaces a calm permission-denied outcome when getUserMedia rejects", async () => {
    const getUserMedia = vi
      .fn()
      .mockRejectedValue(new DOMException("Permission denied", "NotAllowedError"));
    const outcome = await requestMicStream({ getUserMedia } as unknown as MediaDevices);
    expect(outcome).toEqual({ ok: false, reason: "permission-denied" });
  });

  it("is permission-denied (not a throw) when there's no mediaDevices at all", async () => {
    await expect(requestMicStream(undefined)).resolves.toEqual({
      ok: false,
      reason: "permission-denied",
    });
  });
});

describe("feature detection + formatting helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("mediaRecorderSupported is false in a plain Node environment (no window)", () => {
    expect(mediaRecorderSupported()).toBe(false);
  });

  it("mediaRecorderSupported is true once MediaRecorder + getUserMedia exist", () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("MediaRecorder", class {} as unknown as typeof MediaRecorder);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: () => undefined } });
    expect(mediaRecorderSupported()).toBe(true);
  });

  it("pickRecorderMime picks the first candidate MediaRecorder reports as supported", () => {
    vi.stubGlobal(
      "MediaRecorder",
      { isTypeSupported: (t: string) => t === "audio/mp4" } as unknown as typeof MediaRecorder,
    );
    expect(pickRecorderMime()).toBe("audio/mp4");
  });

  it("extForMime maps known containers and falls back to webm", () => {
    expect(extForMime("audio/ogg;codecs=opus")).toBe("ogg");
    expect(extForMime("audio/mp4")).toBe("mp4");
    expect(extForMime("audio/wav")).toBe("wav");
    expect(extForMime("audio/webm;codecs=opus")).toBe("webm");
    expect(extForMime("")).toBe("webm");
  });

  it("formatElapsed renders m:ss, zero-padded", () => {
    expect(formatElapsed(5)).toBe("0:05");
    expect(formatElapsed(65)).toBe("1:05");
    expect(formatElapsed(90)).toBe("1:30");
  });
});
