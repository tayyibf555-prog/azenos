import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  computeConcentration,
  deriveProjectFinancials,
  getPortfolio,
  rankByRoi,
  type PortfolioProjectRow,
} from "../../lib/server/portfolio";
import {
  cleanupPortfolioHarness,
  createPortfolioHarness,
  insertAgentRun,
  insertClient,
  insertEvent,
  insertProject,
  type PortfolioHarness,
} from "./helpers";

describe("deriveProjectFinancials (pure)", () => {
  it("cost = os + emitted; value = net revenue + time value; roi = value ÷ cost", () => {
    const r = deriveProjectFinancials({
      osCostPence: 10_000,
      emittedCostPence: 5_000,
      grossRevenuePence: 100_000,
      refundsPence: 20_000,
      minutesSaved: 120,
      hourlyRatePence: 3_000,
      eventsMtd: 40,
    });
    expect(r.costPence).toBe(15_000);
    expect(r.netRevenuePence).toBe(80_000);
    expect(r.timeValuePence).toBe(6_000); // 2h × £30
    expect(r.valuePence).toBe(86_000);
    expect(r.roiMultiple).toBeCloseTo(86_000 / 15_000);
  });

  it("null ROI when cost is 0 (never divides by zero)", () => {
    const r = deriveProjectFinancials({
      osCostPence: 0,
      emittedCostPence: 0,
      grossRevenuePence: 50_000,
      refundsPence: 0,
      minutesSaved: 0,
      hourlyRatePence: 3_000,
      eventsMtd: 5,
    });
    expect(r.roiMultiple).toBeNull();
  });
});

function row(overrides: Partial<PortfolioProjectRow>): PortfolioProjectRow {
  return {
    projectId: overrides.projectId ?? "p",
    projectName: overrides.projectName ?? "Project",
    clientId: overrides.clientId ?? "c",
    clientName: overrides.clientName ?? "Client",
    status: "live",
    health: "green",
    osCostPence: 0,
    emittedCostPence: 0,
    costPence: 0,
    netRevenuePence: 0,
    timeValuePence: 0,
    valuePence: 0,
    eventsMtd: 0,
    roiMultiple: null,
    ...overrides,
  };
}

describe("rankByRoi (pure)", () => {
  it("descending ROI, with null-ROI rows sorted last", () => {
    const rows = [
      row({ projectId: "a", roiMultiple: 1.5 }),
      row({ projectId: "b", roiMultiple: 4 }),
      row({ projectId: "c", roiMultiple: null, valuePence: 100 }),
      row({ projectId: "d", roiMultiple: 2 }),
    ];
    const ranked = rankByRoi(rows).map((r) => r.projectId);
    expect(ranked).toEqual(["b", "d", "a", "c"]);
  });
});

describe("computeConcentration (pure)", () => {
  it("groups by client and finds the top share of total value", () => {
    const rows = [
      row({ projectId: "1", clientId: "A", clientName: "Alpha", valuePence: 300 }),
      row({ projectId: "2", clientId: "A", clientName: "Alpha", valuePence: 200 }),
      row({ projectId: "3", clientId: "B", clientName: "Beta", valuePence: 100 }),
    ];
    const c = computeConcentration(rows);
    expect(c.topClientId).toBe("A");
    expect(c.topClientName).toBe("Alpha");
    expect(c.topClientValuePence).toBe(500);
    expect(c.totalValuePence).toBe(600);
    expect(c.pct).toBeCloseTo(83.3, 1);
  });

  it("no rows → zeroed, no client, no crash", () => {
    const c = computeConcentration([]);
    expect(c.topClientId).toBeNull();
    expect(c.pct).toBe(0);
  });
});

describe("getPortfolio (SQL, hand-built projects/agent_runs/events)", () => {
  let h: PortfolioHarness;

  beforeAll(async () => {
    h = await createPortfolioHarness();
  });

  afterAll(async () => {
    await cleanupPortfolioHarness(h);
  });

  it("rolls up MTD cost/value per live project and ranks by ROI", async () => {
    const clientA = await insertClient(h.orgId, "Alpha Co");
    const clientB = await insertClient(h.orgId, "Beta Ltd");

    // Project 1 (client A): profitable this month — cost 10000, value from
    // revenue 50000 net (no refunds), no time value (no hourly rate override
    // and no minutes_saved). ROI = 5×.
    const p1 = await insertProject({ orgId: h.orgId, clientId: clientA, name: "Alpha Bot", status: "live" });
    await insertAgentRun({ orgId: h.orgId, clientId: clientA, projectId: p1, costEstimatePence: 10_000, startedAt: new Date() });
    await insertEvent({ orgId: h.orgId, projectId: p1, type: "payment.captured", occurredAt: new Date(), valuePence: 50_000 });

    // Project 2 (client B): unprofitable — cost 20000, value 5000. ROI = 0.25×.
    const p2 = await insertProject({ orgId: h.orgId, clientId: clientB, name: "Beta Automation", status: "live" });
    await insertAgentRun({ orgId: h.orgId, clientId: clientB, projectId: p2, costEstimatePence: 20_000, startedAt: new Date() });
    await insertEvent({ orgId: h.orgId, projectId: p2, type: "payment.captured", occurredAt: new Date(), valuePence: 5_000 });

    // Not-live project — must be excluded entirely.
    const p3ClientId = await insertClient(h.orgId, "Scoping Client");
    const p3 = await insertProject({ orgId: h.orgId, clientId: p3ClientId, name: "Scoping Project", status: "scoping" });
    await insertEvent({ orgId: h.orgId, projectId: p3, type: "payment.captured", occurredAt: new Date(), valuePence: 999_999 });

    const result = await getPortfolio(h.orgId);
    const ids = result.rows.map((r) => r.projectId);
    expect(ids).toContain(p1);
    expect(ids).toContain(p2);
    expect(ids).not.toContain(p3);

    const r1 = result.rows.find((r) => r.projectId === p1)!;
    const r2 = result.rows.find((r) => r.projectId === p2)!;
    expect(r1.costPence).toBe(10_000);
    expect(r1.valuePence).toBe(50_000);
    expect(r1.roiMultiple).toBe(5);
    expect(r2.costPence).toBe(20_000);
    expect(r2.valuePence).toBe(5_000);
    expect(r2.roiMultiple).toBe(0.25);

    // Ranked ROI descending: p1 (5×) before p2 (0.25×).
    expect(ids.indexOf(p1)).toBeLessThan(ids.indexOf(p2));

    expect(result.totals.costPence).toBe(30_000);
    expect(result.totals.valuePence).toBe(55_000);

    // Concentration: client A's 50000 of the 55000 total value = ~90.9%.
    expect(result.concentration.topClientId).toBe(clientA);
    expect(result.concentration.pct).toBeCloseTo(90.9, 1);
  });

  it("no live projects → empty rows, zeroed totals, no crash", async () => {
    const h2 = await createPortfolioHarness();
    try {
      const result = await getPortfolio(h2.orgId);
      expect(result.rows).toEqual([]);
      expect(result.totals).toEqual({ costPence: 0, valuePence: 0 });
      expect(result.concentration.topClientId).toBeNull();
    } finally {
      await cleanupPortfolioHarness(h2);
    }
  });
});
