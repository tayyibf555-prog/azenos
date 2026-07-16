import { db } from "@azen/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildAgencyDailyPack } from "../src/datapack/index";
import type { DailyPackProject } from "../src/datapack/index";
import {
  addProject,
  cleanupHarness,
  createHarness,
  insertClientBooking,
  insertActiveSubscription,
  insertDayRollup,
  insertEvent,
  insertFeedbackItem,
  insertInsight,
  insertKpiDef,
  londonDayStartsUTC,
  type AgentsHarness,
} from "./helpers";

/**
 * buildAgencyDailyPack over hand-built rollups/events/insights (contract:
 * "reused by the brief agent AND independently testable with hand-built
 * rollups"). We assert EXACT KPI deltas (value vs 7/28-day means), the silence
 * flag (a project with no events), anomaly inclusion, and the agency summary.
 * All numbers are hand-computed in comments.
 */

let h: AgentsHarness;
let betaId: string;
let forDay: Date;
let expectedLastEventIso: string;

beforeAll(async () => {
  h = await createHarness("Datapack Test");
  // Beta project: live + amber, same client, and deliberately silent (no events).
  betaId = await addProject({
    orgId: h.orgId,
    clientId: h.clientId,
    name: "Beta Project",
    health: "amber",
    status: "live",
  });

  // Global KPI def (applies to every project in the org).
  await insertKpiDef(h.orgId, {
    key: "kpi_calls",
    name: "Calls",
    unit: "count",
    goodDirection: "up",
  });

  // index 0 = yesterday (the day we summarize); 1..28 = the trailing 28 days.
  const days = await londonDayStartsUTC(29);
  forDay = new Date(days[0]!);

  // Alpha day-rollups: yesterday = 100; each of the prior 28 days = 10.
  //   value = 100, avg7 = 10, avg28 = 10, deltaPct = (100-10)/10*100 = 900.
  await insertDayRollup(h.orgId, h.projectId, "kpi_calls", days[0]!, 100);
  for (let i = 1; i <= 28; i++) {
    await insertDayRollup(h.orgId, h.projectId, "kpi_calls", days[i]!, 10);
  }

  // Alpha events on yesterday (12:00 into the London day → safely inside it):
  //   revenue = 5000 + 2500 = 7500 pence; minutes = 30 + 15 = 45; 1 system.error.
  const evtMs = new Date(days[0]!).getTime() + 12 * 3_600_000;
  const evt = new Date(evtMs);
  expectedLastEventIso = evt.toISOString().replace(/\.\d{3}Z$/, "Z");
  await insertEvent(h.orgId, h.projectId, {
    type: "call.completed",
    occurredAt: evt,
    valuePence: 5000,
    minutesSaved: 30,
  });
  await insertEvent(h.orgId, h.projectId, {
    type: "booking.created",
    occurredAt: evt,
    valuePence: 2500,
    minutesSaved: 15,
  });
  await insertEvent(h.orgId, h.projectId, {
    type: "system.error",
    occurredAt: evt,
    valuePence: null,
    minutesSaved: null,
  });

  // Open insights: one anomaly (Alpha) + one risk (Alpha).
  await insertInsight(h.orgId, h.projectId, {
    kind: "anomaly",
    title: "Calls spike",
    confidence: "med",
    metricKey: "kpi_calls",
  });
  await insertInsight(h.orgId, h.projectId, {
    kind: "risk",
    title: "Churn risk",
    confidence: "high",
  });

  // Alpha feedback yesterday: 2 bug + 1 feature + 1 question + 1 praise (0 other).
  // All timestamped BEFORE the 12:00 revenue events above (so they don't disturb
  // the lastEventAt/silence-flag assertions, which key off the latest event).
  // Notable ordering is severity desc (nulls last) then most-recent-first, so:
  // bugHigh(sev 3) > bugLow(sev 1) > feature/question/praise (null, by recency:
  // feature 07:00 > question 05:00 > praise 02:00) — top 3 = [bugHigh, bugLow, feature].
  const dayStart = new Date(days[0]!).getTime();
  const longMessage = "x".repeat(200); // exercises the <=140-char truncation
  await insertFeedbackItem(h.orgId, h.projectId, {
    kind: "bug",
    message: longMessage,
    severity: 3,
    createdAt: new Date(dayStart + 6 * 3_600_000),
  });
  await insertFeedbackItem(h.orgId, h.projectId, {
    kind: "bug",
    message: "Minor bug, low priority",
    severity: 1,
    createdAt: new Date(dayStart + 3 * 3_600_000),
  });
  await insertFeedbackItem(h.orgId, h.projectId, {
    kind: "feature",
    message: "Would love a dark mode toggle",
    severity: null,
    createdAt: new Date(dayStart + 7 * 3_600_000),
  });
  await insertFeedbackItem(h.orgId, h.projectId, {
    kind: "question",
    message: "How do I export my data?",
    severity: null,
    createdAt: new Date(dayStart + 5 * 3_600_000),
  });
  await insertFeedbackItem(h.orgId, h.projectId, {
    kind: "praise",
    message: "This saved us hours every week!",
    severity: null,
    createdAt: new Date(dayStart + 2 * 3_600_000),
  });

  // Agency money + bookings.
  await insertActiveSubscription(h.orgId, h.clientId, 150_000); // MRR £1,500
  await insertClientBooking(
    h.orgId,
    h.clientId,
    h.projectId,
    new Date(new Date(days[0]!).getTime() + 10 * 3_600_000),
  );
});

afterAll(async () => {
  await cleanupHarness(h);
});

function byName(projects: DailyPackProject[], name: string): DailyPackProject {
  const p = projects.find((x) => x.name === name);
  if (!p) throw new Error(`project ${name} not in pack`);
  return p;
}

describe("buildAgencyDailyPack", () => {
  it("computes exact KPI deltas, the silence flag, anomalies, and the agency summary", async () => {
    const pack = await buildAgencyDailyPack(db, h.orgId, forDay);

    // ── shape / meta ─────────────────────────────────────────────────────────
    expect(pack.forDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(pack.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(pack.projects).toHaveLength(2); // Alpha + Beta (ordered by name)
    expect(pack.projects.map((p) => p.name)).toEqual([
      "Alpha Project",
      "Beta Project",
    ]);

    // ── agency summary ───────────────────────────────────────────────────────
    expect(pack.agency.mrrPence).toBe(150_000);
    expect(pack.agency.liveProjects).toBe(2);
    expect(pack.agency.activeClients).toBe(1);
    expect(pack.agency.healthSummary).toEqual({ green: 1, amber: 1, red: 0 });
    expect(pack.agency.clientBookingsYesterday).toBe(1);

    // ── Alpha: exact KPI delta + daily aggregates + anomaly ──────────────────
    const alpha = byName(pack.projects, "Alpha Project");
    expect(alpha.health).toBe("green");
    expect(alpha.clientName).toBe(h.clientName);
    expect(alpha.kpis).toHaveLength(1);
    const kpi = alpha.kpis[0]!;
    expect(kpi.key).toBe("kpi_calls");
    expect(kpi.name).toBe("Calls");
    expect(kpi.unit).toBe("count");
    expect(kpi.goodDirection).toBe("up");
    expect(kpi.value).toBe(100);
    expect(kpi.avg7).toBe(10);
    expect(kpi.avg28).toBe(10);
    expect(kpi.deltaPct).toBe(900); // (100-10)/10*100

    expect(alpha.revenueYesterdayPence).toBe(7500);
    expect(alpha.minutesSavedYesterday).toBe(45);
    expect(alpha.errorCountYesterday).toBe(1);
    expect(alpha.lastEventAt).toBe(expectedLastEventIso);
    expect(alpha.hoursSinceLastEvent).not.toBeNull();
    expect(alpha.hoursSinceLastEvent!).toBeGreaterThan(0);
    expect(alpha.openAnomalies).toEqual([
      { metricKey: "kpi_calls", title: "Calls spike" },
    ]);

    // ── Alpha feedback: exact per-kind counts + notable ordering/truncation ──
    expect(alpha.feedback.yesterday).toEqual({
      bug: 2,
      feature: 1,
      question: 1,
      praise: 1,
      other: 0,
    });
    expect(alpha.feedback.notable).toHaveLength(3);
    expect(alpha.feedback.notable[0]).toEqual({
      kind: "bug",
      message: "x".repeat(140), // truncated from 200 chars
      severity: 3,
    });
    expect(alpha.feedback.notable[0]!.message).toHaveLength(140);
    expect(alpha.feedback.notable[1]).toEqual({
      kind: "bug",
      message: "Minor bug, low priority",
      severity: 1,
    });
    expect(alpha.feedback.notable[2]).toEqual({
      kind: "feature",
      message: "Would love a dark mode toggle",
      severity: null,
    });

    // ── Beta: the SILENCE FLAG (no events) + no-history KPI ───────────────────
    const beta = byName(pack.projects, "Beta Project");
    expect(beta.health).toBe("amber");
    expect(beta.revenueYesterdayPence).toBe(0);
    expect(beta.minutesSavedYesterday).toBe(0);
    expect(beta.errorCountYesterday).toBe(0);
    expect(beta.lastEventAt).toBeNull();
    expect(beta.hoursSinceLastEvent).toBeNull();
    expect(beta.openAnomalies).toEqual([]);
    // Beta has zero feedback_items — counts are all zero, notable is empty, no crash.
    expect(beta.feedback.yesterday).toEqual({
      bug: 0,
      feature: 0,
      question: 0,
      praise: 0,
      other: 0,
    });
    expect(beta.feedback.notable).toEqual([]);
    // The global KPI still appears, with null value/means (no rollups for Beta).
    expect(beta.kpis).toHaveLength(1);
    expect(beta.kpis[0]!.value).toBeNull();
    expect(beta.kpis[0]!.avg7).toBeNull();
    expect(beta.kpis[0]!.avg28).toBeNull();
    expect(beta.kpis[0]!.deltaPct).toBeNull();

    // ── open insights (all new, any kind) ────────────────────────────────────
    expect(pack.openInsights).toHaveLength(2);
    const risk = pack.openInsights.find((i) => i.kind === "risk");
    const anomaly = pack.openInsights.find((i) => i.kind === "anomaly");
    expect(risk).toMatchObject({
      title: "Churn risk",
      confidence: "high",
      projectName: "Alpha Project",
    });
    expect(anomaly).toMatchObject({
      title: "Calls spike",
      projectName: "Alpha Project",
    });

    // ── headline baseline note: £75.00 yesterday, nothing in the prior 7 days ─
    expect(pack.yesterdayVsBaseline.note).toBe(
      "£75.00 in revenue yesterday, with no revenue in the prior 7 days.",
    );
  });
});
