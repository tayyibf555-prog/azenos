import { NextResponse } from "next/server";
import { jsonError, withErrorHandling } from "../../../lib/server/http";
import { requireOrgId } from "../../../lib/server/org";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Whisper dictation proxy (phase2 CONTRACTS addendum §A): multipart `audio`
 * (webm/ogg/mp4/wav, ≤15MB, ~90s capped client-side) → OpenAI whisper-1 via
 * plain fetch + FormData — deliberately NO SDK dependency. Returns `{text}`.
 * Provider detail is console.error only (spec §15); the client sees just
 * openai_auth / transcribe_failed and degrades gracefully.
 */

const MAX_AUDIO_BYTES = 15 * 1024 * 1024;
const OPENAI_TRANSCRIPTIONS_URL =
  "https://api.openai.com/v1/audio/transcriptions";
// Containers MediaRecorder produces; an empty type (some browsers) is allowed.
const AUDIO_TYPE_RE = /(webm|ogg|mp4|m4a|wav)/i;

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

  // Re-name with a guaranteed extension so Whisper can sniff the container.
  const upstream = new FormData();
  upstream.append("file", audio, `clip.${extFor(audio.type)}`);
  upstream.append("model", "whisper-1");
  upstream.append("language", "en");
  upstream.append("response_format", "json");

  try {
    const res = await fetch(OPENAI_TRANSCRIPTIONS_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: upstream,
    });
    if (res.status === 401 || res.status === 403) {
      console.error("[transcribe] OpenAI auth failed:", res.status, await safeText(res));
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
