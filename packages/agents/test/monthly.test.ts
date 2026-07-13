import { randomUUID } from "node:crypto";
import {
  bookings,
  clients,
  db,
  expenses,
  insights,
  payments,
  projects,
  subscriptions,
} from "@azen/db";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { MonthlyOutput } from "../src/agents/monthly";
import { buildAgencyMonthlyPack } from "../src/datapack/agency-monthly";
import {
  type AgentsHarness,
  cleanupHarness,
  createHarness,
  insertDayRollup,
} from "./helpers";

/**
 * Monthly Strategist tests (docs/phase5/CONTRACTS.md §P5-MONTHLY). getAnthropic
 * is MOCKED — no live API calls; a real throwaway-org DB backs every assertion.
 * We hand-build a complete London month (2026-05) with subscriptions that move
 * the MRR bridge, ROI/cost rollups, an active + a churned client, and a
 * dismissed insight, then assert:
 *   - buildAgencyMonthlyPack computes the MRR bridge (start/gained/lost/net/end)
 *     and per-project ROI/cost correctly vs hand-computed SQL;
 *   - the pack carries EVERY insight including dismissed (§9.3);
 *   - runMonthlyStrategist fans one output out to an owner brief + one client
 *     value report per ACTIVE client + one upsell dossier per active client,
 *     excluding the churned client and deduping repeated clientIds.
 */

const hoisted = vi.hoisted(() => ({ parseMock: vi.fn() }));

vi.mock("../src/anthropic", () => ({
  getAnthropic: () => ({ messages: { parse: hoisted.parseMock } }),
}));

import { runMonthlyStrategist } from "../src/agents/monthly";

const MONTH = "2026-05"; // a complete London month (BST → +1)

function parseResult(
  parsed: unknown,
  inTok = 6000,
  outTok = 2500,
): { parsed_output: unknown; usage: { input_tokens: number; output_tokens: number } } {
  return { parsed_output: parsed, usage: { input_tokens: inTok, output_tokens: outTok } };
}

let harness: AgentsHarness; // org + client A (active) + project P_A (live)
let clientAId: string;
let projectAId: string;
let clientBId: string;
let projectBId: string;
let clientCId: string;
let monthStartUTC: Date;

// Hand-computed MRR-bridge expectations for 2026-05:
//   baseline  £1,000  (client A) started 2026-03-01, active   → live at start & end
//   gained    £500    (client B) started 2026-05-10, active   → live at end only
//   lost      £300    (client A) started 2026-02-01, cancelled 2026-05-20 → live at start only
const BASELINE_PENCE = 100_000;
const GAINED_PENCE = 50_000;
const LOST_PENCE = 30_000;
const START_MRR = BASELINE_PENCE + LOST_PENCE; // 130_000 (both live at month start)
const END_MRR = BASELINE_PENCE + GAINED_PENCE; // 150_000 (active at month end)

const RETAINER_A = 100_000;
const REVENUE_ATTR = 200_000;
const MINUTES_SAVED = 600; // 10h → time value 10 × £30 = £300 = 30_000p
const RUN_COST = 5_000;
const HOSTING = 4_000;
const CASH_IN = 120_000;

async function insertSub(
  clientId: string,
  amount: number,
  status: "active" | "cancelled",
  startedAt: string,
  cancelledAt: string | null,
): Promise<void> {
  await db.insert(subscriptions).values({
    orgId: harness.orgId,
    clientId,
    amountPenceMonthly: amount,
    status,
    startedAt,
    cancelledAt,
  });
}

async function insertConversation(
  projectId: string,
  resolution: "resolved" | "escalated",
): Promise<void> {
  await db.$client`
    insert into events (id, org_id, project_id, type, source, idempotency_key, occurred_at, received_at, data, currency, raw)
    values (
      ${randomUUID()}::uuid, ${harness.orgId}::uuid, ${projectId}::uuid, 'llm.conversation', 'sdk',
      ${`test:${randomUUID()}`}, '2026-05-15T12:00:00Z'::timestamptz, '2026-05-15T12:00:00Z'::timestamptz,
      ${JSON.stringify({ channel: "webchat", topics: ["booking"], resolution, sentiment: "positive" })}::jsonb,
      'gbp', '{}'::jsonb
    )
  `;
}

async function insertMonthlyInsight(
  projectId: string,
  kind: "automation_opportunity" | "risk" | "faq_cluster",
  title: string,
  status: "new" | "dismissed",
  estimatedValuePence: number | null,
  evidence: Record<string, unknown> = {},
): Promise<void> {
  await db.insert(insights).values({
    orgId: harness.orgId,
    projectId,
    kind,
    title,
    bodyMd: title,
    evidence,
    confidence: "high",
    status,
    estimatedValuePence,
    createdBy: "agent",
  });
}

beforeAll(async () => {
  harness = await createHarness("Monthly Strategist Test");
  clientAId = harness.clientId;
  projectAId = harness.projectId;

  // The exact UTC instant of London 2026-05-01 (mirrors resolveMonthStartUTC).
  const rows = (await db.$client`
    select to_char(
      ((('2026-05-01'::date)::timestamp at time zone 'Europe/London') at time zone 'UTC'),
      'YYYY-MM-DD"T"HH24:MI:SS"Z"'
    ) as iso
  `) as unknown as { iso: string }[];
  monthStartUTC = new Date(rows[0]!.iso);

  // Give project A a retainer so ROI/margin have a denominator.
  await db.$client`
    update projects set retainer_pence_monthly = ${RETAINER_A} where id = ${projectAId}::uuid
  `;

  // Client B (active) + project P_B (live).
  clientBId = randomUUID();
  projectBId = randomUUID();
  await db.insert(clients).values({
    id: clientBId,
    orgId: harness.orgId,
    name: "Beta Client",
    status: "active",
  });
  await db.insert(projects).values({
    id: projectBId,
    orgId: harness.orgId,
    clientId: clientBId,
    name: "Beta Project",
    slug: `agents-test-${randomUUID()}`,
    type: "automation",
    stack: "custom_code",
    status: "live",
    health: "green",
  });

  // Client C (CHURNED) + a live project — must NOT get a per-client report.
  clientCId = randomUUID();
  await db.insert(clients).values({
    id: clientCId,
    orgId: harness.orgId,
    name: "Gamma Client",
    status: "churned",
  });
  await db.insert(projects).values({
    id: randomUUID(),
    orgId: harness.orgId,
    clientId: clientCId,
    name: "Gamma Project",
    slug: `agents-test-${randomUUID()}`,
    type: "automation",
    stack: "custom_code",
    status: "live",
    health: "amber",
  });

  // ── MRR bridge subs ──────────────────────────────────────────────────────
  await insertSub(clientAId, BASELINE_PENCE, "active", "2026-03-01", null);
  await insertSub(clientBId, GAINED_PENCE, "active", "2026-05-10", null);
  await insertSub(clientAId, LOST_PENCE, "cancelled", "2026-02-01", "2026-05-20");

  // ── ROI / cost rollups for project A inside the May window ────────────────
  await insertDayRollup(harness.orgId, projectAId, "revenue_attributed", "2026-05-15T12:00:00Z", REVENUE_ATTR);
  await insertDayRollup(harness.orgId, projectAId, "minutes_saved", "2026-05-15T12:00:00Z", MINUTES_SAVED);
  await insertDayRollup(harness.orgId, projectAId, "tokens_cost_pence", "2026-05-15T12:00:00Z", RUN_COST);

  // Hosting expense (project-scoped) + a paid agency payment, both in May.
  await db.insert(expenses).values({
    orgId: harness.orgId,
    projectId: projectAId,
    category: "hosting",
    vendor: "Vercel",
    amountPence: HOSTING,
    recurring: true,
    period: MONTH,
    incurredAt: "2026-05-01",
  });
  await db.insert(payments).values({
    orgId: harness.orgId,
    clientId: clientAId,
    projectId: projectAId,
    source: "bank_transfer",
    kind: "retainer",
    amountPence: CASH_IN,
    status: "paid",
    paidAt: new Date("2026-05-15T12:00:00Z"),
  });

  // Two conversations for project A (1 resolved) + a client-end booking.
  await insertConversation(projectAId, "resolved");
  await insertConversation(projectAId, "escalated");
  await db.insert(bookings).values({
    orgId: harness.orgId,
    clientId: clientAId,
    projectId: projectAId,
    source: "client_system",
    kind: "client_end_customer",
    startsAt: new Date("2026-05-16T10:00:00Z"),
    status: "scheduled",
  });

  // Insights: one live opportunity (feeds the dossier) + one DISMISSED (§9.3).
  await insertMonthlyInsight(projectAId, "automation_opportunity", "Automate quotes", "new", 250_000);
  await insertMonthlyInsight(projectAId, "risk", "Ignored risk", "dismissed", null);
});

afterEach(async () => {
  hoisted.parseMock.mockReset();
  await db.$client`delete from briefs where org_id = ${harness.orgId}::uuid`;
  await db.$client`delete from agent_runs where org_id = ${harness.orgId}::uuid`;
});

afterAll(async () => {
  // Tables cleanupHarness does not cover (FK order: children before parents).
  await db.$client`delete from briefs where org_id = ${harness.orgId}::uuid`;
  await db.$client`delete from payments where org_id = ${harness.orgId}::uuid`;
  await db.$client`delete from expenses where org_id = ${harness.orgId}::uuid`;
  await cleanupHarness(harness);
});

function sampleOutput(): MonthlyOutput {
  return {
    owner_report: {
      headline: "May closed at £1,500 MRR, up £200 net on the month",
      summary_md: "MRR reached £1,500.00, £200 net up.\n\nCash in £1,200.00.",
      portfolio_health_md: "Alpha green; margin healthy.",
      roi_deep_dive_md: "Alpha returned 2.19× on retainer + run cost.",
      mrr_bridge_md: "£1,300 → +£500 −£300 → £1,500.",
      time_allocation_md: "AI spend concentrated on Alpha.",
      recommendations: ["Ship the quote automation for Acme.", "Watch Gamma churn."],
      whatsapp_text: "May: £1,500 MRR, +£200 net. Acme quote automation is the next win.",
    },
    // Includes churned C (must be dropped) + a DUPLICATE A (must be deduped).
    client_reports: [
      { clientId: clientAId, headline: "Acme: 2.19× ROI in May", body_md: "You saved 10 hours." },
      { clientId: clientBId, headline: "Beta: onboarded in May", body_md: "Welcome aboard." },
      { clientId: clientCId, headline: "Gamma", body_md: "Should be dropped." },
      { clientId: clientAId, headline: "Acme duplicate", body_md: "Should be deduped." },
    ],
    upsell_dossiers: [
      {
        clientId: clientAId,
        headline: "Automate quotes for Acme",
        opportunities: [
          {
            title: "Automate quotes",
            rationale_md: "Pricing conversations escalate.",
            estimated_value_note: "£2,500/mo",
          },
        ],
        summary_md: "One strong opportunity.",
      },
      {
        clientId: clientBId,
        headline: "Nothing yet for Beta",
        opportunities: [],
        summary_md: "No opportunities on file.",
      },
      { clientId: clientCId, headline: "Gamma", opportunities: [], summary_md: "Dropped." },
    ],
  };
}

describe("buildAgencyMonthlyPack — deterministic numbers", () => {
  it("computes the MRR bridge (start/gained/lost/net/end) correctly vs SQL", async () => {
    const pack = await buildAgencyMonthlyPack(db, harness.orgId, monthStartUTC);

    expect(pack.forMonth).toBe(MONTH);
    const b = pack.mrrBridge;
    expect(b.startPence).toBe(START_MRR); // 130_000
    expect(b.gainedPence).toBe(GAINED_PENCE); // 50_000
    expect(b.lostPence).toBe(LOST_PENCE); // 30_000
    expect(b.netPence).toBe(GAINED_PENCE - LOST_PENCE); // 20_000
    expect(b.endPence).toBe(END_MRR); // 150_000
    // The bridge reconciles: end = start + gained − lost = endDirect.
    expect(b.endPence).toBe(b.startPence + b.gainedPence - b.lostPence);
    expect(b.endDirectPence).toBe(END_MRR);
    // Gained names Beta; lost names Acme.
    expect(b.gained.map((g) => g.clientName)).toEqual(["Beta Client"]);
    expect(b.lost.map((l) => l.clientName)).toEqual(["Acme Client"]);
    // MRR headline = Σ active subs = baseline + gained (cancelled excluded).
    expect(pack.agency.mrrPence).toBe(END_MRR);
  });

  it("includes EVERY insight, dismissed ones surfaced separately (§9.3)", async () => {
    const pack = await buildAgencyMonthlyPack(db, harness.orgId, monthStartUTC);

    const titles = pack.insights.map((i) => i.title).sort();
    expect(titles).toEqual(["Automate quotes", "Ignored risk"]);
    expect(pack.insightStatusCounts["new"]).toBe(1);
    expect(pack.insightStatusCounts["dismissed"]).toBe(1);
    expect(pack.dismissedInsights.map((i) => i.title)).toEqual(["Ignored risk"]);
  });

  it("reproduces per-project ROI + cost + value over the month window", async () => {
    const pack = await buildAgencyMonthlyPack(db, harness.orgId, monthStartUTC);
    const alpha = pack.projects.find((p) => p.id === projectAId)!;

    // ROI: revenue 200_000 + time value (600min/60 × £30 = 30_000) over
    // retainer 100_000 + run cost 5_000 = 230_000 / 105_000 = 2.19.
    expect(alpha.roi.revenueAttributedPence).toBe(REVENUE_ATTR);
    expect(alpha.roi.minutesSaved).toBe(MINUTES_SAVED);
    expect(alpha.roi.timeValuePence).toBe(30_000);
    expect(alpha.roi.retainerPence).toBe(RETAINER_A);
    expect(alpha.roi.runCostPence).toBe(RUN_COST);
    expect(alpha.roi.roiMultiple).toBe(2.19);

    // Cost: ai 5_000 + os 0 + hosting 4_000 = 9_000; margin = 100_000 − 9_000.
    expect(alpha.cost.clientSystemAiPence).toBe(RUN_COST);
    expect(alpha.cost.osAgentPence).toBe(0);
    expect(alpha.cost.hostingPence).toBe(HOSTING);
    expect(alpha.cost.totalCostPence).toBe(RUN_COST + HOSTING);
    expect(alpha.cost.marginPence).toBe(RETAINER_A - RUN_COST - HOSTING);

    // Value: 1 booking, 2 conversations (1 resolved → 0.5), 10 hours saved.
    expect(alpha.value.bookingsMade).toBe(1);
    expect(alpha.value.conversationsHandled).toBe(2);
    expect(alpha.value.resolvedRate).toBe(0.5);
    expect(alpha.value.hoursSaved).toBe(10);

    // Agency money picture.
    expect(pack.agency.cashInPence).toBe(CASH_IN);
    expect(pack.agency.cashOutPence).toBe(HOSTING);
    expect(pack.agency.netPence).toBe(CASH_IN - HOSTING);
  });

  it("seeds the active client's dossier from live opportunities only", async () => {
    const pack = await buildAgencyMonthlyPack(db, harness.orgId, monthStartUTC);
    const acme = pack.clients.find((c) => c.clientId === clientAId)!;
    expect(acme.status).toBe("active");
    expect(acme.representativeProjectId).toBe(projectAId);
    // The dismissed risk is excluded; the live opportunity seeds the dossier.
    expect(acme.topOpportunities.map((o) => o.title)).toEqual(["Automate quotes"]);
  });
});

describe("runMonthlyStrategist — three-document fan-out", () => {
  it("writes an owner report + one value report + one dossier per ACTIVE client", async () => {
    hoisted.parseMock.mockResolvedValueOnce(parseResult(sampleOutput()));

    const res = await runMonthlyStrategist(db, {
      orgId: harness.orgId,
      monthStart: MONTH,
      deliver: true,
      dryRun: true,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error);
    expect(hoisted.parseMock).toHaveBeenCalledTimes(1);
    expect(res.forMonth).toBe(MONTH);
    expect(res.tokensIn).toBe(6000);
    expect(res.tokensOut).toBe(2500);

    // Active clients A + B → 2 value reports + 2 dossiers; churned C dropped;
    // the duplicate A client_report is deduped.
    const reportClients = res.clientReports.map((r) => r.clientId).sort();
    expect(reportClients).toEqual([clientAId, clientBId].sort());
    const dossierClients = res.upsellDossiers.map((r) => r.clientId).sort();
    expect(dossierClients).toEqual([clientAId, clientBId].sort());

    // Owner brief: agency / monthly, delivered in dry-run (no send).
    const owner = await loadBrief(res.ownerBriefId);
    expect(owner.scope).toBe("agency");
    expect(owner.period).toBe("monthly");
    expect(owner.status).toBe("generated");
    expect(owner.data_snapshot["docType"]).toBe("owner_report");
    expect(res.delivered?.dryRun).toBe(true);

    // A client value report: scope project, hung on the representative project,
    // with the client marker in data_snapshot; internal draft (no whatsapp).
    const acmeRef = res.clientReports.find((r) => r.clientId === clientAId)!;
    expect(acmeRef.projectId).toBe(projectAId);
    const acmeBrief = await loadBrief(acmeRef.briefId);
    expect(acmeBrief.scope).toBe("project");
    expect(acmeBrief.data_snapshot["docType"]).toBe("client_value_report");
    expect(acmeBrief.data_snapshot["clientId"]).toBe(clientAId);
    expect(acmeBrief.body_whatsapp).toBeNull();

    // A dossier carries the docType marker for Phase 6's Upsell Engine.
    const dossierRef = res.upsellDossiers.find((r) => r.clientId === clientAId)!;
    const dossierBrief = await loadBrief(dossierRef.briefId);
    expect(dossierBrief.data_snapshot["docType"]).toBe("upsell_dossier");

    // Total briefs written = 1 owner + 2 value + 2 dossiers = 5.
    const total = (await db.$client`
      select count(*)::int as n from briefs where org_id = ${harness.orgId}::uuid
    `) as unknown as { n: number }[];
    expect(total[0]!.n).toBe(5);
  });

  it("surfaces the error and writes NO briefs when structured output stays null", async () => {
    hoisted.parseMock
      .mockResolvedValueOnce(parseResult(null))
      .mockResolvedValueOnce(parseResult(null));

    const res = await runMonthlyStrategist(db, {
      orgId: harness.orgId,
      monthStart: MONTH,
      deliver: true,
      dryRun: true,
    });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected failure");
    expect(res.error).toBe("parse_failed");
    const total = (await db.$client`
      select count(*)::int as n from briefs where org_id = ${harness.orgId}::uuid
    `) as unknown as { n: number }[];
    expect(total[0]!.n).toBe(0);
  });
});

interface BriefRow {
  id: string;
  scope: string;
  period: string;
  status: string;
  headline: string;
  body_whatsapp: string | null;
  data_snapshot: Record<string, unknown>;
}

async function loadBrief(briefId: string): Promise<BriefRow> {
  const rows = (await db.$client`
    select id::text as id, scope::text as scope, period::text as period,
      status::text as status, headline, body_whatsapp, data_snapshot
    from briefs where id = ${briefId}::uuid limit 1
  `) as unknown as BriefRow[];
  return rows[0]!;
}
