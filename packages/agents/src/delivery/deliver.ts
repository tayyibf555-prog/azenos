// Delivery orchestrator (docs/phase3/CONTRACTS.md — P3-DELIVERY). Renders the
// brief email, fans out to email + WhatsApp, and (per §9.7) falls back to SMS
// only after WhatsApp fails twice. Honors a dryRun flag that returns the
// would-send payloads WITHOUT any network — this is how delivery is demoed and
// tested when RESEND_API_KEY / TWILIO_* are absent.
import { renderBriefEmail } from "@azen/emails";
import type { DailyBriefEmailModel } from "@azen/emails";
import { sendBriefEmail } from "./email";
import { sendSMS } from "./sms";
import { sendWhatsApp } from "./whatsapp";
import type {
  DeliveryResult,
  EmailPayload,
  SmsPayload,
  WhatsAppPayload,
} from "./types";

/** The brief content to deliver (built by the brief agent in Wave 2). */
export interface BriefForDelivery {
  headline: string;
  /** Model rendered into the HTML/text email body. */
  emailModel: DailyBriefEmailModel;
  /** ≤900-char single-thought WhatsApp/SMS body. */
  whatsappText: string;
  /** Optional email subject; defaults to the headline. */
  subject?: string;
}

/** Per-channel routing pulled from users.notificationPrefs (all optional). */
export interface DeliverPrefs {
  email?: { enabled?: boolean; to?: string | null };
  whatsapp?: { enabled?: boolean; to?: string | null };
  /** SMS is fallback-only; `to` defaults to the WhatsApp destination. */
  sms?: { enabled?: boolean; to?: string | null };
}

export interface DeliverBriefOptions {
  /** No network; return the would-send payloads instead. */
  dryRun?: boolean;
}

export interface DeliverBriefResult {
  email: DeliveryResult;
  whatsapp: DeliveryResult;
  /** Present only when the WhatsApp→SMS fallback was reached. */
  sms?: DeliveryResult;
  dryRun: boolean;
  /** Populated on dryRun (and whenever a channel was skipped-disabled). */
  payloads: {
    email: EmailPayload | null;
    whatsapp: WhatsAppPayload | null;
    sms: SmsPayload | null;
  };
}

const CHANNEL_DISABLED: DeliveryResult = {
  ok: false,
  reason: "channel_disabled",
};
const NO_RECIPIENT_EMAIL: DeliveryResult = {
  ok: false,
  reason: "email_no_recipient",
};
const NO_RECIPIENT_WHATSAPP: DeliveryResult = {
  ok: false,
  reason: "whatsapp_no_recipient",
};
const EMAIL_RENDER_FAILED: DeliveryResult = {
  ok: false,
  reason: "email_render_failed",
};

const WHATSAPP_MAX_ATTEMPTS = 2;

export async function deliverBrief(
  brief: BriefForDelivery,
  prefs: DeliverPrefs,
  options: DeliverBriefOptions = {},
): Promise<DeliverBriefResult> {
  const dryRun = options.dryRun === true;
  const subject = brief.subject ?? brief.headline;

  // Rendering is fallible (the emailModel derives from LLM output). A throw must
  // NOT reject deliverBrief — every channel returns a typed result
  // (CONTRACTS.md §P3-DELIVERY, lines 156-161). A render failure fails ONLY the
  // email channel; WhatsApp/SMS don't consume the HTML and proceed unaffected.
  let html = "";
  let text = "";
  let renderFailed = false;
  try {
    ({ html, text } = await renderBriefEmail(brief.emailModel));
  } catch (err) {
    console.error("[delivery] brief email render failed:", err);
    renderFailed = true;
  }

  const emailEnabled = prefs.email?.enabled !== false;
  const emailTo = prefs.email?.to ?? "";
  const whatsappEnabled = prefs.whatsapp?.enabled !== false;
  const whatsappTo = prefs.whatsapp?.to ?? "";

  // Pre-send disposition per channel (disabled / no-recipient / render-failed).
  // null ⇒ ready to send. dryRun and the live path share these reason codes so a
  // preview reports the SAME reason a real send would (no dryRun/live drift).
  const emailPreSend: DeliveryResult | null = !emailEnabled
    ? CHANNEL_DISABLED
    : !emailTo
      ? NO_RECIPIENT_EMAIL
      : renderFailed
        ? EMAIL_RENDER_FAILED
        : null;
  const whatsappPreSend: DeliveryResult | null = !whatsappEnabled
    ? CHANNEL_DISABLED
    : !whatsappTo
      ? NO_RECIPIENT_WHATSAPP
      : null;

  // Build would-send payloads (also surfaced in dryRun). A failed render yields
  // no email payload — there are no bytes to send.
  const emailPayload: EmailPayload | null =
    emailEnabled && emailTo && !renderFailed
      ? { to: emailTo, from: process.env.BRIEF_FROM_EMAIL ?? "", subject, html, text }
      : null;
  const whatsappPayload: WhatsAppPayload | null =
    whatsappEnabled && whatsappTo
      ? {
          to: whatsappTo,
          from: process.env.TWILIO_WHATSAPP_FROM ?? "",
          body: brief.whatsappText,
        }
      : null;

  const payloads: DeliverBriefResult["payloads"] = {
    email: emailPayload,
    whatsapp: whatsappPayload,
    sms: null,
  };

  if (dryRun) {
    return {
      email: emailPreSend ?? { ok: true },
      whatsapp: whatsappPreSend ?? { ok: true },
      dryRun: true,
      payloads,
    };
  }

  // --- Email ---
  const emailResult: DeliveryResult =
    emailPreSend ?? (await sendBriefEmail({ to: emailTo, subject, html, text }));

  // --- WhatsApp (retry once → twice total before SMS fallback) ---
  let whatsappResult: DeliveryResult;
  let smsResult: DeliveryResult | undefined;
  if (whatsappPreSend) {
    whatsappResult = whatsappPreSend;
  } else {
    whatsappResult = await attemptWhatsApp(whatsappTo, brief.whatsappText);
    // §9.7: SMS is the fallback after a genuine WhatsApp DELIVERY failure. A
    // config gap (whatsapp_not_configured) is not a delivery failure and is not
    // "two attempts", so it does NOT trigger the SMS fallback (CONTRACTS.md:155).
    if (!whatsappResult.ok && whatsappResult.reason !== "whatsapp_not_configured") {
      const smsEnabled = prefs.sms?.enabled !== false;
      const smsTo = prefs.sms?.to ?? whatsappTo;
      if (smsEnabled && smsTo) {
        smsResult = await sendSMS({ to: smsTo, body: brief.whatsappText });
        payloads.sms = {
          to: smsTo,
          from: process.env.TWILIO_SMS_FROM ?? process.env.TWILIO_WHATSAPP_FROM ?? "",
          body: brief.whatsappText,
        };
      }
    }
  }

  return {
    email: emailResult,
    whatsapp: whatsappResult,
    ...(smsResult ? { sms: smsResult } : {}),
    dryRun: false,
    payloads,
  };
}

// Twilio HTTP statuses that a retry cannot fix: bad auth / invalid request /
// forbidden / not-found. Retrying only doubles the API call and cost.
const PERMANENT_WHATSAPP_STATUSES = new Set([400, 401, 403, 404]);

/** True for a whatsapp_failed_<status> reason whose status is non-retryable. */
function isPermanentWhatsAppFailure(reason: string): boolean {
  const match = /^whatsapp_failed_(\d{3})/.exec(reason);
  return match !== null && PERMANENT_WHATSAPP_STATUSES.has(Number(match[1]));
}

/** Try WhatsApp up to WHATSAPP_MAX_ATTEMPTS; a not_configured result or a
 *  permanent (4xx) provider failure is terminal — retrying cannot succeed and
 *  only incurs a second Twilio API call. */
async function attemptWhatsApp(
  to: string,
  body: string,
): Promise<DeliveryResult> {
  let last: DeliveryResult = { ok: false, reason: "whatsapp_failed_unknown" };
  for (let attempt = 0; attempt < WHATSAPP_MAX_ATTEMPTS; attempt++) {
    last = await sendWhatsApp({ to, body });
    if (last.ok) return last;
    if (last.reason === "whatsapp_not_configured") return last;
    if (isPermanentWhatsAppFailure(last.reason)) return last;
  }
  return last;
}
