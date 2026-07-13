/**
 * Industry Learning CLI (docs/phase6/CONTRACTS.md §P6-LEARN):
 *   pnpm --filter @azen/agents learn:run [--industry=UUID]
 *
 * With --industry, learns that one industry. With neither, fans out over every
 * industry in the DEMO org that has an active project (mirrors the weekly job).
 * Writes knowledge_articles (industry primer / weekly digest / patterns /
 * playbooks) and embeds each with Voyage when VOYAGE_API_KEY is present.
 *
 * Local-first: this is how Industry Learning is exercised until Trigger.dev is
 * wired. Requires ANTHROPIC_API_KEY for a live narrative; without it each run
 * returns a typed error (anthropic_auth) and nothing is written. Without
 * VOYAGE_API_KEY articles are still written but with null embeddings.
 */

import { DEMO_ORG_ID, closeDb, db } from "@azen/db";
import { runIndustryLearning, runIndustryLearningForOrg } from "../agents/learn";

function parseArg(argv: readonly string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  for (const arg of argv) {
    if (arg.startsWith(prefix)) return arg.slice(prefix.length).trim() || undefined;
  }
  return undefined;
}

async function main(): Promise<void> {
  const industryId = parseArg(process.argv.slice(2), "industry");

  console.log("\n=== Industry Learning ===");

  if (industryId) {
    const res = await runIndustryLearning(db, { orgId: DEMO_ORG_ID, industryId });
    logResult(`industry ${industryId}`, res);
    return;
  }

  const out = await runIndustryLearningForOrg(db, DEMO_ORG_ID);
  if (out.industries.length === 0) {
    console.log("(no industries with an active project in the demo org)");
    return;
  }
  for (const ind of out.industries) {
    logResult(ind.industryName, ind.result);
  }
}

function logResult(
  label: string,
  res: Awaited<ReturnType<typeof runIndustryLearning>>,
): void {
  if (!res.ok) {
    console.log(`✗ ${label}: failed (${res.error})`);
    return;
  }
  if (res.runId === null) {
    console.log(`· ${label}: no signal — skipped`);
    return;
  }
  console.log(
    `✓ ${label}: ${res.articlesWritten} article(s), ${res.articlesEmbedded} embedded · tokens in ${res.tokensIn}/out ${res.tokensOut}`,
  );
}

main()
  .catch((err) => {
    console.error("[learn:run] fatal:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    void closeDb();
  });
