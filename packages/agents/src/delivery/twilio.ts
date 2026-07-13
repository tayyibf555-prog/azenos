// Shared Twilio REST helper (docs/phase3/CONTRACTS.md — P3-DELIVERY). Plain
// fetch, no SDK dep. Basic auth (SID:AUTH_TOKEN), form-encoded body, JSON reply.
import type { DeliveryResult } from "./types";

export interface TwilioCreds {
  accountSid: string;
  authToken: string;
}

/** Reads Twilio creds from env; null when either is absent (→ not_configured). */
export function readTwilioCreds(): TwilioCreds | null {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) return null;
  return { accountSid, authToken };
}

function basicAuth(creds: TwilioCreds): string {
  const token = Buffer.from(
    `${creds.accountSid}:${creds.authToken}`,
  ).toString("base64");
  return `Basic ${token}`;
}

/**
 * POST a Twilio Message. `params` are the raw form fields (From/To/Body already
 * carrying any channel prefix). Resolves to a DeliveryResult (never throws).
 */
export async function postTwilioMessage(
  creds: TwilioCreds,
  params: Record<string, string>,
  notConfiguredReason: string,
  failPrefix: string,
): Promise<DeliveryResult> {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(
    creds.accountSid,
  )}/Messages.json`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: basicAuth(creds),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(params).toString(),
    });

    if (!res.ok) {
      const detail = await safeTwilioError(res);
      return { ok: false, reason: `${failPrefix}_${res.status}${detail}` };
    }

    const body = (await res.json().catch(() => null)) as { sid?: string } | null;
    return { ok: true, id: body?.sid };
  } catch (err) {
    // Distinct from the *_not_configured path: creds were present, the send
    // itself errored (network/DNS). notConfiguredReason kept for symmetry.
    void notConfiguredReason;
    return { ok: false, reason: `${failPrefix}_error:${errText(err)}` };
  }
}

async function safeTwilioError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: string; code?: number };
    const msg = body?.message ?? (body?.code != null ? String(body.code) : "");
    return msg ? `:${msg}` : "";
  } catch {
    return "";
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Ensure a number carries the `whatsapp:` channel prefix exactly once. */
export function withWhatsAppPrefix(value: string): string {
  return value.startsWith("whatsapp:") ? value : `whatsapp:${value}`;
}

/** Strip any `whatsapp:` prefix to recover a bare SMS-usable number. */
export function stripWhatsAppPrefix(value: string): string {
  return value.startsWith("whatsapp:") ? value.slice("whatsapp:".length) : value;
}
