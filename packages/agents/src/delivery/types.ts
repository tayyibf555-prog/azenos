// Delivery channel result + payload shapes (docs/phase3/CONTRACTS.md — P3-DELIVERY).
// Every sender resolves (never throws) to a DeliveryResult so the caller can
// stamp per-channel status on the brief row without try/catch.

export type DeliveryResult =
  | { ok: true; id?: string }
  | { ok: false; reason: string };

/** The exact bytes a real send would put on the wire (surfaced in dryRun). */
export interface EmailPayload {
  to: string;
  from: string;
  subject: string;
  html: string;
  text: string;
}

export interface WhatsAppPayload {
  /** Bare destination number (E.164), no channel prefix. */
  to: string;
  /** Bare Twilio sender number (E.164), no channel prefix. */
  from: string;
  body: string;
}

export interface SmsPayload {
  to: string;
  from: string;
  body: string;
}
