import Anthropic from "@anthropic-ai/sdk";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AGENT_MODEL } from "@azen/config";
import {
  clearAgentRuns,
  cleanupHarness,
  createHarness,
  insertAgentRunCost,
  readAgentRuns,
  type AgentsHarness,
} from "./helpers";

/**
 * runAgent chassis tests (docs/phase3/CONTRACTS.md §P3-RUNNER): success +
 * agent_runs row, parse retry-once-then-fail, budget halt blocks non-critical
 * but lets critical through, provider-error mapping. getAnthropic is MOCKED —
 * NO live API calls; a real throwaway-org DB backs the agent_runs assertions.
 */

const h = vi.hoisted(() => ({ parseMock: vi.fn() }));

// The ONLY Anthropic access funnels through getAnthropic() — mock it.
vi.mock("../src/anthropic", () => ({
  getAnthropic: () => ({ messages: { parse: h.parseMock } }),
}));

import { runAgent } from "../src/runner";

const OutSchema = z.object({ headline: z.string() });
type Out = z.infer<typeof OutSchema>;

function parseResult(
  parsed: unknown,
  inTok: number,
  outTok: number,
): { parsed_output: unknown; usage: { input_tokens: number; output_tokens: number } } {
  return {
    parsed_output: parsed,
    usage: { input_tokens: inTok, output_tokens: outTok },
  };
}

function baseOpts(harness: AgentsHarness) {
  return {
    agent: "daily_brief" as const,
    orgId: harness.orgId,
    systemPrompt: "system prompt",
    userContent: "{}",
    schema: OutSchema as z.ZodType<Out>,
  };
}

let harness: AgentsHarness;

beforeAll(async () => {
  harness = await createHarness("Runner Test");
});

afterEach(async () => {
  h.parseMock.mockReset();
  await clearAgentRuns(harness.orgId);
});

afterAll(async () => {
  await cleanupHarness(harness);
});

describe("runAgent — success", () => {
  it("returns the parsed output and logs a succeeded agent_runs row with cost + attribution", async () => {
    // cost = round((100000*0.03 + 20000*0.15)/1000) = round(6.0) = 6 pence
    h.parseMock.mockResolvedValueOnce(
      parseResult({ headline: "Revenue up 20%" }, 100_000, 20_000),
    );

    const res = await runAgent<Out>({
      ...baseOpts(harness),
      projectId: harness.projectId,
      clientId: harness.clientId,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error);
    expect(res.output.headline).toBe("Revenue up 20%");
    expect(res.tokensIn).toBe(100_000);
    expect(res.tokensOut).toBe(20_000);
    expect(res.costPence).toBe(6);
    expect(h.parseMock).toHaveBeenCalledTimes(1);

    const rows = await readAgentRuns(harness.orgId);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.id).toBe(res.runId);
    expect(row.agent).toBe("daily_brief");
    expect(row.status).toBe("succeeded");
    expect(row.model).toBe(AGENT_MODEL);
    expect(row.tokens_in).toBe(100_000);
    expect(row.tokens_out).toBe(20_000);
    expect(row.cost_estimate_pence).toBe(6);
    expect(row.error).toBeNull();
    expect(row.project_id).toBe(harness.projectId);
    expect(row.client_id).toBe(harness.clientId);
    expect(row.finished_at).not.toBeNull();
    expect(row.output_refs).toMatchObject({ agent: "daily_brief" });
    expect(typeof row.output_refs.promptVersion).toBe("string");
  });
});

describe("runAgent — parse retry", () => {
  it("retries once when parsed_output is null, then succeeds (tokens summed)", async () => {
    h.parseMock
      .mockResolvedValueOnce(parseResult(null, 10, 0))
      .mockResolvedValueOnce(parseResult({ headline: "Second try" }, 100_000, 20_000));

    const res = await runAgent<Out>(baseOpts(harness));

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error);
    expect(res.output.headline).toBe("Second try");
    // 10 + 100000 in, 0 + 20000 out
    expect(res.tokensIn).toBe(100_010);
    expect(res.tokensOut).toBe(20_000);
    expect(h.parseMock).toHaveBeenCalledTimes(2);

    const rows = await readAgentRuns(harness.orgId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("succeeded");
  });

  it("fails parse_failed after exactly one retry when both parses are null", async () => {
    h.parseMock
      .mockResolvedValueOnce(parseResult(null, 10, 5))
      .mockResolvedValueOnce(parseResult(null, 10, 5));

    const res = await runAgent<Out>(baseOpts(harness));

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected failure");
    expect(res.error).toBe("parse_failed");
    expect(res.status).toBe(502);
    expect(h.parseMock).toHaveBeenCalledTimes(2);

    const rows = await readAgentRuns(harness.orgId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("failed");
    expect(rows[0]!.error).toBe("parse_failed");
  });
});

describe("runAgent — budget guard", () => {
  it("halts a non-critical run at 100% of cap but lets a critical run through", async () => {
    // Push spend to the cap so checkBudget → 'halt'. Default cap is £100 = 10000p.
    await insertAgentRunCost(harness.orgId, 10_000);

    // Non-critical: blocked WITHOUT ever calling the model.
    const blocked = await runAgent<Out>(baseOpts(harness));
    expect(blocked.ok).toBe(false);
    if (blocked.ok) throw new Error("expected block");
    expect(blocked.error).toBe("budget_exceeded");
    expect(blocked.status).toBe(402);
    expect(h.parseMock).not.toHaveBeenCalled();

    // Critical: bypasses the halt and runs the model.
    h.parseMock.mockResolvedValueOnce(
      parseResult({ headline: "Brief always runs" }, 1000, 500),
    );
    const critical = await runAgent<Out>({ ...baseOpts(harness), critical: true });
    expect(critical.ok).toBe(true);
    if (!critical.ok) throw new Error(critical.error);
    expect(critical.output.headline).toBe("Brief always runs");
    expect(h.parseMock).toHaveBeenCalledTimes(1);

    // The blocked run still logged a failed budget_exceeded row (auditability).
    const rows = await readAgentRuns(harness.orgId);
    const budgetRow = rows.find((r) => r.error === "budget_exceeded");
    expect(budgetRow).toBeDefined();
    expect(budgetRow!.status).toBe("failed");
  });
});

describe("runAgent — provider error mapping", () => {
  it("maps auth, rate-limit, and generic API errors to typed codes", async () => {
    h.parseMock.mockRejectedValueOnce(
      new Anthropic.AuthenticationError(401, undefined, "invalid x-api-key", new Headers()),
    );
    const auth = await runAgent<Out>(baseOpts(harness));
    expect(auth.ok).toBe(false);
    if (auth.ok) throw new Error("expected failure");
    expect(auth.error).toBe("anthropic_auth");
    expect(auth.status).toBe(502);

    h.parseMock.mockRejectedValueOnce(
      new Anthropic.RateLimitError(429, undefined, "slow down", new Headers()),
    );
    const rate = await runAgent<Out>(baseOpts(harness));
    expect(rate.ok).toBe(false);
    if (rate.ok) throw new Error("expected failure");
    expect(rate.error).toBe("anthropic_rate_limited");
    expect(rate.status).toBe(429);

    h.parseMock.mockRejectedValueOnce(
      new Anthropic.APIError(500, undefined, "boom", new Headers()),
    );
    const generic = await runAgent<Out>(baseOpts(harness));
    expect(generic.ok).toBe(false);
    if (generic.ok) throw new Error("expected failure");
    expect(generic.error).toBe("agent_failed");
    expect(generic.status).toBe(502);

    // Every failure path logged a failed row.
    const rows = await readAgentRuns(harness.orgId);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.status === "failed")).toBe(true);
  });
});
