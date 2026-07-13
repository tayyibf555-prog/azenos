import { z } from "zod";
import { runReadonlySql } from "@azen/db/readonly";
import { defineTool } from "./types";

/**
 * run_sql — the guarded escape hatch (spec §9.8, §15). Delegates ENTIRELY to
 * runReadonlySql from @azen/db/readonly (SELECT/WITH-only, single-statement,
 * keyword denylist, enforced LIMIT, run as the SELECT-only azen_readonly role
 * with a 5s timeout). We do NOT re-implement any guarding here — we only map its
 * typed {ok:false} into a ToolResult error.
 *
 * §15 CAVEAT: run_sql is NOT org-scoped — it can read across the whole database.
 * That is acceptable ONLY for the current single-owner/single-org v1. Before any
 * multi-tenant or client-facing chat exists, this tool MUST be removed or made
 * org-scoped (row-level). The structured tools above are the org-scoped default;
 * run_sql is for the long tail the structured tools don't cover.
 */

const MAX_ROWS = 200;

export const runSql = defineTool({
  name: "run_sql",
  description:
    "Escape hatch: run one read-only SQL query against the Postgres database when no structured tool fits. SELECT / WITH only, a single statement, no writes or DDL, auto-capped to 200 rows, 5-second timeout. Prefer the structured tools first (they are faster, org-scoped, and safer) and use this only for the long tail they don't cover. Blocked or failing queries come back as an error you can read and correct.",
  inputSchema: z.object({ query: z.string().min(1) }).strict(),
  run: async (_orgId, input) => {
    const result = await runReadonlySql(input.query, { maxRows: MAX_ROWS });
    if (!result.ok) return { ok: false, error: result.reason };
    return {
      ok: true,
      data: {
        rows: result.rows,
        rowCount: result.rowCount,
        truncated: result.truncated,
      },
    };
  },
});
