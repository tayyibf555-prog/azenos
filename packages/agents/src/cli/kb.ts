/**
 * KB-gap miner CLI (docs/phase9/CONTRACTS.md §P9-KB):
 *   pnpm --filter @azen/agents kb:run [--day=YYYY-MM-DD]
 *
 * Runs runKbGapMinerForOrg against the DEMO org (every non-terminal project) and
 * prints, per project, how many content-gap automation_opportunity insights were
 * written (each carrying a drafted KB article + bot-improvement brief that flows
 * into the Growth pipeline). Local-first: this is how the miner is exercised
 * until Trigger.dev is wired. Idempotent — re-running the same day updates the
 * same fingerprinted insights rather than duplicating them.
 */

import { DEMO_ORG_ID, closeDb, db } from "@azen/db";
import { runKbGapMinerForOrg } from "../agents/kb-gaps";

function parseDay(argv: readonly string[]): string | undefined {
  for (const arg of argv) {
    if (arg.startsWith("--day=")) return arg.slice("--day=".length).trim() || undefined;
  }
  return undefined;
}

async function main(): Promise<void> {
  const day = parseDay(process.argv.slice(2));
  const out = await runKbGapMinerForOrg(db, DEMO_ORG_ID, day);

  console.log("\n=== KB-gap miner ===");
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
    if (r.runId === null && r.gapsWritten === 0) {
      console.log(`· ${p.projectName}: no content gaps in ${window} — skipped`);
      continue;
    }
    console.log(
      `✓ ${p.projectName}: ${r.gapsWritten} new · ${r.gapsUpdated} refreshed content-gap briefs · ${window} · tokens in ${r.tokensIn}/out ${r.tokensOut}`,
    );
  }
}

main()
  .catch((err) => {
    console.error("[kb:run] fatal:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    void closeDb();
  });
