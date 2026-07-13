import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import type { AskTool, ToolResult } from "./types";
import { getBusinessSnapshot } from "./snapshot";
import { queryMetricRollups } from "./metrics";
import { searchEvents } from "./events";
import { listBookings } from "./bookings";
import { listExpenses, listPayments, moneySummary } from "./money";
import { searchBriefsInsights } from "./insights";
import { searchKnowledge } from "./knowledge";
import { runSql } from "./sql";

/**
 * The Ask Azen read-only tool belt (docs/phase3b/CONTRACTS.md §P3B-TOOLS).
 * ASK_TOOLS is the registry; toAnthropicTools projects it to the Messages API
 * `tools` param (JSON schemas from the zod inputSchemas); runTool validates and
 * dispatches by name, never throwing to the caller.
 *
 * Order = the order the model sees them: the cheap orient-first snapshot, then
 * the structured readers, with run_sql last (the discouraged escape hatch).
 */
export const ASK_TOOLS: readonly AskTool[] = [
  getBusinessSnapshot,
  queryMetricRollups,
  searchEvents,
  moneySummary,
  listPayments,
  listExpenses,
  listBookings,
  searchBriefsInsights,
  searchKnowledge,
  runSql,
];

export type { AskTool, ToolResult } from "./types";
export { defineTool } from "./types";

const BY_NAME: ReadonlyMap<string, AskTool> = new Map(
  ASK_TOOLS.map((t) => [t.name, t] as const),
);

/** Project the registry to the Anthropic Messages API `tools` param. */
export function toAnthropicTools(tools: readonly AskTool[]): Anthropic.Tool[] {
  return tools.map((t) => {
    const json = z.toJSONSchema(t.inputSchema) as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    return {
      name: t.name,
      description: t.description,
      input_schema: {
        type: "object",
        properties: json.properties ?? {},
        ...(json.required ? { required: json.required } : {}),
      },
    };
  });
}

/**
 * Validate `input` against the named tool's schema and run it, org-scoped.
 * Unknown tool, invalid input, and any thrown error all become a ToolResult
 * error (the loop always gets a tool_result to feed back to the model).
 */
export async function runTool(
  name: string,
  orgId: string,
  input: unknown,
): Promise<ToolResult> {
  const tool = BY_NAME.get(name);
  if (!tool) return { ok: false, error: `unknown tool: ${name}` };

  const parsed = tool.inputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: `invalid input for ${name}: ${parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`)
        .join("; ")}`,
    };
  }

  try {
    return await tool.run(orgId, parsed.data);
  } catch (err) {
    // Provider/DB error detail stays server-side; the model gets a terse note.
    console.error(`[ask-tool ${name}] failed:`, err);
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `tool ${name} failed: ${msg.slice(0, 200)}` };
  }
}
