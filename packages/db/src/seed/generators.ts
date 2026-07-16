import type { EventInput } from "@azen/events";
import type { DemoProject } from "./demo-data";
import { Rng } from "./rng";

/**
 * Synthetic-but-realistic event generation, one project-day at a time.
 * Deterministic per (project, date). Shared by seed:demo and the simulate CLI.
 */

const dayKey = (d: Date) => d.toISOString().slice(0, 10);

function at(date: Date, rng: Rng, hStart = 8, hEnd = 19): string {
  const t = new Date(date);
  t.setUTCHours(rng.int(hStart, hEnd - 1), rng.int(0, 59), rng.int(0, 59), 0);
  return t.toISOString();
}

/** volume multiplier: weekday pattern x slow growth over the window */
function volumeFactor(
  project: DemoProject,
  date: Date,
  dayIndex: number,
  totalDays: number,
): number {
  const dow = date.getUTCDay(); // 0 Sun .. 6 Sat
  let weekday = 1;
  if (project.slug === "elite-trades-quotebot") {
    weekday = dow === 0 ? 0.15 : dow === 6 ? 0.7 : 1;
  } else {
    // dental + clinic: closed Sunday, half-day Saturday
    weekday = dow === 0 ? 0 : dow === 6 ? 0.5 : 1;
  }
  const growth = 0.75 + 0.5 * (dayIndex / Math.max(1, totalDays - 1));
  return weekday * growth;
}

const FIRST_NAMES = ["Jane", "Tom", "Aisha", "Marcus", "Ellie", "Raj", "Sophie", "Liam", "Nadia", "Owen", "Grace", "Yusuf"];
const LAST_INITIALS = ["B", "C", "D", "H", "K", "M", "P", "S", "T", "W"];

function person(rng: Rng): { id: string; name: string } {
  return {
    id: `cus_${rng.hex(8)}`,
    name: `${rng.pick(FIRST_NAMES)} ${rng.pick(LAST_INITIALS)}`,
  };
}

/**
 * Realistic, niche-appropriate end-user QUESTION text keyed by intent, so the
 * Analytics "Question Intelligence" panel demos with real data after a reseed.
 * These land in `llm.conversation` data.question (and a few standalone
 * `message.received` data.text events), the two sources the endpoint mines.
 * Deterministic — always picked via the day's Rng.
 */
const SMILE_QUESTIONS: Record<string, readonly string[]> = {
  book_appointment: [
    "Can I book a check-up for next week?",
    "Do you have any appointments on Thursday?",
    "I need to see a dentist about a filling, when can I come in?",
    "Can I get my kids booked in for a check-up?",
  ],
  pricing: [
    "How much is teeth whitening?",
    "What does a scale and polish cost?",
    "Do you offer payment plans for veneers?",
    "How much is a private check-up?",
  ],
  opening_hours: [
    "What time do you open on Saturdays?",
    "Are you open on bank holidays?",
    "What are your opening hours today?",
  ],
  emergency: [
    "I've got really bad toothache, can I be seen today?",
    "My crown just fell out, what should I do?",
    "I chipped a tooth, is that an emergency appointment?",
  ],
  invoice_query: [
    "Can you resend my last invoice?",
    "Why was I charged twice for my appointment?",
    "Can I pay my treatment bill over the phone?",
  ],
  weekend_availability: [
    "Do you have any Saturday appointments this week?",
    "Can I come in at the weekend?",
  ],
};

const ELITE_QUESTIONS: Record<string, readonly string[]> = {
  get_quote: [
    "How much to replace a combi boiler?",
    "Can I get a quote for a full house rewire?",
    "What would a new bathroom fit cost?",
    "How much for a consumer unit upgrade?",
  ],
  job_enquiry: [
    "Do you do flat roof repairs?",
    "Can you install an EV charger at home?",
    "Do you cover commercial electrical work?",
    "Can you fit an outdoor tap?",
  ],
  availability: [
    "How soon could someone come out to look?",
    "Are you free to start next week?",
    "Do you do emergency call-outs?",
  ],
  chase_quote: [
    "Any update on the quote you were sending?",
    "Did the estimate for my rewire go through?",
    "Have you had a chance to price up my job?",
  ],
};

const BRIGHT_QUESTIONS: Record<string, readonly string[]> = {
  book_session: [
    "Can I book a physio session this week?",
    "Do you have any evening appointments?",
    "Can I see a physio about my shoulder?",
  ],
  back_pain_triage: [
    "I've had lower back pain for a week, should I come in?",
    "My knee hurts after running, can you help?",
    "Is my neck pain something a physio can treat?",
  ],
  insurance: [
    "Do you accept Bupa?",
    "Can I claim these sessions on my insurance?",
    "Do I need a GP referral to be seen?",
  ],
  cancel_or_move: [
    "I need to move my appointment to Friday",
    "Can I cancel my session tomorrow?",
    "Can I reschedule to next week?",
  ],
  pricing: [
    "How much is a physio session?",
    "Do you offer block bookings at a discount?",
    "What's the cost for an initial assessment?",
  ],
};

/** Deterministic question for an intent; "" when the intent has no bank. */
function questionFor(
  rng: Rng,
  bank: Record<string, readonly string[]>,
  intent: string,
): string {
  const pool = bank[intent];
  return pool && pool.length > 0 ? rng.pick(pool) : "";
}

/** A question for a random intent in the bank — for standalone inbound messages. */
function anyQuestion(rng: Rng, bank: Record<string, readonly string[]>): string {
  const keys = Object.keys(bank);
  return keys.length > 0 ? questionFor(rng, bank, rng.pick(keys)) : "";
}

interface Ctx {
  rng: Rng;
  date: Date;
  events: EventInput[];
  idk: (suffix?: string) => string;
}

function makeCtx(project: DemoProject, date: Date): Ctx {
  const rng = new Rng(`${project.slug}:${dayKey(date)}`);
  const events: EventInput[] = [];
  let n = 0;
  return {
    rng,
    date,
    events,
    idk: () => `seed:${project.slug}:${dayKey(date)}:${n++}`,
  };
}

// ── Smile Dental — AI Receptionist (voice) ───────────────────────────────────

function smileReceptionistDay(ctx: Ctx, factor: number, forceBookings?: number): void {
  const { rng, date, events, idk } = ctx;
  const agent = { kind: "ai_agent" as const, id: "receptionist-v2", name: "AI Receptionist" };

  events.push({
    type: "agent.heartbeat",
    occurred_at: at(date, rng, 7, 8),
    idempotency_key: idk(),
    actor: agent,
    data: { agent_id: "receptionist-v2", name: "AI Receptionist", version: "2.3.1", purpose: "Answers calls, books patients, handles FAQs", status: "ok" },
  });

  const convCount = rng.around(14 * factor);
  const intents = [
    { intent: "book_appointment", w: 0.5, topics: ["booking"] },
    { intent: "pricing", w: 0.16, topics: ["pricing", "whitening"] },
    { intent: "opening_hours", w: 0.08, topics: ["opening_hours"] },
    { intent: "emergency", w: 0.07, topics: ["emergency", "pain"] },
    { intent: "invoice_query", w: 0.09, topics: ["billing", "invoice"] },
    { intent: "weekend_availability", w: 0.1, topics: ["weekend", "availability"] },
  ];
  let bookingsMade = 0;
  const bookingTarget = forceBookings ?? Infinity;
  // Lifecycle events must reference a real created booking so ingest can
  // mirror status flips (§6.3 step 5); the sender-side contract is that
  // booking.cancelled/no_show carry the booking_id from booking.created.
  const bookingIds: string[] = [];

  for (let i = 0; i < convCount; i++) {
    const caller = person(rng);
    const roll = rng.float();
    let acc = 0;
    let chosen = intents[0]!;
    for (const it of intents) {
      acc += it.w;
      if (roll <= acc) { chosen = it; break; }
    }
    const escalated = rng.chance(0.08);
    const abandoned = !escalated && rng.chance(0.05);
    const resolution = escalated ? "escalated" : abandoned ? "abandoned" : "resolved";
    const when = at(date, rng);
    const durationS = rng.int(60, 420);
    const convId = `cv_${rng.hex(8)}`;

    events.push({
      type: "llm.conversation",
      occurred_at: when,
      idempotency_key: idk(),
      actor: agent,
      subject: { kind: "customer", ...caller },
      data: {
        conversation_id: convId,
        channel: "voice",
        turns: rng.int(4, 16),
        duration_seconds: durationS,
        intent: chosen.intent,
        resolution,
        summary: `Caller asked about ${chosen.intent.replace(/_/g, " ")}; ${resolution === "resolved" ? "handled end-to-end by the receptionist" : resolution === "escalated" ? "handed to front desk" : "caller dropped off"}.`,
        topics: chosen.topics,
        sentiment: resolution === "resolved" ? (rng.chance(0.8) ? "positive" : "neutral") : "neutral",
        question: questionFor(rng, SMILE_QUESTIONS, chosen.intent),
      },
      minutes_saved: resolution === "resolved" ? rng.int(6, 14) : undefined,
    });

    events.push({
      type: "agent.run.completed",
      occurred_at: when,
      idempotency_key: idk(),
      actor: agent,
      data: {
        run_id: `run_${rng.hex(8)}`,
        agent_id: "receptionist-v2",
        duration_ms: durationS * 1000,
        success: resolution !== "abandoned",
        tokens_in: rng.int(2500, 9000),
        tokens_out: rng.int(400, 1600),
        cost_pence: rng.int(2, 7),
      },
    });

    if (escalated) {
      events.push({
        type: "agent.escalated_to_human",
        occurred_at: when,
        idempotency_key: idk(),
        actor: agent,
        data: { agent_id: "receptionist-v2", conversation_id: convId, reason: rng.pick(["complex complaint", "insurance question", "caller asked for a human", "payment plan request"]) },
      });
    }

    const wantsBooking = chosen.intent === "book_appointment" || rng.chance(0.08);
    if (resolution === "resolved" && wantsBooking && bookingsMade < bookingTarget) {
      bookingsMade++;
      const start = new Date(date);
      start.setUTCDate(start.getUTCDate() + rng.int(1, 10));
      start.setUTCHours(rng.int(9, 17), rng.pick([0, 15, 30, 45]), 0, 0);
      const service = rng.pick(["Checkup", "Hygiene", "Whitening consult", "Filling", "Emergency slot"]);
      const bookingId = `bk_${rng.hex(8)}`;
      bookingIds.push(bookingId);
      events.push({
        type: "booking.created",
        occurred_at: when,
        idempotency_key: idk(),
        actor: agent,
        subject: { kind: "customer", ...caller },
        data: { booking_id: bookingId, service, starts_at: start.toISOString(), channel: "voice" },
        value_pence: rng.int(45, 180) * 100,
        minutes_saved: rng.int(8, 15),
      });
      if (rng.chance(0.3)) {
        events.push({
          type: "payment.captured",
          occurred_at: when,
          idempotency_key: idk(),
          subject: { kind: "customer", ...caller },
          data: { amount_pence: rng.int(20, 50) * 100, method: "card", description: `${service} deposit` },
          value_pence: 0, // deposit already counted in booking value
        });
      }
    }
  }

  // Standalone inbound SMS questions (not full conversations) — a second
  // question source the Analytics "Question Intelligence" panel mines.
  const smsCount = rng.around(3 * factor);
  for (let i = 0; i < smsCount; i++) {
    const texter = person(rng);
    events.push({
      type: "message.received",
      occurred_at: at(date, rng),
      idempotency_key: idk(),
      subject: { kind: "customer", ...texter },
      data: { channel: "sms", from: texter.name, text: anyQuestion(rng, SMILE_QUESTIONS) },
    });
  }

  // top-up if the forced target wasn't reached organically (narrative spike day)
  while (forceBookings !== undefined && bookingsMade < forceBookings) {
    bookingsMade++;
    const caller = person(rng);
    const start = new Date(date);
    start.setUTCDate(start.getUTCDate() + rng.int(1, 10));
    start.setUTCHours(rng.int(9, 17), rng.pick([0, 15, 30, 45]), 0, 0);
    const bookingId = `bk_${rng.hex(8)}`;
    bookingIds.push(bookingId);
    events.push({
      type: "booking.created",
      occurred_at: at(date, rng),
      idempotency_key: idk(),
      actor: agent,
      subject: { kind: "customer", ...caller },
      data: { booking_id: bookingId, service: rng.pick(["Checkup", "Hygiene"]), starts_at: start.toISOString(), channel: "voice" },
      value_pence: rng.int(45, 180) * 100,
      minutes_saved: rng.int(8, 15),
    });
  }

  if (bookingIds.length > 0 && rng.chance(0.35 * factor)) {
    events.push({
      type: "booking.cancelled",
      occurred_at: at(date, rng),
      idempotency_key: idk(),
      data: { booking_id: rng.pick(bookingIds), reason: rng.pick(["patient unwell", "double booked", "no reason given"]) },
    });
  }
  if (bookingIds.length > 0 && rng.chance(0.25 * factor)) {
    events.push({
      type: "booking.no_show",
      occurred_at: at(date, rng, 17, 19),
      idempotency_key: idk(),
      data: { booking_id: rng.pick(bookingIds) },
    });
  }
  if (rng.chance(0.28)) {
    events.push({
      type: "review.received",
      occurred_at: at(date, rng),
      idempotency_key: idk(),
      data: { rating: rng.pick([4, 5, 5, 5]), text: rng.pick(["Booked in seconds, brilliant", "So easy over the phone", "Answered at 9pm!", "Very helpful"]), platform: "google" },
    });
  }
  if (rng.chance(0.12)) {
    events.push({
      type: "system.warning",
      occurred_at: at(date, rng),
      idempotency_key: idk(),
      data: { component: "telephony", message: "call audio latency above 800ms" },
    });
  }
}

// ── Smile Dental — Recall Reminders (automation) ─────────────────────────────

function smileRecallDay(ctx: Ctx, factor: number): void {
  const { rng, date, events, idk } = ctx;
  if (factor === 0) return; // closed days: batch doesn't run

  events.push({
    type: "agent.heartbeat",
    occurred_at: at(date, rng, 6, 7),
    idempotency_key: idk(),
    data: { agent_id: "recall-runner", name: "Recall Runner", version: "1.4.0", purpose: "Daily recall reminder batch", status: "ok" },
  });

  const batch = rng.around(26 * factor);
  events.push({
    type: "workflow.run",
    occurred_at: at(date, rng, 7, 8),
    idempotency_key: idk(),
    data: { name: "recall-reminders-daily", success: true, actions_count: batch },
  });

  for (let i = 0; i < batch; i++) {
    const patient = person(rng);
    const when = at(date, rng, 8, 12);
    events.push({
      type: "message.sent",
      occurred_at: when,
      idempotency_key: idk(),
      subject: { kind: "patient", ...patient },
      data: { channel: "sms", template: "recall_reminder_v1", to: `+4477009${rng.int(10000, 99999)}` },
      minutes_saved: 2,
    });
    if (rng.chance(0.13)) {
      const start = new Date(date);
      start.setUTCDate(start.getUTCDate() + rng.int(2, 14));
      start.setUTCHours(rng.int(9, 17), rng.pick([0, 30]), 0, 0);
      events.push({
        type: "booking.created",
        occurred_at: at(date, rng, 9, 18),
        idempotency_key: idk(),
        actor: { kind: "system", id: "recall-runner" },
        subject: { kind: "patient", ...patient },
        data: { booking_id: `bk_${rng.hex(8)}`, service: "Recall checkup", starts_at: start.toISOString(), channel: "sms" },
        value_pence: rng.int(45, 95) * 100,
        minutes_saved: 5,
      });
    }
  }

  if (rng.chance(0.2)) {
    events.push({
      type: "task.completed",
      occurred_at: at(date, rng),
      idempotency_key: idk(),
      data: { what: "reviewed recall exclusions list", by: "human", minutes_spent: rng.int(5, 20) },
    });
  }
}

// ── Elite Trades — Quote Bot (webchat) ───────────────────────────────────────

function eliteQuotebotDay(ctx: Ctx, factor: number, errorBurst: boolean): void {
  const { rng, date, events, idk } = ctx;
  const agent = { kind: "ai_agent" as const, id: "quote-gen", name: "Quote Bot" };

  events.push({
    type: "agent.heartbeat",
    occurred_at: at(date, rng, 6, 7),
    idempotency_key: idk(),
    actor: agent,
    data: { agent_id: "quote-gen", name: "Quote Bot", version: "3.1.0", purpose: "Qualifies leads and generates instant quotes", status: errorBurst ? "degraded" : "ok" },
  });

  if (errorBurst) {
    // §17 narrative: 6 errors overnight — the quote generator is failing
    for (let i = 0; i < 6; i++) {
      events.push({
        type: "system.error",
        occurred_at: at(date, rng, 0, 6),
        idempotency_key: idk(),
        data: { severity: "error", component: "quote-generator", message: "pricing API returned 500 (timeout after 3 retries)" },
      });
    }
  }

  const leads = rng.around(6 * factor);
  for (let i = 0; i < leads; i++) {
    const lead = person(rng);
    const when = at(date, rng, 7, 21);
    events.push({
      type: "lead.created",
      occurred_at: when,
      idempotency_key: idk(),
      subject: { kind: "lead", ...lead },
      data: { source: rng.pick(["google_ads", "facebook", "checkatrade", "referral"]), channel: "webchat" },
    });
    if (rng.chance(0.6)) {
      events.push({
        type: "form.submitted",
        occurred_at: when,
        idempotency_key: idk(),
        subject: { kind: "lead", ...lead },
        data: { form_name: "Job details", fields: { job_type: rng.pick(["boiler", "rewire", "bathroom", "extension", "roofing"]), postcode: `LS${rng.int(1, 28)}` } },
      });
    }
  }

  const convs = rng.around(9 * factor);
  for (let i = 0; i < convs; i++) {
    const lead = person(rng);
    const when = at(date, rng, 7, 21);
    const escalated = rng.chance(0.12);
    const abandoned = !escalated && rng.chance(0.09);
    const resolution = escalated ? "escalated" : abandoned ? "abandoned" : "resolved";
    const convId = `cv_${rng.hex(8)}`;
    const intent = rng.pick(["get_quote", "job_enquiry", "availability", "chase_quote"]);

    events.push({
      type: "llm.conversation",
      occurred_at: when,
      idempotency_key: idk(),
      actor: agent,
      subject: { kind: "lead", ...lead },
      data: {
        conversation_id: convId,
        channel: "webchat",
        turns: rng.int(5, 22),
        duration_seconds: rng.int(120, 900),
        intent,
        resolution,
        summary: `Prospect described a ${rng.pick(["boiler swap", "full rewire", "bathroom refit", "roof repair"])} job; ${resolution === "resolved" ? "bot scoped it and produced a quote" : resolution === "escalated" ? "needed a site visit — passed to Dave" : "left mid-chat"}.`,
        topics: ["quote", rng.pick(["boiler", "rewire", "bathroom", "roofing"])],
        sentiment: rng.pick(["positive", "neutral", "neutral"]),
        question: questionFor(rng, ELITE_QUESTIONS, intent),
      },
      minutes_saved: resolution === "resolved" ? rng.int(10, 25) : undefined,
    });

    if (escalated) {
      events.push({
        type: "agent.escalated_to_human",
        occurred_at: when,
        idempotency_key: idk(),
        actor: agent,
        data: { conversation_id: convId, reason: rng.pick(["needs site visit", "bespoke job", "commercial enquiry"]) },
      });
    }

    if (resolution === "resolved" && rng.chance(0.55) && !errorBurst) {
      const amount = rng.int(450, 6200) * 100;
      const quoteId = `q_${rng.hex(6)}`;
      events.push({
        type: "quote.sent",
        occurred_at: when,
        idempotency_key: idk(),
        actor: agent,
        subject: { kind: "lead", ...lead },
        data: { quote_id: quoteId, amount_pence: amount, description: "Instant estimate from chat" },
        minutes_saved: 20,
      });
      events.push({
        type: "document.generated",
        occurred_at: when,
        idempotency_key: idk(),
        data: { kind: "quote_pdf", name: `Quote ${quoteId}`, document_id: quoteId },
      });
      if (rng.chance(0.3)) {
        events.push({
          type: "quote.accepted",
          occurred_at: at(date, rng, 12, 21),
          idempotency_key: idk(),
          subject: { kind: "lead", ...lead },
          data: { quote_id: quoteId, amount_pence: amount },
          value_pence: amount,
        });
      }
    }
  }

  // Standalone inbound webchat questions (not full conversations) — a second
  // question source the Analytics "Question Intelligence" panel mines.
  const inbound = rng.around(3 * factor);
  for (let i = 0; i < inbound; i++) {
    const asker = person(rng);
    events.push({
      type: "message.received",
      occurred_at: at(date, rng, 7, 21),
      idempotency_key: idk(),
      subject: { kind: "lead", ...asker },
      data: { channel: "webchat", from: asker.name, text: anyQuestion(rng, ELITE_QUESTIONS) },
    });
  }

  const calls = rng.around(3 * factor);
  for (let i = 0; i < calls; i++) {
    events.push({
      type: "call.completed",
      occurred_at: at(date, rng),
      idempotency_key: idk(),
      data: { duration_seconds: rng.int(90, 600), outcome: rng.pick(["booked_site_visit", "quote_discussed", "voicemail"]), direction: rng.pick(["inbound", "outbound"]) },
    });
  }

  const flows = rng.around(4 * factor);
  for (let i = 0; i < flows; i++) {
    events.push({
      type: "workflow.run",
      occurred_at: at(date, rng),
      idempotency_key: idk(),
      data: { name: rng.pick(["lead-nurture-drip", "quote-followup", "review-request"]), success: !errorBurst || rng.chance(0.7), actions_count: rng.int(1, 6) },
    });
  }
}

// ── BrightClinic — Webchat Assistant ─────────────────────────────────────────

function brightclinicDay(ctx: Ctx, factor: number): void {
  const { rng, date, events, idk } = ctx;
  const agent = { kind: "ai_agent" as const, id: "physio-assistant", name: "Webchat Assistant" };
  // see smileReceptionistDay: lifecycle events reference real created bookings
  const bookingIds: string[] = [];

  events.push({
    type: "agent.heartbeat",
    occurred_at: at(date, rng, 7, 8),
    idempotency_key: idk(),
    actor: agent,
    data: { agent_id: "physio-assistant", name: "Webchat Assistant", version: "1.9.2", purpose: "Books physio sessions, triages questions", status: "ok" },
  });

  const convs = rng.around(11 * factor);
  for (let i = 0; i < convs; i++) {
    const patient = person(rng);
    const when = at(date, rng, 7, 21);
    const escalated = rng.chance(0.1);
    const abandoned = !escalated && rng.chance(0.07);
    const resolution = escalated ? "escalated" : abandoned ? "abandoned" : "resolved";
    const convId = `cv_${rng.hex(8)}`;
    const intent = rng.pick(["book_session", "back_pain_triage", "insurance", "cancel_or_move", "pricing"]);

    events.push({
      type: "llm.conversation",
      occurred_at: when,
      idempotency_key: idk(),
      actor: agent,
      subject: { kind: "patient", ...patient },
      data: {
        conversation_id: convId,
        channel: "webchat",
        turns: rng.int(4, 18),
        duration_seconds: rng.int(90, 700),
        intent,
        resolution,
        summary: `Patient asked about ${intent.replace(/_/g, " ")}; ${resolution === "resolved" ? "assistant handled it" : resolution === "escalated" ? "flagged to reception" : "patient left"}.`,
        topics: [intent.split("_")[0]!, "physio"],
        sentiment: rng.pick(["positive", "positive", "neutral"]),
        question: questionFor(rng, BRIGHT_QUESTIONS, intent),
      },
      minutes_saved: resolution === "resolved" ? rng.int(5, 12) : undefined,
    });

    events.push({
      type: "agent.run.completed",
      occurred_at: when,
      idempotency_key: idk(),
      actor: agent,
      data: { run_id: `run_${rng.hex(8)}`, agent_id: "physio-assistant", duration_ms: rng.int(40_000, 400_000), success: resolution !== "abandoned", tokens_in: rng.int(1800, 7000), tokens_out: rng.int(300, 1200), cost_pence: rng.int(1, 5) },
    });

    if (escalated) {
      events.push({
        type: "agent.escalated_to_human",
        occurred_at: when,
        idempotency_key: idk(),
        actor: agent,
        data: { agent_id: "physio-assistant", conversation_id: convId, reason: rng.pick(["clinical question", "complaint", "complex insurance claim"]) },
      });
    }

    if (resolution === "resolved" && (intent === "book_session" || rng.chance(0.12))) {
      const start = new Date(date);
      start.setUTCDate(start.getUTCDate() + rng.int(1, 7));
      start.setUTCHours(rng.int(8, 19), rng.pick([0, 30]), 0, 0);
      const bookingId = `bk_${rng.hex(8)}`;
      bookingIds.push(bookingId);
      events.push({
        type: "booking.created",
        occurred_at: when,
        idempotency_key: idk(),
        actor: agent,
        subject: { kind: "patient", ...patient },
        data: { booking_id: bookingId, service: rng.pick(["Physio session", "Initial assessment", "Sports massage"]), starts_at: start.toISOString(), channel: "webchat" },
        value_pence: rng.int(55, 90) * 100,
        minutes_saved: rng.int(6, 12),
      });
      events.push({
        type: "email.sent",
        occurred_at: when,
        idempotency_key: idk(),
        data: { to: `${patient.name.split(" ")[0]!.toLowerCase()}@example.com`, subject: "Your session is booked" },
      });
    }
  }

  // Standalone inbound webchat questions (not full conversations) — a second
  // question source the Analytics "Question Intelligence" panel mines.
  const inbound = rng.around(3 * factor);
  for (let i = 0; i < inbound; i++) {
    const asker = person(rng);
    events.push({
      type: "message.received",
      occurred_at: at(date, rng, 7, 21),
      idempotency_key: idk(),
      subject: { kind: "patient", ...asker },
      data: { channel: "webchat", from: asker.name, text: anyQuestion(rng, BRIGHT_QUESTIONS) },
    });
  }

  if (bookingIds.length > 0 && rng.chance(0.3 * factor)) {
    events.push({
      type: "booking.cancelled",
      occurred_at: at(date, rng),
      idempotency_key: idk(),
      data: { booking_id: rng.pick(bookingIds), reason: "patient rescheduling" },
    });
  }
  if (bookingIds.length > 0 && rng.chance(0.2 * factor)) {
    events.push({
      type: "booking.no_show",
      occurred_at: at(date, rng, 17, 20),
      idempotency_key: idk(),
      data: { booking_id: rng.pick(bookingIds) },
    });
  }
  if (rng.chance(0.25)) {
    events.push({
      type: "review.received",
      occurred_at: at(date, rng),
      idempotency_key: idk(),
      data: { rating: rng.pick([4, 5, 5]), text: rng.pick(["Booked my physio in under a minute", "Really smooth", "Answered all my questions"]), platform: "google" },
    });
  }
}

// ── public API ───────────────────────────────────────────────────────────────

export interface DayOptions {
  dayIndex: number;
  totalDays: number;
}

export function generateProjectDay(
  project: DemoProject,
  date: Date,
  { dayIndex, totalDays }: DayOptions,
): EventInput[] {
  const ctx = makeCtx(project, date);
  const factor = volumeFactor(project, date, dayIndex, totalDays);
  const isLastDay = dayIndex === totalDays - 1;

  switch (project.slug) {
    case "smile-dental-receptionist":
      // §17 narrative: yesterday the receptionist booked 11 patients (+37% vs avg)
      smileReceptionistDay(ctx, factor, isLastDay ? 11 : undefined);
      break;
    case "smile-dental-recall":
      smileRecallDay(ctx, factor);
      break;
    case "elite-trades-quotebot":
      // §17 narrative: 6 errors overnight on the final day
      eliteQuotebotDay(ctx, factor, isLastDay);
      break;
    case "brightclinic-webchat":
      brightclinicDay(ctx, factor);
      break;
    default:
      throw new Error(`no generator for project ${project.slug}`);
  }
  return ctx.events;
}

// ── feedback (Phase 7 §B) ─────────────────────────────────────────────────────
// Deterministic niche-appropriate feedback.submitted events + their triage
// mirror rows. Client staff (not end-customers) report bugs / feature requests
// / questions from inside the client's own tooling via the embeddable widget.

type FeedbackKind = "bug" | "feature" | "question" | "praise" | "other";
type FeedbackStatus = "new" | "seen" | "planned" | "done";

export interface FeedbackSeed {
  input: EventInput;
  kind: FeedbackKind;
  message: string;
  severity?: number;
  submitterName?: string;
  submitterEmail?: string;
  pageUrl: string;
  status: FeedbackStatus;
}

interface FeedbackBank {
  pageBase: string;
  bug: readonly string[];
  feature: readonly string[];
  question: readonly string[];
  praise: readonly string[];
  other: readonly string[];
}

const FEEDBACK_BANKS: Record<string, FeedbackBank> = {
  "smile-dental-receptionist": {
    pageBase: "https://smiledental.example",
    bug: [
      "The receptionist keeps mishearing 'Thursday' as 'Tuesday' on bookings.",
      "Call transfer to a human drops the line about half the time.",
      "Out-of-hours voicemail isn't emailing us the transcript.",
      "It booked two patients into the same 3pm slot yesterday.",
      "Caller's phone number is coming through blank in the summary.",
    ],
    feature: [
      "Can it send the patient an SMS confirmation after booking?",
      "Please add a Welsh-language option for our Cardiff line.",
      "Would love a daily digest of every call it handled overnight.",
      "Let it read out our current new-patient offer when asked.",
    ],
    question: [
      "How do we change the greeting for bank holidays?",
      "Where do I see calls it couldn't handle?",
      "Can two practices share one receptionist number?",
    ],
    praise: [
      "Booked 11 patients overnight — the team is thrilled.",
      "Honestly sounds more patient than our old answering service.",
    ],
    other: ["Can we get a poster for reception explaining the AI line?"],
  },
  "smile-dental-recall": {
    pageBase: "https://smiledental.example/recall",
    bug: [
      "Recall SMS rebooking link 404s for patients on older iPhones.",
      "A lapsed patient got the reminder twice in one morning.",
      "Opt-out replies aren't removing people from the next batch.",
      "The batch ran at 6am instead of 9am today.",
    ],
    feature: [
      "Add a WhatsApp channel alongside SMS for recalls.",
      "Let us exclude patients with a future appointment already booked.",
      "A one-click 'snooze 3 months' link would cut no-shows.",
    ],
    question: [
      "How many recalls are queued for tomorrow?",
      "Can I preview the message copy before it sends?",
    ],
    praise: ["Recall rebookings are up noticeably this month, great stuff."],
    other: ["Is there a monthly cap on the number of SMS sent?"],
  },
  "elite-trades-quotebot": {
    pageBase: "https://elitetrades.example/quote",
    bug: [
      "Quote bot doubled the labour cost on a boiler job estimate.",
      "Photo upload for the quote form fails on Android Chrome.",
      "It stopped responding for ten minutes around lunchtime.",
      "Postcode lookup rejects valid BT (Northern Ireland) codes.",
      "The PDF quote is missing our VAT number.",
    ],
    feature: [
      "Let customers book a site survey straight from the quote.",
      "Add a deposit-payment link to accepted quotes.",
      "Support multi-trade jobs (plumbing + electrics) in one quote.",
    ],
    question: [
      "How do I update our hourly rate in the quote logic?",
      "Where can I see quotes that were started but not finished?",
      "Can it hand off to me on jobs over £5k?",
    ],
    praise: ["Quoted a £3,800 job at 11pm and won it — brilliant."],
    other: ["Can we rebrand the chat widget colours to match our van livery?"],
  },
  "brightclinic-webchat": {
    pageBase: "https://brightclinic.example",
    bug: [
      "Webchat shows no available slots even when the diary is open.",
      "Reschedule flow loses the patient's original appointment.",
      "Chat window covers the 'accept cookies' banner on mobile.",
      "It triaged a knee query as a back query in the summary.",
    ],
    feature: [
      "Add self-serve cancellation with a reason dropdown.",
      "Let patients upload a GP referral letter in the chat.",
      "Offer evening physio slots when daytime is full.",
    ],
    question: [
      "How do I add a new physio to the booking rota?",
      "Can it answer questions about our Pilates classes?",
    ],
    praise: [
      "Patients love being able to book physio at 10pm.",
      "Cut our front-desk phone volume right down — thank you.",
    ],
    other: ["Could we get the chat in Polish for our local community?"],
  },
};

const FEEDBACK_KINDS: readonly FeedbackKind[] = [
  "bug",
  "bug",
  "feature",
  "feature",
  "question",
  "question",
  "praise",
  "other",
];
const FEEDBACK_STATUSES: readonly FeedbackStatus[] = [
  "new",
  "new",
  "new",
  "seen",
  "seen",
  "planned",
  "done",
];
const FEEDBACK_PAGES = ["", "/book", "/contact", "/services", "/account"];

/**
 * 15–40 deterministic feedback.submitted events over the last 30 days for one
 * demo project, plus everything the feedback_items mirror needs. Emitted by the
 * seed AFTER the normal project days so Analytics → Feedback and the briefs are
 * populated the moment the demo boots.
 */
export function generateProjectFeedback(
  project: DemoProject,
  now: Date,
): FeedbackSeed[] {
  const bank = FEEDBACK_BANKS[project.slug];
  if (!bank) return [];
  const rng = new Rng(`${project.slug}:feedback`);
  const total = rng.int(15, 40);
  const seeds: FeedbackSeed[] = [];

  for (let i = 0; i < total; i++) {
    const kind = rng.pick(FEEDBACK_KINDS);
    const message = rng.pick(bank[kind]);
    const severity =
      kind === "bug" ? rng.pick([1, 2, 2, 3]) : undefined;
    const status = rng.pick(FEEDBACK_STATUSES);

    const occurred = new Date(now);
    occurred.setUTCDate(occurred.getUTCDate() - rng.int(0, 29));
    occurred.setUTCHours(rng.int(8, 19), rng.int(0, 59), rng.int(0, 59), 0);

    const named = rng.chance(0.6);
    const submitterName = named
      ? `${rng.pick(FIRST_NAMES)} ${rng.pick(LAST_INITIALS)}`
      : undefined;
    const submitterEmail = named
      ? `${(submitterName ?? "staff").split(" ")[0]!.toLowerCase()}@${
          bank.pageBase.replace("https://", "").split("/")[0]
        }`
      : undefined;
    const pageUrl = `${bank.pageBase}${rng.pick(FEEDBACK_PAGES)}`;

    const data: Record<string, unknown> = { kind, message, page_url: pageUrl };
    if (severity) data.severity = severity;
    if (submitterName || submitterEmail) {
      data.submitter = {
        ...(submitterName ? { name: submitterName } : {}),
        ...(submitterEmail ? { email: submitterEmail } : {}),
      };
    }

    seeds.push({
      input: {
        type: "feedback.submitted",
        occurred_at: occurred.toISOString(),
        idempotency_key: `seed:feedback:${project.slug}:${i}`,
        actor: submitterName
          ? { kind: "human", name: submitterName }
          : { kind: "human" },
        data,
      },
      kind,
      message,
      severity,
      submitterName,
      submitterEmail,
      pageUrl,
      status,
    });
  }
  return seeds;
}

/** Agency-level Calendly discovery calls (org events, project_id null) */
export function generateAgencyCalendlyDay(
  date: Date,
): { events: EventInput[]; invitees: { name: string; email: string }[] } {
  const rng = new Rng(`agency-calendly:${dayKey(date)}`);
  const dow = date.getUTCDay();
  const events: EventInput[] = [];
  const invitees: { name: string; email: string }[] = [];
  if (dow === 0 || dow === 6) return { events, invitees };
  const calls = rng.chance(0.45) ? rng.int(1, 2) : 0;
  for (let i = 0; i < calls; i++) {
    const p = person(rng);
    const email = `${p.name.split(" ")[0]!.toLowerCase()}@prospect.example`;
    const start = new Date(date);
    start.setUTCDate(start.getUTCDate() + rng.int(1, 6));
    start.setUTCHours(rng.int(9, 17), rng.pick([0, 30]), 0, 0);
    invitees.push({ name: p.name, email });
    events.push({
      type: "booking.created",
      occurred_at: at(date, rng),
      idempotency_key: `seed:agency-calendly:${dayKey(date)}:${i}`,
      subject: { kind: "lead", id: p.id, name: p.name },
      data: {
        booking_id: `cal_${rng.hex(8)}`,
        service: "Discovery call",
        starts_at: start.toISOString(),
        channel: "calendly",
      },
    });
  }
  return { events, invitees };
}
