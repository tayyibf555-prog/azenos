// Force graceful no-Twilio behaviour regardless of the ambient .env — the
// escalation pass must never make a real network call from tests.
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.TWILIO_WHATSAPP_FROM;
delete process.env.OWNER_WHATSAPP_TO;

import { afterEach, describe, expect, it } from "vitest";
import { alertInstances, db, projects } from "@azen/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { evaluateHealth } from "../../lib/server/health/evaluate";
import {
  type HealthOrg,
  cleanupHealthOrg,
  createHealthOrg,
  createLiveProject,
  insertEvent,
  insertEvents,
  insertPastDueRetainer,
} from "./helpers";

const NOW = new Date("2026-07-16T12:00:00.000Z");
const minsAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

let org: HealthOrg | null = null;

afterEach(async () => {
  if (org) await cleanupHealthOrg(org);
  org = null;
});

async function openHealthAlerts(orgId: string) {
  return db
    .select({
      id: alertInstances.id,
      projectId: alertInstances.projectId,
      kind: alertInstances.kind,
      severity: alertInstances.severity,
      evidence: alertInstances.evidence,
    })
    .from(alertInstances)
    .where(
      and(
        eq(alertInstances.orgId, orgId),
        isNull(alertInstances.resolvedAt),
        sql`${alertInstances.evidence}->>'source' = 'health'`,
      ),
    );
}

function check(row: { evidence: Record<string, unknown> }): unknown {
  return row.evidence["check"];
}

describe("evaluateHealth — spine → alerts", () => {
  it("fresh project stays green; silent project goes red and opens event_silence", async () => {
    org = await createHealthOrg();
    const fresh = await createLiveProject(org, { name: "Fresh" });
    const silent = await createLiveProject(org, { name: "Silent" });
    await insertEvent(org, fresh, "lead.created", minsAgo(5));
    await insertEvent(org, silent, "lead.created", minsAgo(600)); // > 2×240

    const res = await evaluateHealth(org.orgId, { now: NOW, escalate: false });

    expect(res.health[fresh]).toBe("green");
    expect(res.health[silent]).toBe("red");

    const open = await openHealthAlerts(org.orgId);
    const silentAlerts = open.filter((a) => a.projectId === silent);
    expect(silentAlerts).toHaveLength(1);
    expect(silentAlerts[0]?.kind).toBe("event_silence");
    expect(silentAlerts[0]?.severity).toBe("critical");
    expect(open.some((a) => a.projectId === fresh)).toBe(false);

    // objective badge written back to projects.health
    const [silentRow] = await db
      .select({ health: projects.health })
      .from(projects)
      .where(eq(projects.id, silent));
    expect(silentRow?.health).toBe("red");
  });

  it("error streak fires once, not once per run", async () => {
    org = await createHealthOrg();
    const p = await createLiveProject(org, { name: "Erroring" });
    await insertEvent(org, p, "lead.created", minsAgo(2)); // keep it fresh
    await insertEvents(org, p, "system.error", 5, minsAgo(1)); // 5 in last 30m

    await evaluateHealth(org.orgId, { now: NOW, escalate: false });
    const secondRun = await evaluateHealth(org.orgId, { now: NOW, escalate: false });
    expect(secondRun.opened).toBe(0); // dedup — already open

    const streaks = (await openHealthAlerts(org.orgId)).filter(
      (a) => check(a) === "error_streak",
    );
    expect(streaks).toHaveLength(1);
  });

  it("auto-resolves an error streak once the window clears", async () => {
    org = await createHealthOrg();
    const p = await createLiveProject(org, { name: "Recovers" });
    await insertEvent(org, p, "lead.created", minsAgo(2));
    await insertEvents(org, p, "system.error", 5, minsAgo(1));

    await evaluateHealth(org.orgId, { now: NOW, escalate: false });
    expect(
      (await openHealthAlerts(org.orgId)).some((a) => check(a) === "error_streak"),
    ).toBe(true);

    // 31 minutes later the errors have aged out of the 30m window; still fresh.
    const later = new Date(NOW.getTime() + 31 * 60_000);
    const res = await evaluateHealth(org.orgId, { now: later, escalate: false });
    expect(res.resolved).toBeGreaterThanOrEqual(1);
    expect(
      (await openHealthAlerts(org.orgId)).some((a) => check(a) === "error_streak"),
    ).toBe(false);
  });

  it("computes an SLO error-rate breach (anomaly)", async () => {
    org = await createHealthOrg();
    const p = await createLiveProject(org, { slo: { error_rate_pct: 5 } });
    await insertEvent(org, p, "lead.created", minsAgo(2)); // fresh
    // 20 errors + 80 normal, all older than 30m (no streak) but within 24h.
    await insertEvents(org, p, "system.error", 20, minsAgo(40));
    await insertEvents(org, p, "lead.created", 80, minsAgo(45));

    const res = await evaluateHealth(org.orgId, { now: NOW, escalate: false });
    expect(res.health[p]).toBe("red"); // 20% > 2×5%

    const open = await openHealthAlerts(org.orgId);
    const rate = open.filter((a) => check(a) === "error_rate");
    expect(rate).toHaveLength(1);
    expect(rate[0]?.kind).toBe("anomaly");
    // the streak did NOT fire (errors aged out of 30m)
    expect(open.some((a) => check(a) === "error_streak")).toBe(false);
  });

  it("flags a past-due retainer as a warn (payment_overdue)", async () => {
    org = await createHealthOrg();
    const p = await createLiveProject(org);
    await insertEvent(org, p, "lead.created", minsAgo(3));
    await insertPastDueRetainer(org, p);

    const res = await evaluateHealth(org.orgId, { now: NOW, escalate: false });
    expect(res.health[p]).toBe("amber");
    const overdue = (await openHealthAlerts(org.orgId)).filter(
      (a) => check(a) === "retainer_overdue",
    );
    expect(overdue).toHaveLength(1);
    expect(overdue[0]?.severity).toBe("warn");
  });

  it("upgrades an open instance's severity in place when the breach worsens", async () => {
    org = await createHealthOrg();
    const p = await createLiveProject(org, { name: "Drifting" });
    // 300m since last event → freshness in the warn band (240 < gap <= 480).
    await insertEvent(org, p, "lead.created", minsAgo(300));

    const first = await evaluateHealth(org.orgId, { now: NOW, escalate: false });
    expect(first.health[p]).toBe("amber");
    let fresh = (await openHealthAlerts(org.orgId)).filter(
      (a) => check(a) === "freshness",
    );
    expect(fresh).toHaveLength(1);
    expect(fresh[0]?.severity).toBe("warn");

    // 200m later the gap is 500m → critical band. The SAME open row must be
    // upgraded warn → critical (not left frozen, not duplicated).
    const later = new Date(NOW.getTime() + 200 * 60_000);
    const second = await evaluateHealth(org.orgId, { now: later, escalate: false });
    expect(second.opened).toBe(0); // no new instance — the open one is reused
    fresh = (await openHealthAlerts(org.orgId)).filter(
      (a) => check(a) === "freshness",
    );
    expect(fresh).toHaveLength(1);
    expect(fresh[0]?.severity).toBe("critical");
  });

  it("auto-resolves an open alert once its project is no longer live", async () => {
    org = await createHealthOrg();
    const p = await createLiveProject(org, { name: "Pausing" });
    await insertEvent(org, p, "lead.created", minsAgo(600)); // critical silence

    await evaluateHealth(org.orgId, { now: NOW, escalate: false });
    expect((await openHealthAlerts(org.orgId)).length).toBeGreaterThanOrEqual(1);

    // The project leaves 'live' (paused) — it drops out of the evaluated set.
    await db.update(projects).set({ status: "paused" }).where(eq(projects.id, p));

    const res = await evaluateHealth(org.orgId, { now: NOW, escalate: false });
    expect(res.resolved).toBeGreaterThanOrEqual(1);
    expect(await openHealthAlerts(org.orgId)).toHaveLength(0);
  });

  it("escalates a still-unacked critical after the 15m window (graceful, no Twilio)", async () => {
    org = await createHealthOrg();
    const p = await createLiveProject(org, { name: "Silent" });
    await insertEvent(org, p, "lead.created", minsAgo(600));

    // First run opens the critical event_silence at NOW.
    await evaluateHealth(org.orgId, { now: NOW, escalate: true });
    // 16 minutes later it is still unacked → escalation attempts, degrades.
    const later = new Date(NOW.getTime() + 16 * 60_000);
    const res = await evaluateHealth(org.orgId, { now: later, escalate: true });

    expect(res.escalations.attempted).toBeGreaterThanOrEqual(1);
    expect(res.escalations.sent).toBe(0);
    expect(res.escalations.twilioConfigured).toBe(false);
  });
});
