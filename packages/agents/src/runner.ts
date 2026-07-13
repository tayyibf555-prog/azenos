import { randomUUID } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import { AGENT_MODEL } from "@azen/config";
import { agentRuns, db, osAgentKind } from "@azen/db";
import { getAnthropic } from "./anthropic";
import { checkBudget } from "./budget";
import { PROMPT_VERSION } from "./prompts/shared";

/**
 * The fleet runner chassis (docs/phase3/CONTRACTS.md §P3-RUNNER). Every current
 * and future agent runs through runAgent: one structured-output call with
 * retry-once-on-null, a budget guard (with a critical bypass), an agent_runs
 * audit row on every path (with model/tokens/cost + project/client
 * attribution), and provider-error mapping. A raw provider error is NEVER
 * surfaced upward — detail is console.error only (spec §15).
 */

/** os_agent_kind enum values, from the schema (the SCHEMA is reality). */
export type OsAgentKind = (typeof osAgentKind.enumValues)[number];

export type AgentErrorCode =
  | "budget_exceeded"
  | "anthropic_auth"
  | "anthropic_rate_limited"
  | "parse_failed"
  | "agent_failed";

export interface RunAgentOptions<TOutput> {
  agent: OsAgentKind;
  orgId: string;
  /** Cost attribution for client billing (§13) — set both when known. */
  projectId?: string | null;
  clientId?: string | null;
  /** The versioned system prompt (from a prompts/*.ts module). */
  systemPrompt: string;
  /** The serialized deterministic data-pack JSON. */
  userContent: string;
  /** Structured-output schema; `output` is typed from it. */
  schema: z.ZodType<TOutput>;
  /** default 4000 */
  maxTokens?: number;
  /** Stored by the caller on the output row; carried here for symmetry. */
  dataSnapshot?: Record<string, unknown>;
  /** true bypasses a budget halt (the daily brief always runs, §13). */
  critical?: boolean;
}

export type AgentRunResult<T> =
  | {
      ok: true;
      runId: string;
      output: T;
      tokensIn: number;
      tokensOut: number;
      costPence: number;
    }
  | { ok: false; runId: string; status: number; error: AgentErrorCode };

const DEFAULT_MAX_TOKENS = 4000;
// One structured-output call, then exactly one retry if parsed_output is null.
const MAX_ATTEMPTS = 2;

/** v1 cost model (documented): USD-cents ≈ pence. Same formula as intake. */
function estimateCostPence(tokensIn: number, tokensOut: number): number {
  return Math.round((tokensIn * 0.03 + tokensOut * 0.15) / 1000);
}

function mapProviderError(err: unknown): { status: number; error: AgentErrorCode } {
  // Most-specific first (contract): auth → rate-limit → generic API error.
  if (err instanceof Anthropic.AuthenticationError) {
    return { status: 502, error: "anthropic_auth" };
  }
  if (err instanceof Anthropic.RateLimitError) {
    return { status: 429, error: "anthropic_rate_limited" };
  }
  if (err instanceof Anthropic.APIError) {
    return { status: 502, error: "agent_failed" };
  }
  // A missing/empty ANTHROPIC_API_KEY throws a construction-time error (not an
  // APIError) — treat it as auth so the UI shows the "add a key" banner.
  if (err instanceof Error && /ANTHROPIC_API_KEY/i.test(err.message)) {
    return { status: 502, error: "anthropic_auth" };
  }
  return { status: 502, error: "agent_failed" };
}

interface RunRow {
  id: string;
  orgId: string;
  agent: OsAgentKind;
  projectId: string | null;
  clientId: string | null;
  startedAt: Date;
  status: "succeeded" | "failed";
  tokensIn: number | null;
  tokensOut: number | null;
  error: AgentErrorCode | null;
}

/**
 * Best-effort agent_runs audit row (spec §13: every AI call logs cost + tokens +
 * project/client attribution). Column adaptation vs the contract's field list:
 * costPence→`costEstimatePence`; promptVersion/agent/durationMs have no columns
 * so they live in `outputRefs`. Logging never breaks the caller — a failed
 * insert is swallowed to console.error, exactly like the intake runner.
 */
async function logRun(row: RunRow): Promise<void> {
  const finishedAt = new Date();
  const costEstimatePence =
    row.tokensIn !== null && row.tokensOut !== null
      ? estimateCostPence(row.tokensIn, row.tokensOut)
      : null;
  try {
    await db.insert(agentRuns).values({
      id: row.id,
      orgId: row.orgId,
      agent: row.agent,
      projectId: row.projectId,
      clientId: row.clientId,
      startedAt: row.startedAt,
      finishedAt,
      status: row.status,
      model: AGENT_MODEL,
      tokensIn: row.tokensIn,
      tokensOut: row.tokensOut,
      costEstimatePence,
      error: row.error,
      outputRefs: {
        agent: row.agent,
        promptVersion: PROMPT_VERSION,
        durationMs: finishedAt.getTime() - row.startedAt.getTime(),
      },
    });
  } catch (err) {
    console.error("[agents] agent_runs log failed:", err);
  }
}

export async function runAgent<TOutput>(
  opts: RunAgentOptions<TOutput>,
): Promise<AgentRunResult<TOutput>> {
  const runId = randomUUID();
  const startedAt = new Date();
  const projectId = opts.projectId ?? null;
  const clientId = opts.clientId ?? null;

  const base = {
    id: runId,
    orgId: opts.orgId,
    agent: opts.agent,
    projectId,
    clientId,
    startedAt,
  } as const;

  // ── budget guard (critical bypass) ─────────────────────────────────────────
  try {
    const budget = await checkBudget(opts.orgId);
    if (budget.state === "halt" && !opts.critical) {
      await logRun({
        ...base,
        status: "failed",
        tokensIn: null,
        tokensOut: null,
        error: "budget_exceeded",
      });
      return { ok: false, runId, status: 402, error: "budget_exceeded" };
    }
  } catch (err) {
    // A budget-read failure fails OPEN for CRITICAL runs only (the daily brief
    // always runs, §13). For non-critical runs we cannot confirm we're under
    // the cap, so we fail CLOSED with budget_exceeded — proceeding would bypass
    // the halt guarantee the contract requires for non-critical work
    // (CONTRACTS.md §P3-RUNNER, lines 83-85).
    console.error("[agents] budget check failed:", err);
    if (!opts.critical) {
      await logRun({
        ...base,
        status: "failed",
        tokensIn: null,
        tokensOut: null,
        error: "budget_exceeded",
      });
      return { ok: false, runId, status: 402, error: "budget_exceeded" };
    }
  }

  // ── one structured-output call, retry once on null parse ────────────────────
  let tokensIn = 0;
  let tokensOut = 0;
  let parsed: TOutput | null = null;
  try {
    const client = getAnthropic();
    for (let attempt = 0; attempt < MAX_ATTEMPTS && parsed === null; attempt++) {
      const response = await client.messages.parse({
        model: AGENT_MODEL,
        max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
        // Static system prompt first + cache_control so the fleet reuses the
        // prompt cache across calls (model API facts, contract preamble).
        system: [
          {
            type: "text",
            text: opts.systemPrompt,
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: [{ role: "user", content: opts.userContent }],
        output_config: { format: zodOutputFormat(opts.schema) },
      });
      tokensIn += response.usage.input_tokens;
      tokensOut += response.usage.output_tokens;
      parsed = (response.parsed_output ?? null) as TOutput | null;
    }
  } catch (err) {
    const mapped = mapProviderError(err);
    console.error(`[agents] ${opts.agent} run failed (${mapped.error}):`, err);
    await logRun({
      ...base,
      status: "failed",
      tokensIn: tokensIn > 0 ? tokensIn : null,
      tokensOut: tokensOut > 0 ? tokensOut : null,
      error: mapped.error,
    });
    return { ok: false, runId, status: mapped.status, error: mapped.error };
  }

  if (parsed === null) {
    await logRun({
      ...base,
      status: "failed",
      tokensIn,
      tokensOut,
      error: "parse_failed",
    });
    return { ok: false, runId, status: 502, error: "parse_failed" };
  }

  await logRun({
    ...base,
    status: "succeeded",
    tokensIn,
    tokensOut,
    error: null,
  });
  return {
    ok: true,
    runId,
    output: parsed,
    tokensIn,
    tokensOut,
    costPence: estimateCostPence(tokensIn, tokensOut),
  };
}
