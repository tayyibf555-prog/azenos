import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getApiCostData } from "../../lib/server/analytics/api-cost";
import { parseRange } from "../../lib/server/analytics/base";
import { createMoneyHarness, cleanupMoneyHarness, type MoneyHarness } from "../money/helpers";
import { insertAgentRun, insertEvent } from "./helpers";

/**
 * API-Cost stream-merge math (P9-COST). Hand-built OS agent_runs + client-
 * emitted agent.run.completed events; the two streams stay separate and the
 * totals / ratios are fully determined by the fixture.
 */
describe("getApiCostData stream merge", () => {
  let h: MoneyHarness;
  const now = new Date();
  const range = parseRange(new URLSearchParams("range=30d"));

  beforeEach(async () => {
    h = await createMoneyHarness();
  });

  afterEach(async () => {
    await cleanupMoneyHarness(h);
  });

  it("merges OS + client-emitted spend, tokens, providers and ratios", async () => {
    // ── OS stream: two runs (£10 + £5), tokens 100/50 + 200/80 ──
    await insertAgentRun({ orgId: h.orgId, clientId: h.clientId, projectId: h.projectId, agent: "daily_brief", startedAt: now, costEstimatePence: 1_000, tokensIn: 100, tokensOut: 50 });
    await insertAgentRun({ orgId: h.orgId, clientId: h.clientId, projectId: h.projectId, agent: "weekly_synth", startedAt: now, costEstimatePence: 500, tokensIn: 200, tokensOut: 80 });

    // ── client-emitted: anthropic £3 (30/20), openai £7, missing-provider £1 ──
    await insertEvent({ orgId: h.orgId, projectId: h.projectId, type: "agent.run.completed", occurredAt: now, data: { provider: "anthropic", cost_pence: 300, tokens_in: 30, tokens_out: 20 } });
    await insertEvent({ orgId: h.orgId, projectId: h.projectId, type: "agent.run.completed", occurredAt: now, data: { provider: "openai", cost_pence: 700 } });
    await insertEvent({ orgId: h.orgId, projectId: h.projectId, type: "agent.run.completed", occurredAt: now, data: { cost_pence: 100 } });

    // ── denominators: 4 conversations (2 resolved), 2 outcomes ──
    await insertEvent({ orgId: h.orgId, projectId: h.projectId, type: "llm.conversation", occurredAt: now, data: { resolution: "resolved" } });
    await insertEvent({ orgId: h.orgId, projectId: h.projectId, type: "llm.conversation", occurredAt: now, data: { resolution: "resolved" } });
    await insertEvent({ orgId: h.orgId, projectId: h.projectId, type: "llm.conversation", occurredAt: now, data: { resolution: "escalated" } });
    await insertEvent({ orgId: h.orgId, projectId: h.projectId, type: "llm.conversation", occurredAt: now, data: {} });
    await insertEvent({ orgId: h.orgId, projectId: h.projectId, type: "payment.captured", occurredAt: now, data: {}, valuePence: 5_000 });
    await insertEvent({ orgId: h.orgId, projectId: h.projectId, type: "booking.created", occurredAt: now, data: {} });

    const d = await getApiCostData(h.orgId, h.projectId, range);

    // stream totals
    expect(d.osPence).toBe(1_500);
    expect(d.emittedPence).toBe(1_100);
    expect(d.totalPence).toBe(2_600);
    expect(d.osRuns).toBe(2);
    expect(d.emittedRuns).toBe(3);

    // tokens
    expect(d.osTokensIn).toBe(300);
    expect(d.osTokensOut).toBe(130);
    expect(d.emittedTokensIn).toBe(30);
    expect(d.emittedTokensOut).toBe(20);

    // providers, descending, missing → 'other'
    expect(d.byProvider.map((p) => [p.provider, p.pence])).toEqual([
      ["openai", 700],
      ["anthropic", 300],
      ["other", 100],
    ]);

    // OS agents present
    expect(d.byAgent.map((a) => a.pence).reduce((x, y) => x + y, 0)).toBe(1_500);

    // efficiency ratios: total 2600 ÷ denom
    expect(d.conversations).toBe(4);
    expect(d.resolutions).toBe(2);
    expect(d.outcomes).toBe(2);
    expect(d.costPerConversationPence).toBe(650);
    expect(d.costPerResolutionPence).toBe(1_300);
    expect(d.costPerOutcomePence).toBe(1_300);

    // series is zero-filled to the window length and reconciles to the totals
    expect(d.series).toHaveLength(range.days);
    expect(d.series.reduce((a, p) => a + p.osPence, 0)).toBe(1_500);
    expect(d.series.reduce((a, p) => a + p.emittedPence, 0)).toBe(1_100);

    // top run is the £10 OS run
    expect(d.topRuns[0]!.pence).toBe(1_000);
    expect(d.topRuns[0]!.stream).toBe("os");
    expect(d.topRuns).toHaveLength(5); // 2 os + 3 emitted, all cost > 0
  });

  it("counts the terminal booking.created once and ignores booking.completed", async () => {
    // LEAD RULING 2026-07-16 (P9-COST #1): booking.created is the outcome;
    // booking.completed is lifecycle and must not be counted at all.
    // A booking emits BOTH created and completed — only the created counts.
    await insertEvent({ orgId: h.orgId, projectId: h.projectId, type: "booking.created", occurredAt: now, subject: { kind: "booking", id: "bk-1" }, data: {} });
    await insertEvent({ orgId: h.orgId, projectId: h.projectId, type: "booking.completed", occurredAt: now, subject: { kind: "booking", id: "bk-1" }, data: {} });
    // A second, distinct booking with no subject id — still its own outcome.
    await insertEvent({ orgId: h.orgId, projectId: h.projectId, type: "booking.created", occurredAt: now, data: {} });
    // A stray booking.completed with NO matching created (differing subject) must
    // NOT add an outcome now that completed is out of the set.
    await insertEvent({ orgId: h.orgId, projectId: h.projectId, type: "booking.completed", occurredAt: now, subject: { kind: "booking", id: "bk-orphan" }, data: {} });
    // Spend so the ratio is defined.
    await insertEvent({ orgId: h.orgId, projectId: h.projectId, type: "agent.run.completed", occurredAt: now, data: { provider: "openai", cost_pence: 400 } });

    const d = await getApiCostData(h.orgId, h.projectId, range);
    expect(d.outcomes).toBe(2); // two booking.created; both completeds ignored
    expect(d.costPerOutcomePence).toBe(200); // 400 ÷ 2
  });

  it("reconciles the emitted headline to its per-provider and daily parts under fractional pence", async () => {
    // cost_pence is schema-valid as a fractional number. Two providers, each
    // summing to x.4 pence, must not let round-once-per-group drift the headline
    // away from the sum of the parts.
    await insertEvent({ orgId: h.orgId, projectId: h.projectId, type: "agent.run.completed", occurredAt: now, data: { provider: "anthropic", cost_pence: 10.4 } });
    await insertEvent({ orgId: h.orgId, projectId: h.projectId, type: "agent.run.completed", occurredAt: now, data: { provider: "openai", cost_pence: 10.4 } });

    const d = await getApiCostData(h.orgId, h.projectId, range);
    const providerSum = d.byProvider.reduce((a, p) => a + p.pence, 0);
    const seriesSum = d.series.reduce((a, p) => a + p.emittedPence, 0);
    expect(providerSum).toBe(d.emittedPence);
    expect(seriesSum).toBe(d.emittedPence);
    expect(d.totalPence).toBe(d.osPence + d.emittedPence);
  });

  it("returns zeros / empty for a project with no cost", async () => {
    const d = await getApiCostData(h.orgId, h.projectId, range);
    expect(d.totalPence).toBe(0);
    expect(d.osPence).toBe(0);
    expect(d.emittedPence).toBe(0);
    expect(d.byProvider).toEqual([]);
    expect(d.byAgent).toEqual([]);
    expect(d.costPerConversationPence).toBeNull();
    expect(d.costPerOutcomePence).toBeNull();
    expect(d.topRuns).toEqual([]);
  });
});
