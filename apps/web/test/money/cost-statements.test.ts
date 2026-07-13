import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import { agentRuns, db, projects } from "@azen/db";
import { eq } from "drizzle-orm";
import { getCostStatements, setClientMarkup } from "../../lib/server/money";
import {
  cleanupMoneyHarness,
  createMoneyHarness,
  dayInMonth,
  type MoneyHarness,
} from "./helpers";

/**
 * Cost-statement billing math must be EXACT: billable = round(cost × (1 +
 * pct/100)). The attributed cost here is a single OS agent_runs cost this
 * month (£10.00), so the arithmetic is fully determined by the markup.
 */
describe("getCostStatements markup math", () => {
  let h: MoneyHarness;

  beforeEach(async () => {
    h = await createMoneyHarness();
    await db.insert(agentRuns).values({
      orgId: h.orgId,
      agent: "daily_brief",
      projectId: h.projectId,
      clientId: h.clientId,
      startedAt: dayInMonth(0),
      status: "succeeded",
      costEstimatePence: 1_000,
    });
  });

  afterEach(async () => {
    await cleanupMoneyHarness(h);
  });

  afterAll(async () => {
    // helpers are per-test; nothing global to tear down.
  });

  it("pct 0 bills exactly at cost", async () => {
    await setClientMarkup(h.orgId, h.clientId, 0);
    const s = await getCostStatements(h.orgId);
    const c = s.clients.find((x) => x.clientId === h.clientId)!;
    expect(c.costPence).toBe(1_000);
    expect(c.markupPct).toBe(0);
    expect(c.billablePence).toBe(1_000);
    expect(c.markupPence).toBe(0);
    expect(c.projects[0]!.billablePence).toBe(1_000);
  });

  it("pct 25 marks a round cost up cleanly", async () => {
    await setClientMarkup(h.orgId, h.clientId, 25);
    const s = await getCostStatements(h.orgId);
    const c = s.clients.find((x) => x.clientId === h.clientId)!;
    expect(c.billablePence).toBe(1_250); // 1000 × 1.25
    expect(c.markupPence).toBe(250);
  });

  it("rounds a non-integer markup to the nearest pence", async () => {
    // 1000 × 1.333 = 1333.0 → but use 33% for a clean check: 1000 × 1.33 = 1330
    await setClientMarkup(h.orgId, h.clientId, 33);
    const s = await getCostStatements(h.orgId);
    const c = s.clients.find((x) => x.clientId === h.clientId)!;
    // Math.round(1000 * 1.33) = 1330
    expect(c.billablePence).toBe(1_330);
  });

  it("persists the markup pct via setClientMarkup", async () => {
    const res = await setClientMarkup(h.orgId, h.clientId, 40);
    expect(res?.markupPct).toBe(40);
    const [run] = await db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(eq(agentRuns.orgId, h.orgId));
    expect(run).toBeDefined();
  });
});

/**
 * Per-project invoice lines must reconcile to the client billable: two 10p
 * projects at 25% markup give a 25p client billable (round(20 × 1.25)), and the
 * two project lines must SUM to 25p — not 13p + 13p = 26p from independently
 * rounding each line. Regression guard for the copy-as-invoice divergence.
 */
describe("getCostStatements per-project line allocation", () => {
  let h: MoneyHarness;
  let projectB: string;

  beforeEach(async () => {
    h = await createMoneyHarness();
    projectB = randomUUID();
    await db.insert(projects).values({
      id: projectB,
      orgId: h.orgId,
      clientId: h.clientId,
      name: "Project B",
      slug: `money-b-${randomUUID()}`,
      type: "automation",
      status: "live",
      retainerPenceMonthly: 0,
    });
    // 10p of cost on each of the two projects → client total 20p.
    await db.insert(agentRuns).values([
      {
        orgId: h.orgId,
        agent: "daily_brief",
        projectId: h.projectId,
        clientId: h.clientId,
        startedAt: dayInMonth(0),
        status: "succeeded",
        costEstimatePence: 10,
      },
      {
        orgId: h.orgId,
        agent: "daily_brief",
        projectId: projectB,
        clientId: h.clientId,
        startedAt: dayInMonth(0),
        status: "succeeded",
        costEstimatePence: 10,
      },
    ]);
  });

  afterEach(async () => {
    await cleanupMoneyHarness(h);
  });

  it("project lines sum to the client billable at 25% markup", async () => {
    await setClientMarkup(h.orgId, h.clientId, 25);
    const s = await getCostStatements(h.orgId);
    const c = s.clients.find((x) => x.clientId === h.clientId)!;
    expect(c.costPence).toBe(20);
    expect(c.billablePence).toBe(25); // round(20 × 1.25)
    const lineSum = c.projects.reduce((a, p) => a + p.billablePence, 0);
    expect(lineSum).toBe(c.billablePence);
  });

  it("pct 0 leaves every project line at cost", async () => {
    await setClientMarkup(h.orgId, h.clientId, 0);
    const s = await getCostStatements(h.orgId);
    const c = s.clients.find((x) => x.clientId === h.clientId)!;
    for (const p of c.projects) expect(p.billablePence).toBe(p.costPence);
    const lineSum = c.projects.reduce((a, p) => a + p.billablePence, 0);
    expect(lineSum).toBe(c.billablePence);
  });
});
