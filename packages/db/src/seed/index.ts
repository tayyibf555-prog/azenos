import { parseEvent, type EventInput } from "@azen/events";
import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { closeDb, db } from "../client";
import { encryptSecret } from "../keys";
import * as s from "../schema/index";
import {
  CLIENTS,
  DEFAULT_ALERT_RULES,
  DEFAULT_METRIC_DEFINITIONS,
  INDUSTRIES,
  ORG_ID,
  OWNER,
  PROJECTS,
} from "./demo-data";
import {
  generateAgencyCalendlyDay,
  generateProjectDay,
  generateProjectFeedback,
  type FeedbackSeed,
} from "./generators";
import { runRollups } from "../rollup/engine";
import { Rng } from "./rng";
import { londonDayUTC, londonMonthStartUTC } from "./time";

/**
 * pnpm seed:demo — spec §13. Wipes and repopulates the database with 1 org,
 * 3 demo clients, 4 live projects and ~90 days of realistic synthetic events,
 * so the entire UI and all agents are demo-able before any real client is
 * wired in. Deterministic except for row UUIDs and received_at jitter.
 */

const DAYS = 90;

const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");

const dayAtMidnightUTC = londonDayUTC;
const monthStart = londonMonthStartUTC;

const isoDate = (d: Date) => d.toISOString().slice(0, 10);

interface EventRow {
  id: string;
  orgId: string;
  projectId: string | null;
  type: string;
  source: "sdk" | "calendly" | "feedback";
  idempotencyKey: string;
  occurredAt: Date;
  receivedAt: Date;
  actor: EventInput["actor"] | null;
  subject: EventInput["subject"] | null;
  data: Record<string, unknown>;
  valuePence: number | null;
  currency: string;
  minutesSaved: number | null;
  raw: unknown;
}

function toRow(
  input: EventInput,
  projectId: string | null,
  source: "sdk" | "calendly" | "feedback",
): EventRow {
  const parsed = parseEvent(input);
  if (!parsed.ok) {
    throw new Error(
      `seed generated an invalid event (${input.type}): ${parsed.error}\n${JSON.stringify(parsed.issues?.slice(0, 3), null, 2)}`,
    );
  }
  const e = parsed.event;
  const occurredAt = new Date(e.occurred_at);
  return {
    id: randomUUID(),
    orgId: ORG_ID,
    projectId,
    type: e.type,
    source,
    idempotencyKey: e.idempotency_key,
    occurredAt,
    receivedAt: new Date(occurredAt.getTime() + 1500),
    actor: e.actor ?? null,
    subject: e.subject ?? null,
    data: e.data,
    valuePence: e.value_pence ?? null,
    currency: e.currency,
    minutesSaved: e.minutes_saved ?? null,
    raw: input,
  };
}

async function main() {
  console.log("Seeding Azen OS demo data…\n");

  // ── wipe ──────────────────────────────────────────────────────────────────
  await db.execute(sql`
    truncate table
      webhook_deliveries, alert_rules,
      chat_messages, chat_sessions, agent_runs, knowledge_articles,
      upsell_proposals, insights, briefs,
      feedback_items,
      bookings, expenses, subscriptions, payments,
      metric_rollups, metric_definitions, events,
      project_integrations, project_keys, projects,
      contacts, clients, industries, users, organizations
    cascade
  `);

  // ── org, owner, industries, clients ──────────────────────────────────────
  await db.insert(s.organizations).values({ id: ORG_ID, name: "Azen AI" });
  await db.insert(s.users).values({ ...OWNER, orgId: ORG_ID });
  await db.insert(s.industries).values(
    INDUSTRIES.map((i) => ({ ...i, orgId: ORG_ID })),
  );

  const industryBySlug = Object.fromEntries(INDUSTRIES.map((i) => [i.slug, i.id]));

  await db.insert(s.clients).values(
    CLIENTS.map((c) => ({
      id: c.id,
      orgId: ORG_ID,
      name: c.name,
      company: c.company,
      industryId: industryBySlug[c.industrySlug],
      status: c.status,
      source: c.source,
      emails: [...c.emails],
      phones: [...c.phones],
      website: c.website,
    })),
  );
  await db.insert(s.contacts).values(
    CLIENTS.flatMap((c) =>
      c.contacts.map((ct) => ({ orgId: ORG_ID, clientId: c.id, ...ct })),
    ),
  );

  // ── projects + keys + integrations ────────────────────────────────────────
  await db.insert(s.projects).values(
    PROJECTS.map((p) => ({
      id: p.id,
      orgId: ORG_ID,
      clientId: p.clientId,
      name: p.name,
      slug: p.slug,
      description: p.description,
      type: p.type,
      stack: p.stack,
      status: "live" as const,
      buildFeePence: p.buildFeePence,
      retainerPenceMonthly: p.retainerPenceMonthly,
      retainerActive: true,
      startDate: isoDate(dayAtMidnightUTC(p.liveDaysAgo + 30)),
      liveDate: isoDate(dayAtMidnightUTC(p.liveDaysAgo)),
      health: "green" as const,
      goals: p.goals,
    })),
  );

  await db.insert(s.projectKeys).values(
    PROJECTS.map((p) => ({
      orgId: ORG_ID,
      projectId: p.id,
      publicKey: p.publicKey,
      secretHash: sha256(p.demoSecret),
      secretCiphertext: encryptSecret(p.demoSecret),
      authMode: "hmac" as const,
      kind: "ingest" as const,
      label: "demo key",
    })),
  );

  // Phase 7 §B: a PUBLIC feedback-widget key per project (deterministic public
  // key, no secret shipped). Powers the embeddable widget + Analytics→Feedback.
  const feedbackPublicKeyFor = (slug: string) =>
    `azn_fb_demo_${slug.replace(/-/g, "_")}`;
  await db.insert(s.projectKeys).values(
    PROJECTS.map((p) => ({
      orgId: ORG_ID,
      projectId: p.id,
      publicKey: feedbackPublicKeyFor(p.slug),
      secretHash: sha256(`feedback:${p.slug}`),
      authMode: "token" as const,
      kind: "feedback" as const,
      label: "feedback widget key",
    })),
  );

  // ── metric definitions + alert rules (org defaults) ──────────────────────
  await db.insert(s.metricDefinitions).values(
    DEFAULT_METRIC_DEFINITIONS.map((m) => ({
      orgId: ORG_ID,
      projectId: null,
      key: m.key,
      name: m.name,
      eventType: m.eventType,
      aggregation: m.aggregation,
      unit: m.unit,
      valuePath: "valuePath" in m ? m.valuePath : null,
      whereEquals: "whereEquals" in m ? m.whereEquals : null,
      goodDirection: m.goodDirection,
      isKpi: m.isKpi,
      sort: m.sort,
    })),
  );
  await db.insert(s.alertRules).values(
    DEFAULT_ALERT_RULES.map((a) => ({ ...a, orgId: ORG_ID, projectId: null })),
  );

  // ── 90 days of project events + booking mirrors ──────────────────────────
  const clientByProject = Object.fromEntries(
    PROJECTS.map((p) => [p.id, p.clientId]),
  );
  const allRows: EventRow[] = [];
  const perProjectCounts: Record<string, number> = {};

  for (const project of PROJECTS) {
    let count = 0;
    for (let dayIndex = 0; dayIndex < DAYS; dayIndex++) {
      const date = dayAtMidnightUTC(DAYS - dayIndex); // ends yesterday
      const inputs = generateProjectDay(project, date, {
        dayIndex,
        totalDays: DAYS,
      });
      for (const input of inputs) {
        allRows.push(toRow(input, project.id, "sdk"));
        count++;
      }
    }
    perProjectCounts[project.slug] = count;
  }

  // Phase 7 §B: feedback.submitted events + their triage-mirror seeds. Emitted
  // per project over the last 30 days; the mirror rows are built after the
  // events insert so they can reference the real event ids.
  const feedbackNow = new Date();
  const feedbackByRow = new Map<string, FeedbackSeed>();
  const feedbackCounts: Record<string, number> = {};
  for (const project of PROJECTS) {
    const seeds = generateProjectFeedback(project, feedbackNow);
    feedbackCounts[project.slug] = seeds.length;
    for (const seed of seeds) {
      const row = toRow(seed.input, project.id, "feedback");
      allRows.push(row);
      feedbackByRow.set(row.id, seed);
    }
  }

  // agency Calendly events (org-level: project_id null)
  const agencyInvitees: { row: EventRow; invitee: { name: string; email: string } }[] = [];
  for (let dayIndex = 0; dayIndex < DAYS; dayIndex++) {
    const date = dayAtMidnightUTC(DAYS - dayIndex);
    const { events: inputs, invitees } = generateAgencyCalendlyDay(date);
    inputs.forEach((input, i) => {
      const row = toRow(input, null, "calendly");
      allRows.push(row);
      agencyInvitees.push({ row, invitee: invitees[i]! });
    });
  }

  for (let i = 0; i < allRows.length; i += 500) {
    await db.insert(s.events).values(allRows.slice(i, i + 500));
  }

  // mirror booking.created → bookings (§6.3 step 5 / §4.6)
  const now = new Date();
  const mirrorRng = new Rng("booking-mirror");
  const bookingRows = allRows
    .filter((r) => r.type === "booking.created")
    .map((r) => {
      const startsAt = new Date(String(r.data.starts_at));
      const isAgency = r.projectId === null;
      const past = startsAt < now;
      return {
        orgId: ORG_ID,
        clientId: isAgency ? null : clientByProject[r.projectId!],
        projectId: r.projectId,
        source: (isAgency ? "calendly" : "client_system") as "calendly" | "client_system",
        kind: (isAgency ? "discovery" : "client_end_customer") as "discovery" | "client_end_customer",
        invitee: isAgency
          ? (agencyInvitees.find((a) => a.row.id === r.id)?.invitee ?? null)
          : ((r.subject ?? null) as Record<string, unknown> | null),
        startsAt,
        endsAt: new Date(startsAt.getTime() + 30 * 60_000),
        status: (past
          ? mirrorRng.chance(0.92)
            ? "completed"
            : "no_show"
          : "scheduled") as "completed" | "no_show" | "scheduled",
        externalId: String(r.data.booking_id ?? r.data.external_id ?? "") || null,
        sourceEventId: r.id,
        raw: r.raw,
      };
    });
  for (let i = 0; i < bookingRows.length; i += 500) {
    await db.insert(s.bookings).values(bookingRows.slice(i, i + 500));
  }

  // mirror feedback.submitted → feedback_items (Phase 7 §B triage board)
  const feedbackItemRows: (typeof s.feedbackItems.$inferInsert)[] = allRows
    .filter((r) => r.type === "feedback.submitted")
    .map((r) => {
      const seed = feedbackByRow.get(r.id)!;
      return {
        orgId: ORG_ID,
        projectId: r.projectId!,
        eventId: r.id,
        kind: seed.kind,
        message: seed.message,
        severity: seed.severity ?? null,
        submitterName: seed.submitterName ?? null,
        submitterEmail: seed.submitterEmail ?? null,
        pageUrl: seed.pageUrl,
        status: seed.status,
        createdAt: r.occurredAt,
      };
    });
  for (let i = 0; i < feedbackItemRows.length; i += 500) {
    await db.insert(s.feedbackItems).values(feedbackItemRows.slice(i, i + 500));
  }

  // ── KB-gap opportunities (Phase 9 §P9-KB) ────────────────────────────────
  // The KB-gap miner + Scout only WRITE automation_opportunity insights through
  // the LLM chassis (runAgent, gated on ANTHROPIC_API_KEY). A keyless demo would
  // therefore show an empty Growth pipeline. Seed the deterministic content-gap
  // opportunities straight from the conversation projects' mishandled
  // (escalated / abandoned / negative) `llm.conversation` events, so the Growth
  // funnel + KB-gap surface are demo-able without a key. Fingerprints match the
  // miner's `kbgap:<projectId>:<slug>` scheme, so a later real run UPDATES these
  // rows in place instead of duplicating them.
  const KB_GAP_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
  const kbCutoff = new Date(now.getTime() - KB_GAP_WINDOW_MS);
  const gapSlug = (raw: string) =>
    raw.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") ||
    "content-gap";
  const insightRows: (typeof s.insights.$inferInsert)[] = [];
  for (const proj of PROJECTS) {
    const convos = allRows.filter(
      (r) =>
        r.projectId === proj.id &&
        r.type === "llm.conversation" &&
        r.occurredAt >= kbCutoff,
    );
    if (convos.length === 0) continue;
    const byIntent = new Map<
      string,
      { total: number; mishandled: number; ids: string[]; topics: Set<string> }
    >();
    for (const r of convos) {
      const intent = String(r.data.intent ?? "unspecified") || "unspecified";
      const resolution = String(r.data.resolution ?? "");
      const sentiment = String(r.data.sentiment ?? "");
      const mishandled =
        resolution === "escalated" || resolution === "abandoned" || sentiment === "negative";
      const g =
        byIntent.get(intent) ?? { total: 0, mishandled: 0, ids: [], topics: new Set<string>() };
      g.total += 1;
      if (mishandled) {
        g.mishandled += 1;
        if (g.ids.length < 5) g.ids.push(r.id);
      }
      for (const t of Array.isArray(r.data.topics) ? r.data.topics : []) {
        g.topics.add(String(t));
      }
      byIntent.set(intent, g);
    }
    const ranked = [...byIntent.entries()]
      .filter(([, g]) => g.mishandled >= 3)
      .sort(
        (a, b) =>
          b[1].mishandled - a[1].mishandled ||
          b[1].total - a[1].total ||
          a[0].localeCompare(b[0]),
      )
      .slice(0, 2);
    for (const [intent, g] of ranked) {
      const label = intent.replace(/_/g, " ");
      const hoursSaved = Math.max(1, Math.round(g.mishandled * 0.4));
      const valuePence = g.mishandled * 2_500;
      insightRows.push({
        orgId: ORG_ID,
        projectId: proj.id,
        kind: "automation_opportunity",
        title: `Knowledge-base article: ${label}`,
        bodyMd: `${g.mishandled} of ${g.total} “${label}” conversations in the last 30 days escalated, were abandoned, or came back negative. A dedicated knowledge-base article plus a bot-improvement brief would let the agent resolve these end-to-end — recovering roughly ${hoursSaved}h of human handling a month.`,
        evidence: {
          content_gap: true,
          event_ids: g.ids,
          intent,
          question: `Recurring “${label}” questions the agent handles badly`,
          aggregates: {
            total: g.total,
            gap_signals: g.mishandled,
            estimated_hours_saved_monthly: hoursSaved,
            estimated_value_pence: valuePence,
          },
          topics: [...g.topics].slice(0, 8),
        },
        fingerprint: `kbgap:${proj.id}:${gapSlug(intent)}`,
        estimatedValuePence: valuePence,
        estimatedHoursSavedMonthly: hoursSaved,
        confidence: g.mishandled >= 8 ? "high" : "med",
        status: "new",
        createdBy: "agent",
      });
    }
  }
  if (insightRows.length > 0) {
    await db.insert(s.insights).values(insightRows);
  }

  // ── agency money: build fees, retainers, subscriptions, expenses ─────────
  const payRng = new Rng("payments");
  const paymentRows: (typeof s.payments.$inferInsert)[] = [];
  const subscriptionRows: (typeof s.subscriptions.$inferInsert)[] = [];

  for (const p of PROJECTS) {
    const start = dayAtMidnightUTC(p.liveDaysAgo + 30);
    paymentRows.push({
      orgId: ORG_ID,
      clientId: p.clientId,
      projectId: p.id,
      source: payRng.chance(0.5) ? "stripe" : "bank_transfer",
      kind: "build_fee",
      amountPence: p.buildFeePence,
      status: "paid",
      invoiceRef: `AZ-${isoDate(start).replaceAll("-", "").slice(0, 6)}-${p.slug.slice(0, 4).toUpperCase()}`,
      paidAt: new Date(start.getTime() + payRng.int(1, 5) * 86_400_000),
      notes: `${p.name} build fee`,
    });

    subscriptionRows.push({
      orgId: ORG_ID,
      clientId: p.clientId,
      projectId: p.id,
      stripeSubscriptionId: `sub_demo_${p.slug}`,
      amountPenceMonthly: p.retainerPenceMonthly,
      status: "active",
      startedAt: isoDate(dayAtMidnightUTC(p.liveDaysAgo)),
    });

    // retainers for the last 3 calendar months; BrightClinic's current month
    // is deliberately missing → powers the overdue-retainer flag (§5.4)
    for (let m = 3; m >= 0; m--) {
      const ms = monthStart(m);
      if (ms < dayAtMidnightUTC(p.liveDaysAgo)) continue;
      const isCurrentMonth = m === 0;
      if (isCurrentMonth && p.slug === "brightclinic-webchat") continue;
      if (isCurrentMonth && ms > new Date()) continue;
      paymentRows.push({
        orgId: ORG_ID,
        clientId: p.clientId,
        projectId: p.id,
        source: "stripe",
        kind: "retainer",
        amountPence: p.retainerPenceMonthly,
        status: "paid",
        invoiceRef: `AZ-RET-${isoDate(ms).slice(0, 7)}-${p.slug.slice(0, 4).toUpperCase()}`,
        paidAt: new Date(ms.getTime() + payRng.int(0, 4) * 86_400_000 + 10 * 3_600_000),
        notes: `${p.name} retainer ${isoDate(ms).slice(0, 7)}`,
      });
    }
  }
  await db.insert(s.payments).values(paymentRows);
  await db.insert(s.subscriptions).values(subscriptionRows);

  const expenseRows: (typeof s.expenses.$inferInsert)[] = [];
  for (let m = 2; m >= 0; m--) {
    const ms = monthStart(m);
    const period = isoDate(ms).slice(0, 7);
    expenseRows.push(
      { orgId: ORG_ID, category: "hosting", vendor: "Vercel", amountPence: 2_000, recurring: true, period, incurredAt: isoDate(ms) },
      { orgId: ORG_ID, category: "api", vendor: "Anthropic", amountPence: 4_200, recurring: true, period, incurredAt: isoDate(ms) },
      { orgId: ORG_ID, category: "tools", vendor: "Twilio", amountPence: 1_500, recurring: true, period, incurredAt: isoDate(ms) },
      { orgId: ORG_ID, category: "tools", vendor: "Upstash", amountPence: 800, recurring: true, period, incurredAt: isoDate(ms) },
    );
    for (const p of PROJECTS) {
      expenseRows.push({
        orgId: ORG_ID,
        projectId: p.id,
        category: "hosting",
        vendor: "Supabase",
        amountPence: 1_500,
        recurring: true,
        period,
        incurredAt: isoDate(ms),
      });
    }
  }
  await db.insert(s.expenses).values(expenseRows);

  // ── rollups ─────────────────────────────────────────────────────────────
  // Populate metric_rollups so Metrics / Money / ROI aren't empty on first
  // load. The seed writes ~90 days of events in one shot, so there's no
  // incremental watermark to follow — force a full recompute over the demo org
  // (this also runs the anomaly detector, seeding a few insights).
  const rollup = await runRollups(db, { orgId: ORG_ID, force: true });

  // Health evaluation is NOT run inline here: the evaluator lives web-side
  // (apps/web/lib/server/health/evaluate.ts, which pulls in @azen/agents) and
  // @azen/db must not take a reverse dependency on the app. Instead the root
  // `seed:demo` script chains `health-run.ts` after this seed so a fresh DB
  // opens the Health Center with alert_instances that match the derived grid.

  // ── summary ───────────────────────────────────────────────────────────────
  console.log(`Org: Azen AI (${ORG_ID})`);
  console.log(`Owner: ${OWNER.email}`);
  console.log(`Clients: ${CLIENTS.length}, Projects: ${PROJECTS.length}\n`);
  console.log("Events per project:");
  for (const [slug, n] of Object.entries(perProjectCounts)) {
    console.log(`  ${slug.padEnd(30)} ${n}`);
  }
  console.log(`  ${"agency (calendly)".padEnd(30)} ${agencyInvitees.length}`);
  console.log(`  total: ${allRows.length}`);
  console.log(`\nBookings mirrored: ${bookingRows.length}`);
  console.log(
    `Feedback: ${feedbackItemRows.length} items (${Object.entries(feedbackCounts)
      .map(([slug, n]) => `${slug}:${n}`)
      .join(", ")})`,
  );
  console.log(`Payments: ${paymentRows.length}, Subscriptions: ${subscriptionRows.length}, Expenses: ${expenseRows.length}`);
  console.log(`Rollups: ${rollup.bucketsRecomputed} buckets across ${rollup.projects} projects, ${rollup.anomaliesCreated} anomalies`);
  console.log("\nDemo webhook keys (LOCAL DEMO ONLY):");
  for (const p of PROJECTS) {
    console.log(`  ${p.slug}`);
    console.log(`    public:  ${p.publicKey}`);
    console.log(`    secret:  ${p.demoSecret}`);
  }
  console.log("\nDone. Browse with: pnpm db:studio");
}

main()
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
