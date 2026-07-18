import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The route only auth-gates on the org — any resolvable org will do.
vi.mock("../../lib/server/org", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/server/org")>();
  return {
    ...actual,
    requireOrgId: async () => "00000000-0000-0000-0000-000000000001",
  };
});

import { POST as transcribePOST } from "../../app/api/transcribe/route";

interface ErrorEnvelope {
  error: string;
}

const fetchMock = vi.fn();
const ORIGINAL_KEY = process.env.OPENAI_API_KEY;
const ORIGINAL_MODEL = process.env.AZEN_TRANSCRIBE_MODEL;

beforeEach(() => {
  fetchMock.mockReset();
  // No live OpenAI calls: the route's fetch is stubbed for every test.
  vi.stubGlobal("fetch", fetchMock);
  process.env.OPENAI_API_KEY = "sk-test-key";
  // Default model (gpt-4o-transcribe) unless a test overrides it explicitly.
  delete process.env.AZEN_TRANSCRIBE_MODEL;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = ORIGINAL_KEY;
  if (ORIGINAL_MODEL === undefined) delete process.env.AZEN_TRANSCRIBE_MODEL;
  else process.env.AZEN_TRANSCRIBE_MODEL = ORIGINAL_MODEL;
});

function audioBlob(bytes = 2048, type = "audio/webm"): Blob {
  return new Blob([new Uint8Array(bytes)], { type });
}

function transcribeReq(audio?: Blob, field = "audio"): Request {
  const form = new FormData();
  if (audio) form.append(field, audio, "clip.webm");
  return new Request("http://test.local/api/transcribe", {
    method: "POST",
    body: form,
  });
}

function openaiOk(text: string): Response {
  return new Response(JSON.stringify({ text }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("POST /api/transcribe", () => {
  it("proxies the audio to gpt-4o-transcribe and returns the text", async () => {
    fetchMock.mockResolvedValueOnce(openaiOk("book a follow-up call"));
    const res = await transcribePOST(transcribeReq(audioBlob()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: "book a follow-up call" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer sk-test-key",
    );
    const body = init.body as FormData;
    expect(body.get("model")).toBe("gpt-4o-transcribe");
    expect(body.get("language")).toBe("en");
    expect(body.get("response_format")).toBe("json");
    expect(body.get("prompt")).toContain("Azen");
    expect(body.get("file")).toBeInstanceOf(Blob);
  });

  it("honours the AZEN_TRANSCRIBE_MODEL override", async () => {
    process.env.AZEN_TRANSCRIBE_MODEL = "whisper-1";
    fetchMock.mockResolvedValueOnce(openaiOk("noted"));
    const res = await transcribePOST(transcribeReq(audioBlob()));
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = (fetchMock.mock.calls[0] as [string, RequestInit])[1]
      .body as FormData;
    expect(body.get("model")).toBe("whisper-1");
  });

  it("falls back to whisper-1 when the primary model is unavailable", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              message:
                "The model `gpt-4o-transcribe` does not exist or you do not have access to it.",
              type: "invalid_request_error",
              code: "model_not_found",
            },
          }),
          { status: 404, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(openaiOk("show me this month's revenue"));

    const res = await transcribePOST(transcribeReq(audioBlob()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: "show me this month's revenue" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstBody = (fetchMock.mock.calls[0] as [string, RequestInit])[1]
      .body as FormData;
    const secondBody = (fetchMock.mock.calls[1] as [string, RequestInit])[1]
      .body as FormData;
    expect(firstBody.get("model")).toBe("gpt-4o-transcribe");
    expect(secondBody.get("model")).toBe("whisper-1");
  });

  it("retries the fallback only once, then 502s transcribe_failed", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { code: "model_not_found" } }), {
          status: 404,
        }),
      )
      .mockResolvedValueOnce(new Response("still broken", { status: 500 }));

    const res = await transcribePOST(transcribeReq(audioBlob()));
    expect(res.status).toBe(502);
    expect(((await res.json()) as ErrorEnvelope).error).toBe("transcribe_failed");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not fall back on an auth failure", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("invalid api key", { status: 401 }),
    );
    const res = await transcribePOST(transcribeReq(audioBlob()));
    expect(res.status).toBe(502);
    expect(((await res.json()) as ErrorEnvelope).error).toBe("openai_auth");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("502s openai_auth without calling OpenAI when the key is unset", async () => {
    process.env.OPENAI_API_KEY = "";
    const res = await transcribePOST(transcribeReq(audioBlob()));
    expect(res.status).toBe(502);
    expect(((await res.json()) as ErrorEnvelope).error).toBe("openai_auth");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps an OpenAI 401 to 502 openai_auth", async () => {
    fetchMock.mockResolvedValueOnce(new Response("invalid api key", { status: 401 }));
    const res = await transcribePOST(transcribeReq(audioBlob()));
    expect(res.status).toBe(502);
    expect(((await res.json()) as ErrorEnvelope).error).toBe("openai_auth");
  });

  it("maps other OpenAI failures to 502 transcribe_failed", async () => {
    fetchMock.mockResolvedValueOnce(new Response("server exploded", { status: 500 }));
    const res = await transcribePOST(transcribeReq(audioBlob()));
    expect(res.status).toBe(502);
    expect(((await res.json()) as ErrorEnvelope).error).toBe("transcribe_failed");
  });

  it("maps a network failure to 502 transcribe_failed", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    const res = await transcribePOST(transcribeReq(audioBlob()));
    expect(res.status).toBe(502);
    expect(((await res.json()) as ErrorEnvelope).error).toBe("transcribe_failed");
  });

  it("400s when the audio part is missing", async () => {
    const res = await transcribePOST(transcribeReq(undefined));
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("413s an upload over 15MB", async () => {
    const res = await transcribePOST(transcribeReq(audioBlob(15 * 1024 * 1024 + 1)));
    expect(res.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("400s an unsupported container type", async () => {
    const res = await transcribePOST(transcribeReq(audioBlob(1024, "audio/flac")));
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
