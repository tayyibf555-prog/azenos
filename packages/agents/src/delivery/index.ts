// Delivery channel senders + orchestrator (docs/phase3/CONTRACTS.md — P3-DELIVERY).
export { sendBriefEmail } from "./email";
export type { SendBriefEmailInput } from "./email";
export { sendWhatsApp } from "./whatsapp";
export type { SendWhatsAppInput } from "./whatsapp";
export { sendSMS } from "./sms";
export type { SendSmsInput } from "./sms";
export { deliverBrief } from "./deliver";
export type {
  BriefForDelivery,
  DeliverPrefs,
  DeliverBriefOptions,
  DeliverBriefResult,
} from "./deliver";
export type {
  DeliveryResult,
  EmailPayload,
  WhatsAppPayload,
  SmsPayload,
} from "./types";
