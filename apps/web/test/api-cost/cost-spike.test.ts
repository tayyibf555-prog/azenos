import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { alertInstances, db } from "@azen/db";
import { and, eq, isNull } from "drizzle-orm";
import {
  COST_SPIKE_MIN_ABS_PENCE,
  COST_SPIKE_RATIO,
  evaluateCostSpike,
} from "../../lib/server/health/rules/cost-spike";
import { evaluateHealth } from "../../lib/server/health/evaluate";
import { createMoneyHarness, cleanupMoneyHarness, type MoneyHarness } from "../money/helpers";
import { cleanupAlerts, insertAgentRun } from "./helpers";

/**
 * Cost-spike rule (P9-COST). The pinned boundaries: strictly > 1.4× prior AND
 * strictly > £5 absolute. 1.39× no, 1.41× yes, sub-£5 never.
 */
describe("evaluateCostSpike boundaries", () => {
  const base = { projectId: "p", clientId: "c" };

  it("fires at 1.41× when above the £5 floor", () => {
    const s = evaluateCostSpike({ ...base, thisSpendPence: 1410, priorSpendPence: 1000 });
    expect(s).not.toBeNull();
    expect(s!.kind).toBe("cost_spike");
    expect(s!.severity).toBe("warn");
    expect(s!.evidence.ratio).toBeCloseTo(1.41, 5);
  });

  it("does NOT fire at 1.39×", () => {
    expect(evaluateCostSpike({ ...base, thisSpendPence: 1390, priorSpendPence: 1000 })).toBeNull();
  });

  it("does NOT fire exactly at 1.40× (strictly greater)", () => {
    expect(evaluateCostSpike({ ...base, thisSpendPence: 1400, priorSpendPence: 1000 })).toBeNull();
  });

  it("never fires below the £5 floor, however large the ratio", () => {
    // 400p is 4× the 100p prior but still under £5 → not a spike.
    expect(evaluateCostSpike({ ...base, thisSpendPence: 400, priorSpendPence: 100 })).toBeNull();
    expect(evaluateCostSpike({ ...base, thisSpendPence: COST_SPIKE_MIN_ABS_PENCE, priorSpendPence: 1 })).toBeNull();
  });

  it("does NOT fire when there is no prior baseline", () => {
    expect(evaluateCostSpike({ ...base, thisSpendPence: 100_000, priorSpendPence: 0 })).toBeNull();
  });

  it("uses the pinned constants", () => {
    expect(COST_SPIKE_RATIO).toBe(1.4);
    expect(COST_SPIKE_MIN_ABS_PENCE).toBe(500);
  });
});

/**
 * End-to-end through the evaluator: a project whose this-7d API spend exceeds
 * 1.4× the prior 7d (and £5) opens exactly one `cost_spike` alert; normalising
 * the spend auto-resolves it.
 */
describe("cost_spike via evaluateHealth", () => {
  let h: MoneyHarness;
  const now = new Date();
  const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);

  beforeEach(async () => {
    h = await createMoneyHarness();
  });

  afterEach(async () => {
    await cleanupAlerts(h.orgId);
    await cleanupMoneyHarness(h);
  });

  async function openCostSpikes(orgId: string) {
    return db
      .select({ id: alertInstances.id, message: alertInstances.message })
      .from(alertInstances)
      .where(
        and(
          eq(alertInstances.orgId, orgId),
          eq(alertInstances.kind, "cost_spike"),
          isNull(alertInstances.resolvedAt),
        ),
      );
  }

  it("fires once on a spike then auto-resolves when spend normalises", async () => {
    // prior 7d: £10, this 7d: £20 → 2× > 1.4× and > £5 → spike.
    await insertAgentRun({ orgId: h.orgId, clientId: h.clientId, projectId: h.projectId, agent: "daily_brief", startedAt: daysAgo(10), costEstimatePence: 1_000 });
    await insertAgentRun({ orgId: h.orgId, clientId: h.clientId, projectId: h.projectId, agent: "daily_brief", startedAt: daysAgo(2), costEstimatePence: 2_000 });

    await evaluateHealth(h.orgId, { now, escalate: false });
    let open = await openCostSpikes(h.orgId);
    expect(open).toHaveLength(1);

    // Re-run: still open, still exactly one (fire-once dedupe).
    await evaluateHealth(h.orgId, { now, escalate: false });
    open = await openCostSpikes(h.orgId);
    expect(open).toHaveLength(1);

    // Normalise: add £20 to the prior window so this(20) ≤ 1.4×prior(30) → clears.
    await insertAgentRun({ orgId: h.orgId, clientId: h.clientId, projectId: h.projectId, agent: "weekly_synth", startedAt: daysAgo(10), costEstimatePence: 2_000 });
    await evaluateHealth(h.orgId, { now, escalate: false });
    open = await openCostSpikes(h.orgId);
    expect(open).toHaveLength(0);
  });

  it("does not fire when spend is flat", async () => {
    await insertAgentRun({ orgId: h.orgId, clientId: h.clientId, projectId: h.projectId, agent: "daily_brief", startedAt: daysAgo(10), costEstimatePence: 1_000 });
    await insertAgentRun({ orgId: h.orgId, clientId: h.clientId, projectId: h.projectId, agent: "daily_brief", startedAt: daysAgo(2), costEstimatePence: 1_000 });
    await evaluateHealth(h.orgId, { now, escalate: false });
    const open = await openCostSpikes(h.orgId);
    expect(open).toHaveLength(0);
  });
});
