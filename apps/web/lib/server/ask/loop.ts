import type Anthropic from "@anthropic-ai/sdk";
import { CHAT_MODEL } from "@azen/config";
import { getAnthropic } from "@azen/agents";
import { ASK_TOOLS, runTool, toAnthropicTools, type ToolResult } from "./tools";

/**
 * Ask Azen — the multi-turn tool-use loop (docs/phase3b/CONTRACTS.md §P3B-CHAT).
 * Streams the model's text as it generates AND captures the full ordered
 * tool-call trace for persistence (chat's data_snapshot). A hard cap of
 * MAX_TOOL_CALLS tool executions per user turn prevents runaway loops: once the
 * cap is hit the next model call is made WITHOUT tools so the model is forced to
 * produce a final text answer.
 *
 * The loop is an async generator yielding events the route relays as SSE; the
 * terminal `done` event carries the assistant text, usage, and the trace so the
 * route can write one chat_message. Errors are NOT swallowed here — the route
 * maps provider errors (auth/rate-limit) to friendly SSE and never surfaces raw
 * detail (spec §15).
 */

/** Hard cap on tool executions per user turn (contract: 12). */
export const MAX_TOOL_CALLS = 12;
/** Output token ceiling per model turn. */
const MAX_TOKENS = 2048;

/** One entry in the persisted tool-call trace ("how I got this"). */
export interface AskToolCall {
  name: string;
  input: unknown;
  ok: boolean;
  /** Compact preview of the tool result, for the trace UI. */
  resultSummary: string;
}

export interface AskUsage {
  tokensIn: number;
  tokensOut: number;
  costEstimatePence: number;
}

/** The terminal payload: everything the route persists on the assistant row. */
export interface AskResult extends AskUsage {
  contentMd: string;
  toolCalls: AskToolCall[];
  /** true when the tool-call cap forced an early final answer. */
  stoppedAtCap: boolean;
}

export type AskEvent =
  | { type: "text"; delta: string }
  | { type: "tool"; name: string; input: unknown }
  | { type: "tool_result"; name: string; ok: boolean; resultSummary: string }
  | { type: "partial"; result: AskResult }
  | { type: "done"; result: AskResult };

/** A prior conversation turn, replayed as text-only history. */
export interface AskHistoryTurn {
  role: "user" | "assistant";
  contentMd: string;
}

export interface RunAskLoopOptions {
  orgId: string;
  systemPrompt: string;
  /** Prior turns of the session (text only — tool blocks are not replayed). */
  history?: AskHistoryTurn[];
  userMessage: string;
}

// ── injectable client seam (tests pass a fake; prod uses the fleet client) ──────
interface AskStreamParams {
  model: string;
  max_tokens: number;
  system: string;
  messages: Anthropic.MessageParam[];
  tools?: Anthropic.Tool[];
}
export interface AskMessageStream
  extends AsyncIterable<Anthropic.RawMessageStreamEvent> {
  finalMessage(): Promise<Anthropic.Message>;
}
export interface AskAnthropicClient {
  messages: { stream(params: AskStreamParams): AskMessageStream };
}
export interface RunAskLoopDeps {
  getClient: () => AskAnthropicClient;
}

function defaultDeps(): RunAskLoopDeps {
  return {
    getClient: () => {
      const real = getAnthropic();
      return {
        messages: {
          stream: (params) =>
            real.messages.stream(
              params as unknown as Parameters<typeof real.messages.stream>[0],
            ) as unknown as AskMessageStream,
        },
      };
    },
  };
}

/**
 * v1 cost model — identical to the fleet runner (packages/agents/src/runner.ts):
 * USD-cents ≈ pence; input £0.03 / output £0.15 per 1k tokens. Chat cost counts
 * against the same monthly budget (§13), so the formula MUST match.
 */
function estimateChatCostPence(tokensIn: number, tokensOut: number): number {
  return Math.round((tokensIn * 0.03 + tokensOut * 0.15) / 1000);
}

/** Full result JSON fed back to the model (tools already cap their payloads). */
function toolResultContent(r: ToolResult): string {
  if (!r.ok) return `Tool error: ${r.error}`;
  const s = JSON.stringify(r.data);
  return s.length > 20_000 ? `${s.slice(0, 20_000)}…(truncated)` : s;
}

/** Compact preview stored in the trace (the collapsible "how I got this"). */
function summarizeResult(r: ToolResult): string {
  if (!r.ok) return `error: ${r.error}`;
  const s = JSON.stringify(r.data);
  return s.length > 600 ? `${s.slice(0, 600)}…(truncated)` : s;
}

export async function* runAskLoop(
  opts: RunAskLoopOptions,
  deps: RunAskLoopDeps = defaultDeps(),
): AsyncGenerator<AskEvent, void, void> {
  const client = deps.getClient();
  const anthropicTools = toAnthropicTools(ASK_TOOLS);

  const messages: Anthropic.MessageParam[] = [
    ...(opts.history ?? []).map(
      (t): Anthropic.MessageParam => ({ role: t.role, content: t.contentMd }),
    ),
    { role: "user", content: opts.userMessage },
  ];

  let tokensIn = 0;
  let tokensOut = 0;
  let contentMd = "";
  let stoppedAtCap = false;
  const trace: AskToolCall[] = [];

  const buildResult = (): AskResult => ({
    contentMd,
    toolCalls: trace,
    tokensIn,
    tokensOut,
    costEstimatePence: estimateChatCostPence(tokensIn, tokensOut),
    stoppedAtCap,
  });

  try {
    // Each iteration = one model turn. We stop when the model returns a non
    // tool_use turn, or when the cap forces a tool-less final answer.
    for (;;) {
      const useTools = trace.length < MAX_TOOL_CALLS;
      const stream = client.messages.stream({
        model: CHAT_MODEL,
        max_tokens: MAX_TOKENS,
        system: opts.systemPrompt,
        messages,
        ...(useTools ? { tools: anthropicTools } : {}),
      });

      for await (const ev of stream) {
        if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
          yield { type: "text", delta: ev.delta.text };
        }
      }

      const msg = await stream.finalMessage();
      tokensIn += msg.usage.input_tokens;
      tokensOut += msg.usage.output_tokens;

      // ACCUMULATE this turn's text blocks — do not reassign. Every turn's text
      // deltas are streamed to the browser, so the persisted answer must be the
      // concatenation of ALL turns' text: a tool_use turn commonly emits
      // narrative text (e.g. "Let me check the metrics…") before a later turn
      // finalizes. Reassigning would drop that earlier streamed text and could
      // even persist "" when a forced tool-less final turn returns no text.
      contentMd += msg.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");

      const toolUses = msg.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
      );

      if (!useTools || msg.stop_reason !== "tool_use" || toolUses.length === 0) {
        break;
      }

      // Replay the assistant's tool_use turn, then answer every tool_use with a
      // matching tool_result (the API requires 1:1 — even for calls we refuse
      // past the cap, or the next turn errors).
      messages.push({
        role: "assistant",
        content: msg.content as unknown as Anthropic.ContentBlockParam[],
      });
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const tu of toolUses) {
        if (trace.length >= MAX_TOOL_CALLS) {
          stoppedAtCap = true;
          toolResults.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: "Tool-call limit reached for this turn; answer from what you have.",
            is_error: true,
          });
          continue;
        }
        yield { type: "tool", name: tu.name, input: tu.input };
        const result = await runTool(tu.name, opts.orgId, tu.input);
        // Compute the preview once: it feeds both the live trace event (so the
        // "how I got this" preview renders during streaming, not only after a
        // DB re-hydration) and the persisted trace entry.
        const resultSummary = summarizeResult(result);
        yield { type: "tool_result", name: tu.name, ok: result.ok, resultSummary };
        trace.push({
          name: tu.name,
          input: tu.input,
          ok: result.ok,
          resultSummary,
        });
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: toolResultContent(result),
          is_error: !result.ok,
        });
      }
      messages.push({ role: "user", content: toolResults });
      // Cap reached → the next turn is made tool-less to force a final answer.
      if (trace.length >= MAX_TOOL_CALLS) stoppedAtCap = true;
    }
  } catch (err) {
    // A provider error (auth/rate-limit) can be thrown mid-stream AFTER earlier
    // turns already consumed tokens. Surface what we accumulated so the route can
    // persist the partial cost (the budget must include it, §13) and pair the
    // user turn, then re-throw so the route maps the error to friendly SSE (§15).
    yield { type: "partial", result: buildResult() };
    throw err;
  }

  yield { type: "done", result: buildResult() };
}
