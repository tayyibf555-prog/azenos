import { randomUUID } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import { AGENT_MODEL } from "@azen/config";
import { agentRuns, db } from "@azen/db";
import { getAnthropic } from "./anthropic";
import { PROMPT_VERSION } from "./prompt";

/**
 * Shared runner for both intake routes: one non-streaming structured-output
 * call, an agent_runs audit row, and provider-error mapping. NEVER surfaces a
 * raw provider error to the caller (spec §15) — detail is console.error only.
 */

export interface IntakeRunParams<TSchema extends z.ZodType> {
  orgId: string;
  /**
   * Cost attribution (contract addendum §B): set both when the run already
   * serves a known project. Intake/refine runs predate the project, so they
   * log null and are backfilled via POST /api/projects/intake/attribute.
   */
  projectId?: string | null;
  clientId?: string | null;
  system: string;
  /** The user message — the transcript (intake) or the instruction (refine). */
  userContent: string;
  /** Zod schema wrapped by zodOutputFormat; `parsed_output` is typed from it. */
  schema: TSchema;
  /** Distinguishes the two flows in the audit row's output_refs. */
  mode: "intake" | "refine";
}

export type IntakeRunResult<T> =
  | { ok: true; runId: string; parsed: T; tokensIn: number; tokensOut: number }
  | { ok: false; status: number; error: string };

// max_tokens per contract; temperature/top_p unset (Sonnet 5 rejects them),
// adaptive thinking left on by default, no assistant prefill.
const MAX_TOKENS = 4000;

/** v1 cost model (documented): USD-cents ≈ pence. Contract formula, verbatim. */
function estimateCostPence(tokensIn: number, tokensOut: number): number {
  return Math.round((tokensIn * 0.03 + tokensOut * 0.15) / 1000);
}

interface MappedError {
  status: number;
  error: string;
}

function mapProviderError(err: unknown): MappedError {
  if (err instanceof Anthropic.AuthenticationError) {
    return { status: 502, error: "anthropic_auth" };
  }
  if (err instanceof Anthropic.RateLimitError) {
    return { status: 429, error: "anthropic_rate_limited" };
  }
  if (err instanceof Anthropic.APIError) {
    return { status: 502, error: "intake_failed" };
  }
  // A missing/empty ANTHROPIC_API_KEY throws a construction-time AnthropicError
  // (not an APIError) — treat it as an auth failure so the UI shows the banner.
  if (err instanceof Error && /ANTHROPIC_API_KEY/i.test(err.message)) {
    return { status: 502, error: "anthropic_auth" };
  }
  return { status: 502, error: "intake_failed" };
}

/**
 * Best-effort agent_runs audit row. Column adaptation vs the contract's field
 * list: kind→`agent` (enum value "project_intake"); costPence→`costEstimatePence`;
 * `durationMs`, `inputSummary`, `promptVersion`, `mode` have no columns → stored
 * in `outputRefs`. projectId/clientId (migration 0005) are written when the
 * caller knows them; null = unattributed until /intake/attribute backfills.
 * Logging never breaks the response — a failed insert is swallowed.
 */
async function logAgentRun(row: {
  id: string;
  orgId: string;
  projectId: string | null;
  clientId: string | null;
  startedAt: Date;
  status: "succeeded" | "failed";
  tokensIn: number | null;
  tokensOut: number | null;
  error: string | null;
  mode: string;
  inputSummary: string;
}): Promise<void> {
  const finishedAt = new Date();
  const costEstimatePence =
    row.tokensIn !== null && row.tokensOut !== null
      ? estimateCostPence(row.tokensIn, row.tokensOut)
      : null;
  try {
    await db.insert(agentRuns).values({
      id: row.id,
      orgId: row.orgId,
      projectId: row.projectId,
      clientId: row.clientId,
      agent: "project_intake",
      startedAt: row.startedAt,
      finishedAt,
      status: row.status,
      model: AGENT_MODEL,
      tokensIn: row.tokensIn,
      tokensOut: row.tokensOut,
      costEstimatePence,
      error: row.error,
      outputRefs: {
        mode: row.mode,
        promptVersion: PROMPT_VERSION,
        durationMs: finishedAt.getTime() - row.startedAt.getTime(),
        inputSummary: row.inputSummary,
      },
    });
  } catch (err) {
    console.error("[intake] agent_runs log failed:", err);
  }
}

export async function runIntakeAgent<TSchema extends z.ZodType>(
  params: IntakeRunParams<TSchema>,
): Promise<IntakeRunResult<z.infer<TSchema>>> {
  const runId = randomUUID();
  const startedAt = new Date();
  const inputSummary = params.userContent.slice(0, 200);
  const projectId = params.projectId ?? null;
  const clientId = params.clientId ?? null;

  try {
    const client = getAnthropic();
    const response = await client.messages.parse({
      model: AGENT_MODEL,
      max_tokens: MAX_TOKENS,
      system: params.system,
      messages: [{ role: "user", content: params.userContent }],
      output_config: { format: zodOutputFormat(params.schema) },
    });

    const tokensIn = response.usage.input_tokens;
    const tokensOut = response.usage.output_tokens;
    const parsed = response.parsed_output as z.infer<TSchema> | null;

    if (parsed === null) {
      await logAgentRun({
        id: runId,
        orgId: params.orgId,
        projectId,
        clientId,
        startedAt,
        status: "failed",
        tokensIn,
        tokensOut,
        error: "intake_parse_failed",
        mode: params.mode,
        inputSummary,
      });
      return { ok: false, status: 502, error: "intake_parse_failed" };
    }

    await logAgentRun({
      id: runId,
      orgId: params.orgId,
      projectId,
      clientId,
      startedAt,
      status: "succeeded",
      tokensIn,
      tokensOut,
      error: null,
      mode: params.mode,
      inputSummary,
    });
    return { ok: true, runId, parsed, tokensIn, tokensOut };
  } catch (err) {
    const mapped = mapProviderError(err);
    console.error(`[intake] ${params.mode} run failed (${mapped.error}):`, err);
    await logAgentRun({
      id: runId,
      orgId: params.orgId,
      projectId,
      clientId,
      startedAt,
      status: "failed",
      tokensIn: null,
      tokensOut: null,
      error: mapped.error,
      mode: params.mode,
      inputSummary,
    });
    return { ok: false, status: mapped.status, error: mapped.error };
  }
}
