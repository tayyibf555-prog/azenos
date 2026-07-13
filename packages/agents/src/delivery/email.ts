// Resend email sender (docs/phase3/CONTRACTS.md — P3-DELIVERY). Plain fetch, no
// SDK dep. Graceful degradation: missing RESEND_API_KEY / BRIEF_FROM_EMAIL →
// { ok:false, reason:'email_not_configured' } with ZERO network calls.
import type { DeliveryResult } from "./types";

const RESEND_ENDPOINT = "https://api.resend.com/emails";

export interface SendBriefEmailInput {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export async function sendBriefEmail(
  input: SendBriefEmailInput,
): Promise<DeliveryResult> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.BRIEF_FROM_EMAIL;
  if (!apiKey || !from) {
    return { ok: false, reason: "email_not_configured" };
  }
  if (!input.to) {
    return { ok: false, reason: "email_no_recipient" };
  }

  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [input.to],
        subject: input.subject,
        html: input.html,
        text: input.text,
      }),
    });

    if (!res.ok) {
      const detail = await safeErrorMessage(res);
      return { ok: false, reason: `email_failed_${res.status}${detail}` };
    }

    const body = (await res.json().catch(() => null)) as { id?: string } | null;
    return { ok: true, id: body?.id };
  } catch (err) {
    return { ok: false, reason: `email_error:${errText(err)}` };
  }
}

async function safeErrorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: string; name?: string };
    const msg = body?.message ?? body?.name;
    return msg ? `:${msg}` : "";
  } catch {
    return "";
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
