import type { z } from "zod";

/**
 * P3B-TOOLS — the read-only tool belt for Ask Azen (docs/phase3b/CONTRACTS.md
 * §P3B-TOOLS). Every tool is org-scoped (takes orgId, filters by it) except
 * run_sql, the guarded escape hatch. A tool NEVER throws to its caller: runTool
 * wraps invocation and maps any failure to a ToolResult error, so the chat loop
 * can always feed a tool_result back to the model.
 */

export type ToolResult =
  | { ok: true; data: unknown }
  | { ok: false; error: string };

/**
 * A registered tool. `inputSchema` is the zod boundary; runTool validates
 * against it before calling `run`, so `run` receives already-validated input
 * (defineTool narrows the type). `run` is org-scoped for every tool but
 * run_sql (which ignores orgId — the readonly role + guard are the boundary).
 */
export interface AskTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType;
  readonly run: (orgId: string, input: unknown) => Promise<ToolResult>;
}

/**
 * Build a tool with a typed `run` while erasing the input type at the registry
 * boundary. The `as z.infer<S>` cast is sound because runTool always parses
 * with the same `inputSchema` before dispatching (never call `run` directly
 * with unvalidated input).
 */
export function defineTool<S extends z.ZodType>(t: {
  name: string;
  description: string;
  inputSchema: S;
  run: (orgId: string, input: z.infer<S>) => Promise<ToolResult>;
}): AskTool {
  return {
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    run: (orgId, input) => t.run(orgId, input as z.infer<S>),
  };
}
