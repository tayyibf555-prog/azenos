// Twilio SMS sender (docs/phase3/CONTRACTS.md — P3-DELIVERY). Plain fetch.
// §9.7: SMS is the fallback the orchestration reaches for ONLY after WhatsApp
// fails twice. Same graceful degradation as the other channels.
//
// From-number resolution (judgment call, noted in report): there is no
// TWILIO_SMS_FROM in .env.example. We read TWILIO_SMS_FROM when present and
// otherwise fall back to the bare TWILIO_WHATSAPP_FROM number (whatsapp: prefix
// stripped), so SMS works out-of-the-box for owners with a single Twilio number.
import type { DeliveryResult } from "./types";
import {
  postTwilioMessage,
  readTwilioCreds,
  stripWhatsAppPrefix,
} from "./twilio";

export interface SendSmsInput {
  to: string;
  body: string;
}

function resolveSmsFrom(): string | null {
  const explicit = process.env.TWILIO_SMS_FROM;
  if (explicit) return explicit;
  const whatsappFrom = process.env.TWILIO_WHATSAPP_FROM;
  if (whatsappFrom) return stripWhatsAppPrefix(whatsappFrom);
  return null;
}

export async function sendSMS(input: SendSmsInput): Promise<DeliveryResult> {
  const creds = readTwilioCreds();
  const from = resolveSmsFrom();
  if (!creds || !from) {
    return { ok: false, reason: "sms_not_configured" };
  }
  if (!input.to) {
    return { ok: false, reason: "sms_no_recipient" };
  }

  return postTwilioMessage(
    creds,
    {
      From: from,
      To: input.to,
      Body: input.body,
    },
    "sms_not_configured",
    "sms_failed",
  );
}
