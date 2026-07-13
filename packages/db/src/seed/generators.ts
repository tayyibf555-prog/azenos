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
        data: { conversation_id: convId, reason: rng.pick(["complex complaint", "insurance question", "caller asked for a human", "payment plan request"]) },
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

// ── Elite Trades — Quote Bot (GHL webchat) ───────────────────────────────────

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
        intent: rng.pick(["get_quote", "job_enquiry", "availability", "chase_quote"]),
        resolution,
        summary: `Prospect described a ${rng.pick(["boiler swap", "full rewire", "bathroom refit", "roof repair"])} job; ${resolution === "resolved" ? "bot scoped it and produced a quote" : resolution === "escalated" ? "needed a site visit — passed to Dave" : "left mid-chat"}.`,
        topics: ["quote", rng.pick(["boiler", "rewire", "bathroom", "roofing"])],
        sentiment: rng.pick(["positive", "neutral", "neutral"]),
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
        data: { conversation_id: convId, reason: rng.pick(["clinical question", "complaint", "complex insurance claim"]) },
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
