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
import { generateAgencyCalendlyDay, generateProjectDay } from "./generators";
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
  source: "sdk" | "calendly";
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
  source: "sdk" | "calendly",
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
      authMode: (p.stack === "ghl" ? "token" : "hmac") as "token" | "hmac",
      label: "demo key",
    })),
  );

  await db.insert(s.projectIntegrations).values([
    {
      orgId: ORG_ID,
      projectId: PROJECTS[2]!.id,
      provider: "ghl" as const,
      externalId: "loc_demo_elitetrades",
      config: { mapping: "ghl-default-v1" },
    },
  ]);

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
      stripeSubscriptionId: p.stack === "ghl" ? null : `sub_demo_${p.slug}`,
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
        source: p.stack === "ghl" ? "bank_transfer" : "stripe",
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
