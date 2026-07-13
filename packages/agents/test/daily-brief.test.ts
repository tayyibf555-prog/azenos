import { randomUUID } from "node:crypto";
import { db, users } from "@azen/db";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { DailyBriefOutput } from "../src/agents/daily-brief";
import {
  cleanupHarness,
  createHarness,
  insertActiveSubscription,
  insertDayRollup,
  insertEvent,
  insertInsight,
  insertKpiDef,
  londonDayStartsUTC,
  type AgentsHarness,
} from "./helpers";

/**
 * runDailyBrief pipeline tests (docs/phase3/CONTRACTS.md §P3-BRIEF). getAnthropic
 * is MOCKED — no live API calls; a real throwaway-org DB backs the briefs +
 * agent_runs assertions. The deterministic data pack is proven separately in
 * datapack.test.ts, so here we assert the AGENT wiring: a briefs row with
 * dataSnapshot = the pack, tokens logged, whatsapp ≤900, dry-run sends nothing,
 * and a parse failure leaves NO half-written brief.
 */

const hoisted = vi.hoisted(() => ({ parseMock: vi.fn() }));

vi.mock("../src/anthropic", () => ({
  getAnthropic: () => ({ messages: { parse: hoisted.parseMock } }),
}));

import { runDailyBrief } from "../src/agents/daily-brief";

const MRR_PENCE = 150_000;

function parseResult(
  parsed: unknown,
  inTok = 5000,
  outTok = 1200,
): { parsed_output: unknown; usage: { input_tokens: number; output_tokens: number } } {
  return {
    parsed_output: parsed,
    usage: { input_tokens: inTok, output_tokens: outTok },
  };
}

function sampleOutput(overrides: Partial<DailyBriefOutput> = {}): DailyBriefOutput {
  return {
    headline: "Revenue £1,500.00 yesterday, up 20% on the weekly norm",
    agency_summary_md:
      "MRR holds at £1,500.00 across active clients.\n\nRevenue landed £1,500.00, ahead of the 7-day average.",
    projects: [
      {
        name: "Alpha Project",
        paragraph_md: "Steady throughput; conversions in line with the week.",
        collapsed: false,
      },
    ],
    needs_attention: ["Alpha Project has one open anomaly on conversions."],
    wins: ["£1,500.00 revenue, the best single day this week."],
    whatsapp_text: "Good morning — £1,500 in yesterday, up 20% on the weekly norm. One anomaly on Alpha to glance at.",
    ...overrides,
  };
}

async function countBriefs(orgId: string): Promise<number> {
  const rows = (await db.$client`
    select count(*)::int as n from briefs where org_id = ${orgId}::uuid
  `) as unknown as { n: number }[];
  return rows[0]!.n;
}

interface BriefRow {
  id: string;
  scope: string;
  period: string;
  status: string;
  headline: string;
  body_md: string;
  body_whatsapp: string | null;
  data_snapshot: Record<string, unknown>;
  tokens_in: number | null;
  tokens_out: number | null;
  model: string | null;
  sent_email_at: string | null;
}

async function loadBrief(orgId: string): Promise<BriefRow> {
  const rows = (await db.$client`
    select id::text as id, scope::text as scope, period::text as period,
      status::text as status, headline, body_md, body_whatsapp, data_snapshot,
      tokens_in, tokens_out, model, sent_email_at
    from briefs where org_id = ${orgId}::uuid order by created_at desc limit 1
  `) as unknown as BriefRow[];
  return rows[0]!;
}

let harness: AgentsHarness;
let userId: string;

beforeAll(async () => {
  harness = await createHarness("Daily Brief Test");

  // Agency money + one KPI with a couple of day-rollups so the pack has content.
  await insertActiveSubscription(harness.orgId, harness.clientId, MRR_PENCE);
  await insertKpiDef(harness.orgId, {
    key: "conversions",
    name: "Conversions",
    unit: "count",
    goodDirection: "up",
    projectId: null,
  });
  const days = await londonDayStartsUTC(3); // [yesterday, -2, -3]
  await insertDayRollup(harness.orgId, harness.projectId, "conversions", days[0]!, 12);
  await insertDayRollup(harness.orgId, harness.projectId, "conversions", days[1]!, 10);
  await insertDayRollup(harness.orgId, harness.projectId, "conversions", days[2]!, 10);

  // A revenue event that lands inside yesterday's London day.
  const yesterdayNoon = new Date(new Date(days[0]!).getTime() + 12 * 3600 * 1000);
  await insertEvent(harness.orgId, harness.projectId, {
    type: "custom.sale",
    occurredAt: yesterdayNoon,
    valuePence: MRR_PENCE,
  });

  await insertInsight(harness.orgId, harness.projectId, {
    kind: "anomaly",
    title: "Conversions above 7-day norm",
    metricKey: "conversions",
  });

  // Owner user with notification prefs: email on (to a fixed address),
  // WhatsApp explicitly off — exercises resolveDeliverPrefs + email payload.
  userId = randomUUID();
  await db.insert(users).values({
    id: userId,
    orgId: harness.orgId,
    name: "Owner",
    email: "owner@test.example",
    role: "owner",
    notificationPrefs: {
      email: { to: "brief@test.example" },
      whatsapp: { enabled: false },
    },
  });
});

afterEach(async () => {
  hoisted.parseMock.mockReset();
  await db.$client`delete from briefs where org_id = ${harness.orgId}::uuid`;
  await db.$client`delete from agent_runs where org_id = ${harness.orgId}::uuid`;
});

afterAll(async () => {
  await db.$client`delete from briefs where org_id = ${harness.orgId}::uuid`;
  await db.$client`delete from users where org_id = ${harness.orgId}::uuid`;
  await cleanupHarness(harness);
});

describe("runDailyBrief — generation + dry-run delivery", () => {
  it("persists a briefs row with dataSnapshot = the pack, tokens, and status generated", async () => {
    hoisted.parseMock.mockResolvedValueOnce(parseResult(sampleOutput()));

    const res = await runDailyBrief(db, {
      orgId: harness.orgId,
      deliver: true,
      dryRun: true,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error);
    expect(hoisted.parseMock).toHaveBeenCalledTimes(1);
    expect(res.tokensIn).toBe(5000);
    expect(res.tokensOut).toBe(1200);

    const brief = await loadBrief(harness.orgId);
    expect(brief.id).toBe(res.briefId);
    expect(brief.scope).toBe("agency");
    expect(brief.period).toBe("daily");
    // dry-run sent nothing → status stays generated, no send timestamps.
    expect(brief.status).toBe("generated");
    expect(brief.sent_email_at).toBeNull();
    expect(brief.headline).toContain("£1,500.00");
    expect(brief.model).not.toBeNull();
    expect(brief.tokens_in).toBe(5000);
    expect(brief.tokens_out).toBe(1200);

    // dataSnapshot IS the pack — every number the agent saw (auditable AI).
    const snap = brief.data_snapshot as {
      agency?: { mrrPence?: number };
      projects?: unknown[];
      forDay?: string;
    };
    expect(snap.agency?.mrrPence).toBe(MRR_PENCE);
    expect(Array.isArray(snap.projects)).toBe(true);
    expect(typeof snap.forDay).toBe("string");

    // Delivery ran in dry-run: no network, would-send payloads returned.
    expect(res.delivered).not.toBeNull();
    expect(res.delivered?.dryRun).toBe(true);
    const emailPayload = res.delivered?.payloads.email;
    expect(emailPayload).not.toBeNull();
    expect(emailPayload?.to).toBe("brief@test.example");
    expect(emailPayload?.html).toContain("Revenue £1,500.00");
    // WhatsApp disabled in prefs → no payload.
    expect(res.delivered?.payloads.whatsapp).toBeNull();
  });

  it("clamps whatsapp_text to ≤900 characters before persisting", async () => {
    const longText = "A".repeat(1200);
    hoisted.parseMock.mockResolvedValueOnce(
      parseResult(sampleOutput({ whatsapp_text: longText })),
    );

    const res = await runDailyBrief(db, {
      orgId: harness.orgId,
      deliver: true,
      dryRun: true,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error);

    const brief = await loadBrief(harness.orgId);
    expect((brief.body_whatsapp ?? "").length).toBeLessThanOrEqual(900);
    expect(res.delivered?.payloads.whatsapp).toBeNull(); // still disabled
  });

  it("writes the brief but skips delivery when deliver:false", async () => {
    hoisted.parseMock.mockResolvedValueOnce(parseResult(sampleOutput()));

    const res = await runDailyBrief(db, {
      orgId: harness.orgId,
      deliver: false,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error);
    expect(res.delivered).toBeNull();
    expect(await countBriefs(harness.orgId)).toBe(1);
  });
});

describe("runDailyBrief — parse failure", () => {
  it("surfaces the error and writes NO brief when structured output stays null", async () => {
    // null twice → runner retries once then fails parse_failed.
    hoisted.parseMock
      .mockResolvedValueOnce(parseResult(null))
      .mockResolvedValueOnce(parseResult(null));

    const res = await runDailyBrief(db, {
      orgId: harness.orgId,
      deliver: true,
      dryRun: true,
    });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected failure");
    expect(res.error).toBe("parse_failed");
    expect(hoisted.parseMock).toHaveBeenCalledTimes(2);
    // No half-written brief.
    expect(await countBriefs(harness.orgId)).toBe(0);
  });
});
