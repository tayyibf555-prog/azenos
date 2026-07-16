import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getCostStatements, setClientMarkup } from "../../lib/server/money";
import {
  createMoneyHarness,
  cleanupMoneyHarness,
  dayInMonth,
  type MoneyHarness,
} from "../money/helpers";
import { insertAgentRun, insertClientAiRollup, insertEvent } from "./helpers";

/**
 * Billing v2 (P9-COST). LEAD RULING 2026-07-16 (A): BOTH cost streams — OS
 * (agent_runs) and client-system AI (tokens_cost_pence rollup) — are billed
 * WITH the client markup by DEFAULT, reproducing the v1 statement total exactly
 * (v1 marked up the combined os+client-system-AI cost). include_client_emitted=
 * false EXCLUDES the client-system AI stream from billing (display-only) for
 * clients who bring their own keys. The event-spine per-provider lines are
 * provider detail on that stream.
 */
describe("getCostStatements billing v2", () => {
  let h: MoneyHarness;

  beforeEach(async () => {
    h = await createMoneyHarness();
    // OS cost £10 (agent_runs).
    await insertAgentRun({ orgId: h.orgId, clientId: h.clientId, projectId: h.projectId, agent: "daily_brief", startedAt: dayInMonth(0), costEstimatePence: 1_000 });
    // client-system AI £10 (tokens_cost_pence rollup) — the billed second stream.
    await insertClientAiRollup({ orgId: h.orgId, projectId: h.projectId, periodStart: dayInMonth(0), pence: 1_000 });
    // event-spine provider detail: £3 anthropic + £7 openai (display breakdown).
    await insertEvent({ orgId: h.orgId, projectId: h.projectId, type: "agent.run.completed", occurredAt: dayInMonth(0), data: { provider: "anthropic", cost_pence: 300 } });
    await insertEvent({ orgId: h.orgId, projectId: h.projectId, type: "agent.run.completed", occurredAt: dayInMonth(0), data: { provider: "openai", cost_pence: 700 } });
    await setClientMarkup(h.orgId, h.clientId, 25);
  });

  afterEach(async () => {
    await cleanupMoneyHarness(h);
  });

  it("bills BOTH streams marked up by default (= v1 combined total)", async () => {
    const s = await getCostStatements(h.orgId);
    const c = s.clients.find((x) => x.clientId === h.clientId)!;

    // Combined billed base = OS £10 + client-system AI £10 = £20, marked up 25%.
    expect(c.costPence).toBe(2_000);
    expect(c.billablePence).toBe(2_500); // round(2000 × 1.25) — identical to v1
    expect(c.markupPence).toBe(500);

    // Two labelled line items reconcile to the client billable.
    expect(c.osCostPence).toBe(1_000);
    expect(c.clientSystemAiPence).toBe(1_000);
    expect(c.osBillablePence + c.clientSystemAiBillablePence).toBe(2_500);
    expect(c.clientEmittedBilled).toBe(true);

    // Per-project line reconciles to the client billable.
    expect(c.projects.reduce((a, p) => a + p.billablePence, 0)).toBe(c.billablePence);
    expect(c.projects[0]!.osCostPence).toBe(1_000);
    expect(c.projects[0]!.clientSystemAiPence).toBe(1_000);

    // Provider detail comes from the event spine (display).
    expect(c.providers.map((p) => [p.provider, p.pence])).toEqual([
      ["openai", 700],
      ["anthropic", 300],
    ]);

    // top-level additive fields
    expect(s.includeClientEmitted).toBe(true);
    expect(s.totals.billablePence).toBe(2_500); // both streams billed
    expect(s.totalClientEmittedPence).toBe(1_000); // event-spine provider total
  });

  it("excludes client-system AI from billing when include_client_emitted=false", async () => {
    const s = await getCostStatements(h.orgId, undefined, { includeClientEmitted: false });
    const c = s.clients.find((x) => x.clientId === h.clientId)!;

    // Only OS is billed; client-system AI is display-only.
    expect(c.costPence).toBe(1_000);
    expect(c.billablePence).toBe(1_250); // round(1000 × 1.25)
    expect(c.markupPence).toBe(250);
    expect(c.osBillablePence).toBe(1_250);
    expect(c.clientSystemAiPence).toBe(1_000); // shown, not billed
    expect(c.clientSystemAiBillablePence).toBe(0);
    expect(c.clientEmittedBilled).toBe(false);

    expect(s.includeClientEmitted).toBe(false);
    expect(s.totals.billablePence).toBe(1_250); // excludes client-system AI
  });

  // The case the skeptic proved missing: a client whose ENTIRE spend is the
  // client-system AI rollup (zero OS cost). Under the v1 total this was billed
  // marked up; the default must reproduce that (no retroactive £0 statement).
  it("bills a rollup-only client marked-up by default; display-only when excluded", async () => {
    const h2 = await createMoneyHarness();
    await insertClientAiRollup({ orgId: h2.orgId, projectId: h2.projectId, periodStart: dayInMonth(0), pence: 500 });
    await setClientMarkup(h2.orgId, h2.clientId, 20);

    const dflt = await getCostStatements(h2.orgId);
    const cd = dflt.clients.find((x) => x.clientId === h2.clientId)!;
    expect(cd.osCostPence).toBe(0);
    expect(cd.clientSystemAiPence).toBe(500);
    expect(cd.costPence).toBe(500);
    expect(cd.billablePence).toBe(600); // round(500 × 1.20)
    expect(cd.markupPence).toBe(100);
    expect(cd.clientEmittedBilled).toBe(true);

    const excl = await getCostStatements(h2.orgId, undefined, { includeClientEmitted: false });
    const ce = excl.clients.find((x) => x.clientId === h2.clientId)!;
    expect(ce.costPence).toBe(0);
    expect(ce.billablePence).toBe(0); // nothing billed
    expect(ce.clientSystemAiPence).toBe(500); // display-only
    expect(ce.clientEmittedBilled).toBe(false);

    await cleanupMoneyHarness(h2);
  });

  it("stays v1-identical for a client with only OS cost", async () => {
    const h2 = await createMoneyHarness();
    await insertAgentRun({ orgId: h2.orgId, clientId: h2.clientId, projectId: h2.projectId, agent: "daily_brief", startedAt: dayInMonth(0), costEstimatePence: 1_000 });
    await setClientMarkup(h2.orgId, h2.clientId, 0);
    const s = await getCostStatements(h2.orgId);
    const c = s.clients.find((x) => x.clientId === h2.clientId)!;
    expect(c.costPence).toBe(1_000);
    expect(c.billablePence).toBe(1_000); // pct 0 → billable == cost
    expect(c.clientSystemAiPence).toBe(0);
    expect(c.providers).toEqual([]);
    await cleanupMoneyHarness(h2);
  });
});
