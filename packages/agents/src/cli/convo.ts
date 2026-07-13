/**
 * Conversation clustering CLI (docs/phase5/CONTRACTS.md §P5-CONVO):
 *   pnpm --filter @azen/agents convo:run [--day=YYYY-MM-DD]
 *
 * Runs runConvoClusteringForOrg against the DEMO org (every non-terminal project)
 * and prints, per project, how many faq_cluster insights were written and how
 * many were flagged as unautomated-repetition (Scout candidates). Local-first:
 * this is how clustering is exercised until Trigger.dev is wired (see
 * jobs/convo-cluster.ts). Idempotent — re-running the same day updates the same
 * fingerprinted insights rather than duplicating them.
 */

import { DEMO_ORG_ID, closeDb, db } from "@azen/db";
import { runConvoClusteringForOrg } from "../agents/convo-cluster";

function parseDay(argv: readonly string[]): string | undefined {
  for (const arg of argv) {
    if (arg.startsWith("--day=")) return arg.slice("--day=".length).trim() || undefined;
  }
  return undefined;
}

async function main(): Promise<void> {
  const day = parseDay(process.argv.slice(2));
  const out = await runConvoClusteringForOrg(db, DEMO_ORG_ID, day);

  console.log("\n=== Conversation clustering ===");
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
    if (r.runId === null && r.clustersWritten === 0) {
      console.log(`· ${p.projectName}: no conversations in ${window} — skipped`);
      continue;
    }
    console.log(
      `✓ ${p.projectName}: ${r.clustersWritten} clusters (${r.scoutCandidates} scout candidates) · ${window} · tokens in ${r.tokensIn}/out ${r.tokensOut}`,
    );
  }
}

main()
  .catch((err) => {
    console.error("[convo:run] fatal:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    void closeDb();
  });
