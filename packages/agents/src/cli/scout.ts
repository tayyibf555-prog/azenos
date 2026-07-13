/**
 * Opportunity Scout CLI (docs/phase6/CONTRACTS.md §P6-SCOUT):
 *   pnpm --filter @azen/agents scout:run [--day=YYYY-MM-DD]
 *
 * Runs runOpportunityScoutForOrg against the DEMO org (every non-terminal
 * project) and prints, per project, how many automation_opportunity insights
 * were written and how many were flagged for a same-day ping (high confidence).
 * Local-first: this is how the Scout is exercised until Trigger.dev is wired
 * (see jobs/scout.ts). Idempotent — re-running the same day updates the same
 * fingerprinted insights rather than duplicating them.
 */

import { DEMO_ORG_ID, closeDb, db } from "@azen/db";
import { runOpportunityScoutForOrg } from "../agents/scout";

function parseDay(argv: readonly string[]): string | undefined {
  for (const arg of argv) {
    if (arg.startsWith("--day=")) return arg.slice("--day=".length).trim() || undefined;
  }
  return undefined;
}

async function main(): Promise<void> {
  const day = parseDay(process.argv.slice(2));
  const out = await runOpportunityScoutForOrg(db, DEMO_ORG_ID, day);

  console.log("\n=== Opportunity Scout ===");
  if (out.projects.length === 0) {
    console.log("(no projects in the demo org)");
    return;
  }
  for (const p of out.projects) {
    const r = p.result;
    if (!r.ok) {
      console.log(`✗ ${p.projectName}: failed (${r.error})`);
      continue;
    }
    const window = `${r.window.fromDay}→${r.window.toDay}`;
    if (r.runId === null && r.opportunitiesWritten === 0) {
      console.log(`· ${p.projectName}: no signals in ${window} — skipped`);
      continue;
    }
    console.log(
      `✓ ${p.projectName}: ${r.opportunitiesWritten} opportunities (${r.sameDayPings} same-day pings) · ${window} · tokens in ${r.tokensIn}/out ${r.tokensOut}`,
    );
  }
}

main()
  .catch((err) => {
    console.error("[scout:run] fatal:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    void closeDb();
  });
