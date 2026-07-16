import { randomUUID } from "node:crypto";
import { db } from "@azen/db";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { WeeklyPack } from "../src/datapack/agency-weekly";
import type { WeeklyOutput } from "../src/agents/weekly";
import {
  type AgentsHarness,
  cleanupHarness,
  createHarness,
  insertFeedbackItem,
} from "./helpers";

/**
 * runWeeklySynth tests (docs/phase5/CONTRACTS.md §P5-WEEKLY). getAnthropic is
 * MOCKED — no live API calls; a real throwaway-org DB backs the briefs +
 * dataSnapshot assertions. We hand-build a target week (two Mondays ago) of
 * events / payments / daily briefs plus the prior weekly edition, then assert:
 * a `briefs` row (period 'weekly') is written with the deterministic pack as its
 * data_snapshot, the scoreboard numbers match the hand-built events, and the run
 * references the prior weekly edition when one exists.
 */

const hoisted = vi.hoisted(() => ({ parseMock: vi.fn() }));

vi.mock("../src/anthropic", () => ({
  getAnthropic: () => ({ messages: { parse: hoisted.parseMock } }),
}));

import { buildAgencyWeeklyPack } from "../src/datapack/agency-weekly";
import { runWeeklySynth } from "../src/agents/weekly";

function parseResult(
  parsed: unknown,
  inTok = 5000,
  outTok = 1200,
): { parsed_output: unknown; usage: { input_tokens: number; output_tokens: number } } {
  return { parsed_output: parsed, usage: { input_tokens: inTok, output_tokens: outTok } };
}

function sampleOutput(): WeeklyOutput {
  return {
    headline: "Revenue up on a strong booking week",
    agency_narrative_md: "The week held steady with revenue ahead of last week.",
    projects: [
      { name: "Alpha Project", wow_narrative_md: "Alpha booked more this week than last." },
    ],
    scoreboard: [
      { kpi: "Revenue", this_week: 5000, last_week: 1000, four_wk_avg: 250, trend: "up" },
    ],
    top_priorities: ["Chase the overdue retainer", "Automate pricing", "Rescue red projects"],
    whatsapp_text: "Solid week: revenue £50.00, up on last week. Chase the overdue retainer today.",
  };
}

// ── absolute London-day helpers (independent of what weekday 'now' is) ────────

interface DayLabels {
  targetMon: string; // Monday of the summarised week (2 weeks ago)
  targetWed: string; // a mid-week day in the summarised week
  lastWed: string; // a day in the week BEFORE the summarised week
  priorMon: string; // Monday of the prior week (prior weekly edition's start)
  targetMonIso: string; // UTC instant of the target Monday (London week start)
}

async function resolveDayLabels(): Promise<DayLabels> {
  const rows = (await db.$client`
    with base as (
      select date_trunc('week', now() at time zone 'Europe/London') - interval '14 days' as target_mon
    )
    select
      to_char(target_mon, 'YYYY-MM-DD') as target_mon,
      to_char(target_mon + interval '2 days', 'YYYY-MM-DD') as target_wed,
      to_char(target_mon - interval '5 days', 'YYYY-MM-DD') as last_wed,
      to_char(target_mon - interval '7 days', 'YYYY-MM-DD') as prior_mon,
      to_char((target_mon at time zone 'Europe/London') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as target_mon_iso
    from base
  `) as unknown as {
    target_mon: string;
    target_wed: string;
    last_wed: string;
    prior_mon: string;
    target_mon_iso: string;
  }[];
  const r = rows[0]!;
  return {
    targetMon: r.target_mon,
    targetWed: r.target_wed,
    lastWed: r.last_wed,
    priorMon: r.prior_mon,
    targetMonIso: r.target_mon_iso,
  };
}

/** noon UTC of a London day (bucket-safe in both GMT and BST). */
function noonUtc(day: string): Date {
  return new Date(`${day}T12:00:00Z`);
}

async function insertEvent(
  orgId: string,
  projectId: string,
  ev: {
    type: string;
    day: string;
    valuePence?: number;
    minutesSaved?: number;
    data?: Record<string, unknown>;
  },
): Promise<void> {
  const at = noonUtc(ev.day).toISOString();
  const id = randomUUID();
  await db.$client`
    insert into events (id, org_id, project_id, type, source, idempotency_key, occurred_at, received_at, data, value_pence, minutes_saved, currency, raw)
    values (
      ${id}::uuid, ${orgId}::uuid, ${projectId}::uuid, ${ev.type}, 'sdk',
      ${`test:${id}`}, ${at}::timestamptz, ${at}::timestamptz,
      ${JSON.stringify(ev.data ?? {})}::jsonb,
      ${ev.valuePence ?? null}, ${ev.minutesSaved ?? null}, 'gbp', '{}'::jsonb
    )
  `;
}

async function insertDailyBrief(
  orgId: string,
  day: string,
  headline: string,
  needs: string[],
): Promise<void> {
  const at = noonUtc(day).toISOString();
  const bodyMd = [
    `# ${headline}`,
    "",
    "Some agency summary.",
    "",
    "## Needs attention",
    ...needs.map((n) => `- ${n}`),
  ].join("\n");
  await db.$client`
    insert into briefs (id, org_id, scope, project_id, period, period_start, headline, body_md, data_snapshot, status)
    values (
      ${randomUUID()}::uuid, ${orgId}::uuid, 'agency', null, 'daily',
      ${at}::timestamptz, ${headline}, ${bodyMd}, '{}'::jsonb, 'generated'
    )
  `;
}

async function insertWeeklyBrief(
  orgId: string,
  day: string,
  headline: string,
): Promise<void> {
  const at = noonUtc(day).toISOString();
  await db.$client`
    insert into briefs (id, org_id, scope, project_id, period, period_start, headline, body_md, data_snapshot, status)
    values (
      ${randomUUID()}::uuid, ${orgId}::uuid, 'agency', null, 'weekly',
      ${at}::timestamptz, ${headline}, ${`# ${headline}\n\nLast week's narrative.`}, '{}'::jsonb, 'generated'
    )
  `;
}

async function insertPayment(
  orgId: string,
  clientId: string,
  amountPence: number,
  day: string,
): Promise<void> {
  const at = noonUtc(day).toISOString();
  await db.$client`
    insert into payments (id, org_id, client_id, source, kind, amount_pence, currency, status, paid_at)
    values (
      ${randomUUID()}::uuid, ${orgId}::uuid, ${clientId}::uuid, 'bank_transfer', 'retainer',
      ${amountPence}, 'gbp', 'paid', ${at}::timestamptz
    )
  `;
}

async function insertActiveSub(
  orgId: string,
  clientId: string,
  amountPenceMonthly: number,
  startedAt: string,
): Promise<void> {
  await db.$client`
    insert into subscriptions (id, org_id, client_id, amount_pence_monthly, status, started_at)
    values (
      ${randomUUID()}::uuid, ${orgId}::uuid, ${clientId}::uuid, ${amountPenceMonthly}, 'active', ${startedAt}::date
    )
  `;
}

interface StoredBrief {
  id: string;
  scope: string;
  period: string;
  headline: string;
  body_whatsapp: string | null;
  data_snapshot: WeeklyPack;
  status: string;
}

const SAMPLE_HEADLINE = "Revenue up on a strong booking week";

/** Load the weekly brief this run produced (by its sample headline). */
async function loadWeeklyBrief(orgId: string): Promise<StoredBrief | undefined> {
  const rows = (await db.$client`
    select id::text as id, scope::text as scope, period::text as period, headline,
      body_whatsapp, data_snapshot, status::text as status
    from briefs
    where org_id = ${orgId}::uuid and period = 'weekly' and headline = ${SAMPLE_HEADLINE}
    order by created_at desc
    limit 1
  `) as unknown as StoredBrief[];
  return rows[0];
}

let harness: AgentsHarness;
let days: DayLabels;

beforeAll(async () => {
  harness = await createHarness("Weekly Synth Test");
  days = await resolveDayLabels();

  // THIS week (target): revenue 5000p, 30 mins, 2 conversations, 1 error.
  await insertEvent(harness.orgId, harness.projectId, {
    type: "custom.metric",
    day: days.targetWed,
    valuePence: 3000,
    minutesSaved: 20,
  });
  await insertEvent(harness.orgId, harness.projectId, {
    type: "custom.metric",
    day: days.targetMon,
    valuePence: 2000,
    minutesSaved: 10,
  });
  await insertEvent(harness.orgId, harness.projectId, {
    type: "llm.conversation",
    day: days.targetWed,
    data: { topics: ["booking"], resolution: "resolved", sentiment: "positive" },
  });
  await insertEvent(harness.orgId, harness.projectId, {
    type: "llm.conversation",
    day: days.targetMon,
    data: { topics: ["pricing"], resolution: "escalated", sentiment: "neutral" },
  });
  await insertEvent(harness.orgId, harness.projectId, {
    type: "system.error",
    day: days.targetWed,
  });

  // LAST week (the week before target): revenue 1000p, 1 conversation.
  await insertEvent(harness.orgId, harness.projectId, {
    type: "custom.metric",
    day: days.lastWed,
    valuePence: 1000,
    minutesSaved: 5,
  });
  await insertEvent(harness.orgId, harness.projectId, {
    type: "llm.conversation",
    day: days.lastWed,
    data: { topics: ["booking"], resolution: "resolved", sentiment: "positive" },
  });

  // Daily briefs within the target week.
  await insertDailyBrief(harness.orgId, days.targetMon, "Monday: quiet start", [
    "Alpha silent since Friday",
  ]);
  await insertDailyBrief(harness.orgId, days.targetWed, "Wednesday: bookings picked up", [
    "Pricing escalations rising",
  ]);

  // Prior weekly edition (starts the week before target) — the memory anchor.
  await insertWeeklyBrief(harness.orgId, days.priorMon, "Prior week: MRR flat");

  // Feedback (Phase 7 §B3): THIS week 2 bug + 1 feature; LAST week 1 bug —
  // both counts trend "up" (this/last ratio > 1.05).
  await insertFeedbackItem(harness.orgId, harness.projectId, {
    kind: "bug",
    message: "Crashes on save",
    severity: 3,
    createdAt: noonUtc(days.targetMon),
  });
  await insertFeedbackItem(harness.orgId, harness.projectId, {
    kind: "bug",
    message: "Slow to load",
    severity: 1,
    createdAt: noonUtc(days.targetWed),
  });
  await insertFeedbackItem(harness.orgId, harness.projectId, {
    kind: "feature",
    message: "Add CSV export",
    severity: null,
    createdAt: noonUtc(days.targetWed),
  });
  await insertFeedbackItem(harness.orgId, harness.projectId, {
    kind: "bug",
    message: "Old bug from last week",
    severity: 2,
    createdAt: noonUtc(days.lastWed),
  });

  // Money: MRR + a payment collected this week and one last week.
  await insertActiveSub(harness.orgId, harness.clientId, 50000, days.priorMon);
  await insertPayment(harness.orgId, harness.clientId, 50000, days.targetWed);
  await insertPayment(harness.orgId, harness.clientId, 40000, days.lastWed);
});

afterEach(() => {
  hoisted.parseMock.mockReset();
});

afterAll(async () => {
  // cleanupHarness does not clear briefs/payments — remove them first so the
  // org FK deletes cleanly.
  await db.$client`delete from briefs where org_id = ${harness.orgId}::uuid`;
  await db.$client`delete from payments where org_id = ${harness.orgId}::uuid`;
  await cleanupHarness(harness);
});

describe("buildAgencyWeeklyPack — deterministic numbers vs SQL", () => {
  it("computes the scoreboard, daily briefs, money and prior edition", async () => {
    const pack = await buildAgencyWeeklyPack(
      db,
      harness.orgId,
      new Date(days.targetMonIso),
    );

    expect(pack.weekStart).toBe(days.targetMon);

    const revenue = pack.scoreboard.find((s) => s.key === "revenue")!;
    expect(revenue.thisWeek).toBe(5000);
    expect(revenue.lastWeek).toBe(1000);
    expect(revenue.trend).toBe("up");

    const conversations = pack.scoreboard.find((s) => s.key === "conversations")!;
    expect(conversations.thisWeek).toBe(2);
    expect(conversations.lastWeek).toBe(1);

    const minutes = pack.scoreboard.find((s) => s.key === "minutes_saved")!;
    expect(minutes.thisWeek).toBe(30);

    const errors = pack.scoreboard.find((s) => s.key === "errors")!;
    expect(errors.thisWeek).toBe(1);

    // Two daily briefs in the window, attention bullets parsed from body markdown.
    expect(pack.dailyBriefs.length).toBe(2);
    expect(pack.dailyBriefs[0]!.needsAttention).toContain("Alpha silent since Friday");

    // Money: collected this vs last week, current MRR, MRR started this week.
    expect(pack.money.collectedThisWeekPence).toBe(50000);
    expect(pack.money.collectedLastWeekPence).toBe(40000);
    expect(pack.money.currentMrrPence).toBe(50000);

    // Feedback: this week 2 bug + 1 feature vs last week 1 bug — both up.
    const bugRow = pack.feedback.byKind.find((k) => k.kind === "bug")!;
    expect(bugRow.thisWeek).toBe(2);
    expect(bugRow.lastWeek).toBe(1);
    expect(bugRow.trend).toBe("up");
    const featureRow = pack.feedback.byKind.find((k) => k.kind === "feature")!;
    expect(featureRow.thisWeek).toBe(1);
    expect(featureRow.lastWeek).toBe(0);
    expect(featureRow.trend).toBe("up");
    // Kinds with no activity either week still appear, zeroed, in canonical order.
    expect(pack.feedback.byKind.map((k) => k.kind)).toEqual([
      "bug",
      "feature",
      "question",
      "praise",
      "other",
    ]);
    const questionRow = pack.feedback.byKind.find((k) => k.kind === "question")!;
    expect(questionRow.thisWeek).toBe(0);
    expect(questionRow.lastWeek).toBe(0);
    expect(questionRow.trend).toBe("flat");
    expect(pack.feedback.totalThisWeek).toBe(3);
    expect(pack.feedback.totalLastWeek).toBe(1);
    expect(pack.feedback.trend).toBe("up");

    // Prior weekly edition folded in.
    expect(pack.priorEdition).not.toBeNull();
    expect(pack.priorEdition!.headline).toBe("Prior week: MRR flat");
    expect(pack.priorEdition!.weekStart).toBe(days.priorMon);
  });
});

describe("runWeeklySynth — brief row + delivery + prior edition", () => {
  it("writes a weekly briefs row with the pack as its data_snapshot", async () => {
    hoisted.parseMock.mockResolvedValueOnce(parseResult(sampleOutput()));

    const res = await runWeeklySynth(db, {
      orgId: harness.orgId,
      weekStart: days.targetWed, // any in-week day snaps to the Monday
      deliver: true,
      dryRun: true,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error);
    expect(hoisted.parseMock).toHaveBeenCalledTimes(1);
    expect(res.weekStart).toBe(days.targetMon);
    expect(res.referencedPriorEdition).toBe(true);
    expect(res.tokensIn).toBe(5000);
    expect(res.tokensOut).toBe(1200);
    // dry-run delivery returns typed per-channel results, no network.
    expect(res.delivered).not.toBeNull();
    expect(res.delivered!.dryRun).toBe(true);

    const brief = await loadWeeklyBrief(harness.orgId);
    expect(brief).toBeDefined();
    expect(brief!.scope).toBe("agency");
    expect(brief!.period).toBe("weekly");
    expect(brief!.headline).toBe("Revenue up on a strong booking week");

    // The stored data_snapshot is the deterministic pack (auditability).
    const snap = brief!.data_snapshot;
    const revenue = snap.scoreboard.find((s) => s.key === "revenue")!;
    expect(revenue.thisWeek).toBe(5000);
    expect(snap.priorEdition).not.toBeNull();
    expect(snap.priorEdition!.headline).toBe("Prior week: MRR flat");

    await db.$client`delete from briefs where org_id = ${harness.orgId}::uuid and period = 'weekly' and headline = 'Revenue up on a strong booking week'`;
    await db.$client`delete from agent_runs where org_id = ${harness.orgId}::uuid`;
  });

  it("clamps an over-long whatsapp_text to 900 chars", async () => {
    const out = sampleOutput();
    out.whatsapp_text = "x".repeat(1200);
    hoisted.parseMock.mockResolvedValueOnce(parseResult(out));

    const res = await runWeeklySynth(db, {
      orgId: harness.orgId,
      weekStart: days.targetMon,
      deliver: false,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error);

    const brief = await loadWeeklyBrief(harness.orgId);
    expect((brief!.body_whatsapp ?? "").length).toBeLessThanOrEqual(900);

    await db.$client`delete from briefs where org_id = ${harness.orgId}::uuid and period = 'weekly' and headline = 'Revenue up on a strong booking week'`;
    await db.$client`delete from agent_runs where org_id = ${harness.orgId}::uuid`;
  });

  it("writes nothing and returns a typed error when the model call fails", async () => {
    hoisted.parseMock.mockRejectedValueOnce(new Error("ANTHROPIC_API_KEY missing"));

    const res = await runWeeklySynth(db, {
      orgId: harness.orgId,
      weekStart: days.targetMon,
      deliver: false,
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected failure");
    expect(res.error).toBe("anthropic_auth");

    const brief = await loadWeeklyBrief(harness.orgId);
    expect(brief).toBeUndefined();

    await db.$client`delete from agent_runs where org_id = ${harness.orgId}::uuid`;
  });
});
