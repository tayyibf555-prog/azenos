import { NextResponse } from "next/server";
import { jsonError, withErrorHandling } from "../../../lib/server/http";
import { requireOrgId } from "../../../lib/server/org";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Dictation proxy (phase2 CONTRACTS addendum §A): multipart `audio`
 * (webm/ogg/mp4/wav, ≤15MB, ~90s capped client-side) → OpenAI transcription
 * via plain fetch + FormData — deliberately NO SDK dependency. Returns `{text}`.
 *
 * Model is `gpt-4o-transcribe` by default (lower error rate than whisper-1 on
 * accents/noisy mics), overridable via `AZEN_TRANSCRIBE_MODEL`. If the primary
 * model is unavailable to the key (404 / model_not_found-style 400), we retry
 * ONCE with whisper-1 so dictation degrades instead of failing.
 *
 * Provider detail is console.error only (spec §15); the client sees just
 * openai_auth / transcribe_failed and degrades gracefully.
 */

const MAX_AUDIO_BYTES = 15 * 1024 * 1024;
const OPENAI_TRANSCRIPTIONS_URL =
  "https://api.openai.com/v1/audio/transcriptions";
// Containers MediaRecorder produces; an empty type (some browsers) is allowed.
const AUDIO_TYPE_RE = /(webm|ogg|mp4|m4a|wav)/i;

const DEFAULT_MODEL = "gpt-4o-transcribe";
const FALLBACK_MODEL = "whisper-1";
// Product-vocabulary bias so proper nouns transcribe correctly (both models
// accept `prompt`). Keep to one line.
const TRANSCRIBE_PROMPT =
  "Azen OS dashboard dictation. Vocabulary: Azen, MRR, retainer, ingest, webhook, Twilio, Higgsfield, Anthropic, Supabase, Vercel, co-pilot, brief.";

function extFor(type: string): string {
  if (/ogg/i.test(type)) return "ogg";
  if (/mp4|m4a/i.test(type)) return "mp4";
  if (/wav/i.test(type)) return "wav";
  return "webm";
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "<unreadable body>";
  }
}

/**
 * Does this OpenAI failure mean the requested model isn't available to this key
 * (as opposed to an auth or audio problem)? Covers the documented 404
 * `model_not_found` and equivalent model-related 400 bodies.
 */
function isModelUnavailable(status: number, body: string): boolean {
  if (status === 404) return true;
  if (status !== 400) return false;
  if (/model_not_found/i.test(body)) return true;
  return (
    /\bmodel\b/i.test(body) &&
    /(does not exist|not found|do(?:es)?(?:n't| not) have access|no access|unavailable|not supported|invalid)/i.test(
      body,
    )
  );
}

export const POST = withErrorHandling(async (req: Request) => {
  await requireOrgId();

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return jsonError(400, "multipart_form_required");
  }
  const audio = form.get("audio");
  if (audio === null || typeof audio === "string" || audio.size === 0) {
    return jsonError(400, "audio_required");
  }
  if (audio.size > MAX_AUDIO_BYTES) return jsonError(413, "audio_too_large");
  if (audio.type && !AUDIO_TYPE_RE.test(audio.type)) {
    return jsonError(400, "audio_type_unsupported");
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return jsonError(502, "openai_auth");

  const primaryModel =
    process.env.AZEN_TRANSCRIBE_MODEL?.trim() || DEFAULT_MODEL;
  const ext = extFor(audio.type);

  // Re-name with a guaranteed extension so the model can sniff the container.
  const attempt = (model: string): Promise<Response> => {
    const upstream = new FormData();
    upstream.append("file", audio, `clip.${ext}`);
    upstream.append("model", model);
    upstream.append("language", "en");
    upstream.append("response_format", "json");
    upstream.append("prompt", TRANSCRIBE_PROMPT);
    return fetch(OPENAI_TRANSCRIPTIONS_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: upstream,
    });
  };

  try {
    let res = await attempt(primaryModel);

    // Model-unavailable fallback (once): only for non-auth failures, and only
    // if we weren't already running on the fallback model.
    if (
      !res.ok &&
      res.status !== 401 &&
      res.status !== 403 &&
      primaryModel !== FALLBACK_MODEL
    ) {
      const detail = await safeText(res);
      if (isModelUnavailable(res.status, detail)) {
        console.error(
          `[transcribe] model "${primaryModel}" unavailable to this key (${res.status}); retrying with ${FALLBACK_MODEL}:`,
          detail,
        );
        res = await attempt(FALLBACK_MODEL);
      } else {
        // Genuine non-auth failure unrelated to the model — the body is already
        // consumed, so surface it now with the detail we captured.
        console.error("[transcribe] OpenAI error:", res.status, detail);
        return jsonError(502, "transcribe_failed");
      }
    }

    if (res.status === 401 || res.status === 403) {
      console.error(
        "[transcribe] OpenAI auth failed:",
        res.status,
        await safeText(res),
      );
      return jsonError(502, "openai_auth");
    }
    if (!res.ok) {
      console.error("[transcribe] OpenAI error:", res.status, await safeText(res));
      return jsonError(502, "transcribe_failed");
    }
    const json = (await res.json()) as { text?: unknown };
    if (typeof json.text !== "string") {
      console.error("[transcribe] unexpected OpenAI response shape:", json);
      return jsonError(502, "transcribe_failed");
    }
    return NextResponse.json({ text: json.text });
  } catch (err) {
    console.error("[transcribe] request failed:", err);
    return jsonError(502, "transcribe_failed");
  }
});
