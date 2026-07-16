import { randomUUID } from "node:crypto";
import {
  clients,
  db,
  events,
  feedbackItems,
  organizations,
  payments,
  projects,
  subscriptions,
} from "@azen/db";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import {
  bandForScore,
  bugSpikeRisk,
  computeChurnScore,
  engagementRisk,
  getChurnScores,
  paymentRisk,
  sentimentRisk,
  silenceRisk,
  type ChurnInputs,
} from "../../lib/server/churn";

/**
 * Churn-risk tests (docs/phase9/CONTRACTS.md §P9-KB). The pure scorer is tested at
 * the band boundaries (healthy <25, watch 25–60, risk >60) with pinned weights;
 * the per-factor risk functions are checked against their documented ramps; and
 * getChurnScores is exercised against a throwaway org (never the demo org).
 */

const ZERO: ChurnInputs = {
  engagementRecent: 0,
  engagementPrior: 0,
  sentimentNegRecent: 0,
  sentimentTotalRecent: 0,
  sentimentNegPrior: 0,
  sentimentTotalPrior: 0,
  bugRecent: 0,
  bugPrior: 0,
  hasPastDue: false,
  hasActiveRetainer: false,
  daysSinceLastPayment: null,
  daysSinceLastEvent: null,
};

describe("churn factor risk functions", () => {
  it("engagementRisk: drop vs prior, no prior → 0", () => {
    expect(engagementRisk(0, 0)).toBe(0);
    expect(engagementRisk(100, 0)).toBe(0); // growth from nothing
    expect(engagementRisk(50, 100)).toBeCloseTo(0.5);
    expect(engagementRisk(0, 100)).toBe(1); // full stop
    expect(engagementRisk(120, 100)).toBe(0); // grew → clamped to 0
  });

  it("sentimentRisk: recent negative share + worsening; no convos → 0", () => {
    expect(sentimentRisk(0, 0, 0, 0)).toBe(0);
    // 20% negative, flat vs prior → 0.2
    expect(sentimentRisk(2, 10, 2, 10)).toBeCloseTo(0.2);
    // 40% negative now vs 20% before → 0.4 + 0.5*0.2 = 0.5
    expect(sentimentRisk(4, 10, 2, 10)).toBeCloseTo(0.5);
    // all negative + worsening → clamps to 1
    expect(sentimentRisk(10, 10, 0, 10)).toBe(1);
  });

  it("bugSpikeRisk: rise vs prior; base handles no history", () => {
    expect(bugSpikeRisk(0, 0)).toBe(0);
    expect(bugSpikeRisk(3, 0)).toBe(1); // 3 new, no prior → full spike (base 3)
    expect(bugSpikeRisk(2, 2)).toBe(0); // flat
    expect(bugSpikeRisk(4, 2)).toBe(1); // doubled → 1
  });

  it("paymentRisk: past_due maximal; else lateness ramp 35→65d", () => {
    expect(paymentRisk(true, true, 1)).toBe(1);
    expect(paymentRisk(false, false, null)).toBe(0);
    expect(paymentRisk(false, true, 35)).toBe(0);
    expect(paymentRisk(false, true, 50)).toBeCloseTo(0.5);
    expect(paymentRisk(false, true, 65)).toBe(1);
  });

  it("silenceRisk: ramp 7→28d; null → 0", () => {
    expect(silenceRisk(null)).toBe(0);
    expect(silenceRisk(7)).toBe(0);
    expect(silenceRisk(17.5)).toBeCloseTo(0.5);
    expect(silenceRisk(28)).toBe(1);
  });
});

describe("bandForScore boundaries", () => {
  it("healthy <25, watch 25–60, risk >60", () => {
    expect(bandForScore(0)).toBe("healthy");
    expect(bandForScore(24)).toBe("healthy");
    expect(bandForScore(25)).toBe("watch");
    expect(bandForScore(60)).toBe("watch");
    expect(bandForScore(61)).toBe("risk");
    expect(bandForScore(100)).toBe("risk");
  });
});

describe("computeChurnScore composite (pinned weights)", () => {
  it("a quiet, all-zero client is healthy (0)", () => {
    const s = computeChurnScore("c1", "Zero Co", ZERO);
    expect(s.score).toBe(0);
    expect(s.band).toBe("healthy");
    expect(s.reasons).toEqual([]);
  });

  it("a moderate engagement drop alone lands in WATCH", () => {
    // engagement risk 1.0 × 0.30 = 30 → watch band, others zero.
    const s = computeChurnScore("c2", "Slipping Co", {
      ...ZERO,
      engagementRecent: 0,
      engagementPrior: 200,
    });
    expect(s.score).toBe(30);
    expect(s.band).toBe("watch");
    expect(s.reasons[0]).toContain("Engagement down 100%");
  });

  it("stacked bad signals push a client into RISK (>60)", () => {
    // eng 1.0×.30 + sentiment 1.0×.20 + payment(past_due) 1.0×.20 +
    // silence(28d) 1.0×.15 = 0.85 → 85.
    const s = computeChurnScore("c3", "Churning Co", {
      engagementRecent: 0,
      engagementPrior: 100,
      sentimentNegRecent: 10,
      sentimentTotalRecent: 10,
      sentimentNegPrior: 0,
      sentimentTotalPrior: 10,
      bugRecent: 0,
      bugPrior: 0,
      hasPastDue: true,
      hasActiveRetainer: true,
      daysSinceLastPayment: 70,
      daysSinceLastEvent: 28,
    });
    expect(s.score).toBe(85);
    expect(s.band).toBe("risk");
    // reasons ranked by weighted contribution — engagement (0.30) leads.
    expect(s.reasons[0]).toContain("Engagement down");
    expect(s.reasons).toContain("Retainer past due");
  });

  it("a mild single signal stays HEALTHY (<25)", () => {
    // bug spike 1.0 × 0.15 = 15 → healthy.
    const s = computeChurnScore("c4", "Buggy-ish Co", {
      ...ZERO,
      bugRecent: 4,
      bugPrior: 2,
    });
    expect(s.score).toBe(15);
    expect(s.band).toBe("healthy");
  });
});

// ── loader integration (throwaway org) ────────────────────────────────────────

interface ChurnOrg {
  orgId: string;
  clientId: string;
  projectId: string;
}

async function createChurnOrg(): Promise<ChurnOrg> {
  const orgId = randomUUID();
  const clientId = randomUUID();
  const projectId = randomUUID();
  await db.insert(organizations).values({ id: orgId, name: `Churn ${orgId.slice(0, 8)}` });
  await db.insert(clients).values({ id: clientId, orgId, name: "Churn Client", status: "active" });
  await db.insert(projects).values({
    id: projectId,
    orgId,
    clientId,
    name: "Churn Project",
    slug: `churn-${projectId}`,
    type: "ai_agent",
    stack: "custom_code",
    status: "live",
  });
  return { orgId, clientId, projectId };
}

async function cleanupChurnOrg(o: ChurnOrg): Promise<void> {
  await db.delete(feedbackItems).where(eq(feedbackItems.orgId, o.orgId));
  await db.delete(payments).where(eq(payments.orgId, o.orgId));
  await db.delete(subscriptions).where(eq(subscriptions.orgId, o.orgId));
  await db.delete(events).where(eq(events.orgId, o.orgId));
  await db.delete(projects).where(eq(projects.orgId, o.orgId));
  await db.delete(clients).where(eq(clients.orgId, o.orgId));
  await db.delete(organizations).where(eq(organizations.id, o.orgId));
}

/** Insert an event at NOON UTC of a London day `daysAgo` before today. */
async function insertChurnEvent(
  o: ChurnOrg,
  daysAgo: number,
  type: string,
  data: Record<string, unknown> = {},
): Promise<void> {
  const rows = (await db.$client`
    select to_char(
      ((date_trunc('day', now() at time zone 'Europe/London') - make_interval(days => ${daysAgo}))
        at time zone 'Europe/London') at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS"Z"'
    ) as iso
  `) as unknown as { iso: string }[];
  const at = new Date(new Date(rows[0]!.iso).getTime() + 12 * 3600 * 1000);
  await db.insert(events).values({
    id: randomUUID(),
    orgId: o.orgId,
    projectId: o.projectId,
    type,
    source: "sdk",
    idempotencyKey: `churn:${randomUUID()}`,
    occurredAt: at,
    receivedAt: at,
    data,
    raw: {},
  });
}

let org: ChurnOrg | null = null;
afterEach(async () => {
  if (org) await cleanupChurnOrg(org);
  org = null;
});

describe("getChurnScores loader (throwaway org)", () => {
  it("scores a healthy, steadily-engaged client low", async () => {
    org = await createChurnOrg();
    // Even volume across both windows (days 1–20 and 31–50) → no drop, no silence.
    for (let d = 1; d <= 20; d++) await insertChurnEvent(org, d, "custom.metric");
    for (let d = 31; d <= 50; d++) await insertChurnEvent(org, d, "custom.metric");

    const scores = await getChurnScores(org.orgId);
    const me = scores.find((s) => s.clientId === org!.clientId)!;
    expect(me).toBeTruthy();
    expect(me.band).toBe("healthy");
    expect(me.inputs.engagementRecent).toBe(20);
    expect(me.inputs.engagementPrior).toBe(20);
  });

  it("scores a silent, dropped-off, past-due client into RISK", async () => {
    org = await createChurnOrg();
    // Busy prior window only; recent window empty (full engagement drop + silence).
    for (let d = 31; d <= 55; d++) await insertChurnEvent(org, d, "custom.metric");
    // A past_due retainer.
    await db.insert(subscriptions).values({
      id: randomUUID(),
      orgId: org.orgId,
      clientId: org.clientId,
      amountPenceMonthly: 50_000,
      status: "past_due",
      startedAt: "2026-01-01",
    });

    const scores = await getChurnScores(org.orgId);
    const me = scores.find((s) => s.clientId === org!.clientId)!;
    expect(me.inputs.engagementRecent).toBe(0);
    expect(me.inputs.engagementPrior).toBe(25);
    expect(me.inputs.hasPastDue).toBe(true);
    expect(me.factors.engagement).toBe(1);
    expect(me.factors.payment).toBe(1);
    // engagement 0.30 + payment 0.20 + silence (31d≥28 → 1.0)×0.15 = 0.65 → 65.
    expect(me.band).toBe("risk");
  });

  it("measures silence past the 60-day trend window (dormant client is not scored 0)", async () => {
    org = await createChurnOrg();
    // The client's ONLY events are 65 days ago — outside BOTH the recent and the
    // prior 30-day trend windows. Silence must still ramp to full risk (regression:
    // a windowed max collapsed to null here, inverting silence to 0 → healthy).
    for (let d = 65; d <= 70; d++) await insertChurnEvent(org, d, "custom.metric");
    // A past_due retainer so the honest score (silence 0.15 + payment 0.20 = 0.35 →
    // watch) is distinguishable from the buggy one (silence 0 → 0.20 → healthy).
    await db.insert(subscriptions).values({
      id: randomUUID(),
      orgId: org.orgId,
      clientId: org.clientId,
      amountPenceMonthly: 50_000,
      status: "past_due",
      startedAt: "2026-01-01",
    });

    const scores = await getChurnScores(org.orgId);
    const me = scores.find((s) => s.clientId === org!.clientId)!;
    // No events fall inside either trend window.
    expect(me.inputs.engagementRecent).toBe(0);
    expect(me.inputs.engagementPrior).toBe(0);
    // Silence is measured over ALL events, so it is non-null and past the ramp.
    expect(me.inputs.daysSinceLastEvent).not.toBeNull();
    expect(me.inputs.daysSinceLastEvent!).toBeGreaterThanOrEqual(60);
    expect(me.factors.silence).toBe(1);
    expect(me.band).toBe("watch");
  });

  it("counts negative-sentiment conversations into the sentiment factor", async () => {
    org = await createChurnOrg();
    // 10 recent conversations, 6 negative → 60% negative share, none prior.
    for (let i = 0; i < 6; i++)
      await insertChurnEvent(org, 3, "llm.conversation", { sentiment: "negative" });
    for (let i = 0; i < 4; i++)
      await insertChurnEvent(org, 3, "llm.conversation", { sentiment: "positive" });

    const scores = await getChurnScores(org.orgId);
    const me = scores.find((s) => s.clientId === org!.clientId)!;
    expect(me.inputs.sentimentTotalRecent).toBe(10);
    expect(me.inputs.sentimentNegRecent).toBe(6);
    expect(me.factors.sentiment).toBeGreaterThan(0.5);
  });
});
