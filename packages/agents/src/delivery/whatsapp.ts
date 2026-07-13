// Twilio WhatsApp sender (docs/phase3/CONTRACTS.md — P3-DELIVERY). Plain fetch.
// Graceful degradation: missing SID/AUTH_TOKEN/TWILIO_WHATSAPP_FROM →
// { ok:false, reason:'whatsapp_not_configured' } with ZERO network calls.
//
// NOTE (§9.7 production concern): outside the 24h customer-service window
// WhatsApp requires a PRE-APPROVED TEMPLATE message, not a free-form body. v1
// sends a session/body message; wiring an approved template (ContentSid +
// ContentVariables) is an owner to-do before production sends.
import type { DeliveryResult } from "./types";
import {
  postTwilioMessage,
  readTwilioCreds,
  withWhatsAppPrefix,
} from "./twilio";

export interface SendWhatsAppInput {
  /** Bare destination number (E.164). `whatsapp:` prefix added internally. */
  to: string;
  body: string;
}

export async function sendWhatsApp(
  input: SendWhatsAppInput,
): Promise<DeliveryResult> {
  const creds = readTwilioCreds();
  const from = process.env.TWILIO_WHATSAPP_FROM;
  if (!creds || !from) {
    return { ok: false, reason: "whatsapp_not_configured" };
  }
  if (!input.to) {
    return { ok: false, reason: "whatsapp_no_recipient" };
  }

  return postTwilioMessage(
    creds,
    {
      From: withWhatsAppPrefix(from),
      To: withWhatsAppPrefix(input.to),
      Body: input.body,
    },
    "whatsapp_not_configured",
    "whatsapp_failed",
  );
}
