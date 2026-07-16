import { z } from "zod";
import { envelopeBaseSchema, isoTimestamp } from "./envelope";

/**
 * Event taxonomy — spec §7. The single most leveraged design surface in the
 * system: every metric, brief, and upsell derives from these schemas.
 * All types are implemented in v1 even if early projects send only a few.
 *
 * Data payloads use loose objects: extra keys are KEPT (never drop data).
 */

const loose = z.looseObject;

// ── leads / CRM ──────────────────────────────────────────────────────────────
const leadCreated = loose({
  name: z.string().optional(),
  email: z.string().optional(),
  phone: z.string().optional(),
  source: z.string().optional(),
  channel: z.string().optional(),
});
const leadQualified = loose({
  lead_id: z.string().optional(),
  score: z.number().optional(),
  reason: z.string().optional(),
});
const leadStageChanged = loose({
  from_stage: z.string().optional(),
  to_stage: z.string(),
  pipeline: z.string().optional(),
});
const leadConverted = loose({
  customer_id: z.string().optional(),
  value_estimate_pence: z.number().int().optional(),
});
const leadLost = loose({ reason: z.string().optional() });
const formSubmitted = loose({
  form_id: z.string().optional(),
  form_name: z.string().optional(),
  fields: z.record(z.string(), z.unknown()).optional(),
});

// ── bookings ─────────────────────────────────────────────────────────────────
const bookingCreated = loose({
  booking_id: z.string().optional(),
  service: z.string().optional(),
  starts_at: isoTimestamp,
  ends_at: isoTimestamp.optional(),
  channel: z.string().optional(),
  staff: z.string().optional(),
  location: z.string().optional(),
});
const bookingRescheduled = loose({
  booking_id: z.string().optional(),
  old_starts_at: isoTimestamp.optional(),
  new_starts_at: isoTimestamp,
});
const bookingCancelled = loose({
  booking_id: z.string().optional(),
  starts_at: isoTimestamp.optional(),
  reason: z.string().optional(),
});
const bookingCompleted = loose({
  booking_id: z.string().optional(),
  duration_minutes: z.number().nonnegative().optional(),
});
const bookingNoShow = loose({ booking_id: z.string().optional() });

// ── money (client's end-customers) ───────────────────────────────────────────
const paymentCaptured = loose({
  amount_pence: z.number().int(),
  method: z.string().optional(),
  external_id: z.string().optional(),
  description: z.string().optional(),
});
const paymentFailed = loose({
  amount_pence: z.number().int().optional(),
  reason: z.string().optional(),
  external_id: z.string().optional(),
});
const paymentRefunded = loose({
  amount_pence: z.number().int(),
  external_id: z.string().optional(),
  reason: z.string().optional(),
});
const invoiceSent = loose({
  invoice_id: z.string().optional(),
  amount_pence: z.number().int().optional(),
  due_date: isoTimestamp.optional(),
});
const invoicePaid = loose({
  invoice_id: z.string().optional(),
  amount_pence: z.number().int().optional(),
});
const subscriptionStarted = loose({
  plan: z.string().optional(),
  amount_pence_monthly: z.number().int().optional(),
  external_id: z.string().optional(),
});
const subscriptionCancelled = loose({
  plan: z.string().optional(),
  external_id: z.string().optional(),
  reason: z.string().optional(),
});
const quoteSent = loose({
  quote_id: z.string().optional(),
  amount_pence: z.number().int().optional(),
  description: z.string().optional(),
});
const quoteAccepted = loose({
  quote_id: z.string().optional(),
  amount_pence: z.number().int().optional(),
});

// ── AI agents inside client systems ──────────────────────────────────────────
const agentHeartbeat = loose({
  agent_id: z.string(),
  name: z.string().optional(),
  version: z.string().optional(),
  purpose: z.string().optional(),
  status: z.enum(["ok", "degraded", "down"]).optional(),
});
const agentRunStarted = loose({
  run_id: z.string().optional(),
  agent_id: z.string().optional(),
  task: z.string().optional(),
});
const agentRunCompleted = loose({
  run_id: z.string().optional(),
  agent_id: z.string().optional(),
  duration_ms: z.number().nonnegative().optional(),
  success: z.boolean().optional(),
  tokens_in: z.number().int().nonnegative().optional(),
  tokens_out: z.number().int().nonnegative().optional(),
  cost_pence: z.number().nonnegative().optional(),
  minutes_saved: z.number().nonnegative().optional(),
});
const agentRunFailed = loose({
  run_id: z.string().optional(),
  agent_id: z.string().optional(),
  error: z.string().optional(),
  duration_ms: z.number().nonnegative().optional(),
});
const agentEscalated = loose({
  conversation_id: z.string().optional(),
  agent_id: z.string().optional(),
  reason: z.string().optional(),
});
const agentFeedback = loose({
  rating: z.number().min(1).max(5),
  comment: z.string().optional(),
  agent_id: z.string().optional(),
});

// ── LLM conversations (fuel for §8 conversation intelligence) ────────────────
const llmConversation = loose({
  conversation_id: z.string().optional(),
  channel: z.enum(["voice", "webchat", "whatsapp", "sms", "email"]),
  turns: z.number().int().nonnegative().optional(),
  duration_seconds: z.number().nonnegative().optional(),
  intent: z.string().optional(),
  resolution: z.enum(["resolved", "escalated", "abandoned"]),
  summary: z.string().max(500).optional(),
  topics: z.array(z.string()).optional(),
  sentiment: z.enum(["positive", "neutral", "negative"]).optional(),
  transcript_ref: z.string().optional(),
});

// ── comms ────────────────────────────────────────────────────────────────────
const messageSent = loose({
  channel: z.string().optional(),
  to: z.string().optional(),
  template: z.string().optional(),
  message_id: z.string().optional(),
});
const messageReceived = loose({
  channel: z.string().optional(),
  from: z.string().optional(),
  message_id: z.string().optional(),
});
const emailSent = loose({
  to: z.string().optional(),
  subject: z.string().optional(),
  campaign: z.string().optional(),
  email_id: z.string().optional(),
});
const emailOpened = loose({
  email_id: z.string().optional(),
  subject: z.string().optional(),
});
const callCompleted = loose({
  duration_seconds: z.number().nonnegative().optional(),
  outcome: z.string().optional(),
  direction: z.enum(["inbound", "outbound"]).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});
const reviewReceived = loose({
  rating: z.number().min(1).max(5),
  text: z.string().optional(),
  platform: z.string().optional(),
});

// ── operations ───────────────────────────────────────────────────────────────
const taskCompleted = loose({
  what: z.string(),
  by: z.enum(["human", "ai"]).optional(),
  minutes_spent: z.number().nonnegative().optional(),
});
const workflowRun = loose({
  name: z.string(),
  success: z.boolean().optional(),
  actions_count: z.number().int().nonnegative().optional(),
});
const documentGenerated = loose({
  kind: z.string().optional(),
  name: z.string().optional(),
  document_id: z.string().optional(),
});
const orderCreated = loose({
  order_id: z.string().optional(),
  amount_pence: z.number().int().optional(),
  items_count: z.number().int().nonnegative().optional(),
});
const orderFulfilled = loose({ order_id: z.string().optional() });

// ── system health ────────────────────────────────────────────────────────────
const systemError = loose({
  severity: z.enum(["info", "warning", "error", "critical"]).optional(),
  component: z.string().optional(),
  message: z.string().optional(),
  stack: z.string().optional(),
});
const systemWarning = loose({
  component: z.string().optional(),
  message: z.string().optional(),
});
const integrationDisconnected = loose({
  provider: z.string().optional(),
  integration_id: z.string().optional(),
  reason: z.string().optional(),
});

// ── feedback (Phase 7 §B) ─────────────────────────────────────────────────────
// The public, least-privilege webhook's ONLY event. Unlike the loose ingest
// payloads, this is a STRICT object (public abuse surface): unknown keys are
// stripped, message is length-bounded, kind/severity are enumerated. The
// honeypot field ("website") is filtered by the endpoint BEFORE this schema.
const feedbackSubmitted = z.object({
  kind: z.enum(["bug", "feature", "question", "praise", "other"]),
  message: z.string().min(1).max(2000),
  severity: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
  // Public abuse surface: every submitter field is length-bounded and the email
  // is format-checked. Without these caps a submission can carry ~8KB of garbage
  // per field (only the 8KB body cap bounds them) and unverified email strings.
  submitter: z
    .object({
      name: z.string().max(120).optional(),
      email: z.string().email().max(254).optional(),
    })
    .optional(),
  page_url: z.string().max(2048).optional(),
});

// ── registry ─────────────────────────────────────────────────────────────────

export const eventDataSchemas = {
  "lead.created": leadCreated,
  "lead.qualified": leadQualified,
  "lead.stage_changed": leadStageChanged,
  "lead.converted": leadConverted,
  "lead.lost": leadLost,
  "form.submitted": formSubmitted,

  "booking.created": bookingCreated,
  "booking.rescheduled": bookingRescheduled,
  "booking.cancelled": bookingCancelled,
  "booking.completed": bookingCompleted,
  "booking.no_show": bookingNoShow,

  "payment.captured": paymentCaptured,
  "payment.failed": paymentFailed,
  "payment.refunded": paymentRefunded,
  "invoice.sent": invoiceSent,
  "invoice.paid": invoicePaid,
  "subscription.started": subscriptionStarted,
  "subscription.cancelled": subscriptionCancelled,
  "quote.sent": quoteSent,
  "quote.accepted": quoteAccepted,

  "agent.heartbeat": agentHeartbeat,
  "agent.run.started": agentRunStarted,
  "agent.run.completed": agentRunCompleted,
  "agent.run.failed": agentRunFailed,
  "agent.escalated_to_human": agentEscalated,
  "agent.feedback": agentFeedback,

  "llm.conversation": llmConversation,

  "message.sent": messageSent,
  "message.received": messageReceived,
  "email.sent": emailSent,
  "email.opened": emailOpened,
  "call.completed": callCompleted,
  "review.received": reviewReceived,

  "task.completed": taskCompleted,
  "workflow.run": workflowRun,
  "document.generated": documentGenerated,
  "order.created": orderCreated,
  "order.fulfilled": orderFulfilled,

  "system.error": systemError,
  "system.warning": systemWarning,
  "integration.disconnected": integrationDisconnected,

  "feedback.submitted": feedbackSubmitted,
} as const;

export const EVENT_TYPES = Object.keys(
  eventDataSchemas,
) as ReadonlyArray<KnownEventType>;

export type KnownEventType = keyof typeof eventDataSchemas;

const CUSTOM_TYPE_RE = /^custom\.[a-z0-9][a-z0-9_.-]{0,100}$/i;
// Free-form payload for custom.* — accepted, stored, surfaceable via JSONPath metrics
const customData = z.record(z.string(), z.unknown());

export function isKnownEventType(type: string): type is KnownEventType {
  return Object.prototype.hasOwnProperty.call(eventDataSchemas, type);
}

export function isCustomEventType(type: string): boolean {
  return CUSTOM_TYPE_RE.test(type);
}

/**
 * Ingest policy (spec §6.3 step 4): unknown event types are ACCEPTED and
 * stored as `custom.*` — never drop data — but flagged so mappings can be
 * added from the Setup tab.
 */
export function normalizeEventType(type: string): {
  type: string;
  wasUnknown: boolean;
} {
  if (isKnownEventType(type) || isCustomEventType(type)) {
    return { type, wasUnknown: false };
  }
  const slug = type
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "_")
    .replace(/^[_.]+|[_.]+$/g, "")
    .slice(0, 90);
  return { type: `custom.${slug || "unknown"}`, wasUnknown: true };
}

export function dataSchemaFor(type: string): z.ZodType | null {
  if (isKnownEventType(type)) return eventDataSchemas[type];
  if (isCustomEventType(type)) return customData;
  return null;
}

// ── full event validation ────────────────────────────────────────────────────

export const eventInputSchema = envelopeBaseSchema.extend({
  data: z.record(z.string(), z.unknown()).optional(),
});
export type EventInput = z.input<typeof eventInputSchema>;

export interface NormalizedEvent {
  type: string;
  occurred_at: string;
  idempotency_key: string;
  actor?: { kind: "ai_agent" | "human" | "system"; id?: string; name?: string };
  subject?: { kind: string; id?: string; name?: string };
  data: Record<string, unknown>;
  value_pence?: number;
  currency: string;
  minutes_saved?: number;
}

export type ParseEventResult =
  | { ok: true; event: NormalizedEvent }
  | { ok: false; error: string; issues?: z.core.$ZodIssue[] };

/**
 * Strict parse: the type must be known or custom.*. The ingest pipeline maps
 * unknown types through normalizeEventType() BEFORE calling this, so nothing
 * is ever dropped at the edge.
 */
export function parseEvent(input: unknown): ParseEventResult {
  const envelope = eventInputSchema.safeParse(input);
  if (!envelope.success) {
    return {
      ok: false,
      error: "invalid event envelope",
      issues: envelope.error.issues,
    };
  }
  const { type } = envelope.data;
  const dataSchema = dataSchemaFor(type);
  if (!dataSchema) {
    return {
      ok: false,
      error: `unknown event type "${type}" — pass through normalizeEventType() first or use custom.*`,
    };
  }
  const data = dataSchema.safeParse(envelope.data.data ?? {});
  if (!data.success) {
    return {
      ok: false,
      error: `invalid data payload for "${type}"`,
      issues: data.error.issues,
    };
  }
  return {
    ok: true,
    event: {
      ...envelope.data,
      data: data.data as Record<string, unknown>,
    },
  };
}
