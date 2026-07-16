import type { EventInput } from "./taxonomy";
import type { KnownEventType } from "./taxonomy";

/**
 * One canonical valid example per taxonomy type. Used by the test suite
 * (every type must validate) and as living documentation for integrators.
 */

const AT = "2026-07-10T09:15:00Z";
const base = (type: string, n: number) => ({
  type,
  occurred_at: AT,
  idempotency_key: `fixture:${type}:${n}`,
});

export const exampleEvents: Record<KnownEventType, EventInput> = {
  "lead.created": {
    ...base("lead.created", 1),
    subject: { kind: "lead", id: "ld_1", name: "Jane Doe" },
    data: { source: "google_ads", channel: "webchat", email: "jane@example.com" },
  },
  "lead.qualified": {
    ...base("lead.qualified", 1),
    data: { lead_id: "ld_1", score: 82, reason: "budget confirmed" },
  },
  "lead.stage_changed": {
    ...base("lead.stage_changed", 1),
    data: { from_stage: "new", to_stage: "quoted", pipeline: "sales" },
  },
  "lead.converted": {
    ...base("lead.converted", 1),
    data: { customer_id: "cus_9" },
    value_pence: 45_000,
  },
  "lead.lost": {
    ...base("lead.lost", 1),
    data: { reason: "went with competitor" },
  },
  "form.submitted": {
    ...base("form.submitted", 1),
    data: { form_name: "Contact us", fields: { message: "Call me back" } },
  },

  "booking.created": {
    ...base("booking.created", 1),
    actor: { kind: "ai_agent", id: "receptionist-v2", name: "AI Receptionist" },
    subject: { kind: "customer", id: "cus_123", name: "Jane D" },
    data: { service: "Checkup", starts_at: "2026-07-14T10:00:00Z", channel: "voice" },
    value_pence: 8_500,
    minutes_saved: 12,
  },
  "booking.rescheduled": {
    ...base("booking.rescheduled", 1),
    data: {
      booking_id: "bk_1",
      old_starts_at: "2026-07-14T10:00:00Z",
      new_starts_at: "2026-07-15T14:00:00Z",
    },
  },
  "booking.cancelled": {
    ...base("booking.cancelled", 1),
    data: { booking_id: "bk_1", reason: "patient unwell" },
  },
  "booking.completed": {
    ...base("booking.completed", 1),
    data: { booking_id: "bk_1", duration_minutes: 30 },
  },
  "booking.no_show": {
    ...base("booking.no_show", 1),
    data: { booking_id: "bk_2" },
  },

  "payment.captured": {
    ...base("payment.captured", 1),
    data: { amount_pence: 8_500, method: "card", external_id: "pi_1" },
    value_pence: 8_500,
  },
  "payment.failed": {
    ...base("payment.failed", 1),
    data: { amount_pence: 8_500, reason: "card_declined" },
  },
  "payment.refunded": {
    ...base("payment.refunded", 1),
    data: { amount_pence: 8_500, external_id: "pi_1" },
    value_pence: -8_500,
  },
  "invoice.sent": {
    ...base("invoice.sent", 1),
    data: { invoice_id: "inv_1", amount_pence: 120_000, due_date: "2026-07-31T00:00:00Z" },
  },
  "invoice.paid": {
    ...base("invoice.paid", 1),
    data: { invoice_id: "inv_1", amount_pence: 120_000 },
    value_pence: 120_000,
  },
  "subscription.started": {
    ...base("subscription.started", 1),
    data: { plan: "maintenance", amount_pence_monthly: 4_900 },
  },
  "subscription.cancelled": {
    ...base("subscription.cancelled", 1),
    data: { plan: "maintenance", reason: "moved away" },
  },
  "quote.sent": {
    ...base("quote.sent", 1),
    data: { quote_id: "q_77", amount_pence: 385_000, description: "Boiler replacement" },
  },
  "quote.accepted": {
    ...base("quote.accepted", 1),
    data: { quote_id: "q_77", amount_pence: 385_000 },
    value_pence: 385_000,
  },

  "agent.heartbeat": {
    ...base("agent.heartbeat", 1),
    data: {
      agent_id: "receptionist-v2",
      name: "AI Receptionist",
      version: "2.3.1",
      purpose: "Answers calls, books appointments",
      status: "ok",
    },
  },
  "agent.run.started": {
    ...base("agent.run.started", 1),
    data: { run_id: "run_1", agent_id: "receptionist-v2", task: "inbound call" },
  },
  "agent.run.completed": {
    ...base("agent.run.completed", 1),
    data: {
      run_id: "run_1",
      agent_id: "receptionist-v2",
      duration_ms: 84_000,
      success: true,
      tokens_in: 5_200,
      tokens_out: 940,
      cost_pence: 4,
      minutes_saved: 12,
    },
    minutes_saved: 12,
  },
  "agent.run.failed": {
    ...base("agent.run.failed", 1),
    data: { run_id: "run_2", agent_id: "quote-gen", error: "timeout calling pricing API" },
  },
  "agent.escalated_to_human": {
    ...base("agent.escalated_to_human", 1),
    data: { conversation_id: "cv_5", reason: "complex complaint" },
  },
  "agent.feedback": {
    ...base("agent.feedback", 1),
    data: { rating: 5, comment: "sorted it instantly", agent_id: "receptionist-v2" },
  },

  "llm.conversation": {
    ...base("llm.conversation", 1),
    actor: { kind: "ai_agent", id: "receptionist-v2" },
    subject: { kind: "customer", id: "cus_123" },
    data: {
      conversation_id: "cv_5",
      channel: "voice",
      turns: 9,
      duration_seconds: 190,
      intent: "book_appointment",
      resolution: "resolved",
      summary: "Caller booked a checkup for Tuesday and asked about whitening prices.",
      topics: ["booking", "whitening", "pricing"],
      sentiment: "positive",
    },
    minutes_saved: 8,
  },

  "message.sent": {
    ...base("message.sent", 1),
    data: { channel: "sms", to: "+447700900001", template: "recall_reminder_v1" },
  },
  "message.received": {
    ...base("message.received", 1),
    data: { channel: "whatsapp", from: "+447700900002" },
  },
  "email.sent": {
    ...base("email.sent", 1),
    data: { to: "jane@example.com", subject: "Your appointment is confirmed" },
  },
  "email.opened": {
    ...base("email.opened", 1),
    data: { email_id: "em_1", subject: "Your appointment is confirmed" },
  },
  "call.completed": {
    ...base("call.completed", 1),
    data: { duration_seconds: 240, outcome: "booked", direction: "inbound" },
  },
  "review.received": {
    ...base("review.received", 1),
    data: { rating: 5, text: "Brilliant service", platform: "google" },
  },

  "task.completed": {
    ...base("task.completed", 1),
    data: { what: "chased overdue invoice", by: "human", minutes_spent: 15 },
  },
  "workflow.run": {
    ...base("workflow.run", 1),
    data: { name: "recall-reminders-daily", success: true, actions_count: 34 },
  },
  "document.generated": {
    ...base("document.generated", 1),
    data: { kind: "quote_pdf", name: "Quote #77", document_id: "doc_1" },
  },
  "order.created": {
    ...base("order.created", 1),
    data: { order_id: "ord_1", amount_pence: 12_000, items_count: 3 },
    value_pence: 12_000,
  },
  "order.fulfilled": {
    ...base("order.fulfilled", 1),
    data: { order_id: "ord_1" },
  },

  "system.error": {
    ...base("system.error", 1),
    data: {
      severity: "error",
      component: "quote-generator",
      message: "pricing API returned 500",
    },
  },
  "system.warning": {
    ...base("system.warning", 1),
    data: { component: "webhook-sender", message: "retry queue above 100" },
  },
  "integration.disconnected": {
    ...base("integration.disconnected", 1),
    data: { provider: "sdk", reason: "oauth token expired" },
  },

  "feedback.submitted": {
    ...base("feedback.submitted", 1),
    data: {
      kind: "bug",
      message: "The booking confirmation button does nothing on my phone.",
      severity: 2,
      submitter: { name: "Reception", email: "front-desk@clinic.example" },
      page_url: "https://clinic.example/book",
    },
  },
};

export const exampleCustomEvent: EventInput = {
  type: "custom.loyalty_points_awarded",
  occurred_at: AT,
  idempotency_key: "fixture:custom:1",
  subject: { kind: "customer", id: "cus_123" },
  data: { points: 50, campaign: "summer" },
};
