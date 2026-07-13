/**
 * Upsell Engine CLI (docs/phase6/CONTRACTS.md §P6-GROWTH):
 *   pnpm --filter @azen/agents upsell:run [--insight=UUID] [--client=UUID]
 *
 * With --insight, drafts a proposal from that single opportunity insight. With
 * --client, folds every eligible (reviewed / high-confidence) opportunity across
 * that client into one proposal. With neither, runs the client-wide path for
 * every active client in the DEMO org (the on-demand button hits the API route;
 * this mirrors the Monthly Strategist's fan-out for local exercise).
 *
 * Local-first: this is how the Upsell Engine is exercised until Trigger.dev is
 * wired. Requires ANTHROPIC_API_KEY for a live narrative; without it each run
 * returns a typed error (anthropic_auth) and nothing is written.
 */

import { DEMO_ORG_ID, closeDb, db } from "@azen/db";
import { runUpsellEngine } from "../agents/upsell";

function parseArg(argv: readonly string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  for (const arg of argv) {
    if (arg.startsWith(prefix)) return arg.slice(prefix.length).trim() || undefined;
  }
  return undefined;
}

async function activeClientIds(orgId: string): Promise<{ id: string; name: string }[]> {
  return (await db.$client`
    select id::text as id, name
    from clients
    where org_id = ${orgId}::uuid and status = 'active'
    order by name
  `) as unknown as { id: string; name: string }[];
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const insightId = parseArg(argv, "insight");
  const clientId = parseArg(argv, "client");

  console.log("\n=== Upsell Engine ===");

  if (insightId) {
    const res = await runUpsellEngine(db, { orgId: DEMO_ORG_ID, insightId });
    logResult(`insight ${insightId}`, res);
    return;
  }

  const targets = clientId
    ? [{ id: clientId, name: clientId }]
    : await activeClientIds(DEMO_ORG_ID);

  if (targets.length === 0) {
    console.log("(no active clients in the demo org)");
    return;
  }

  for (const c of targets) {
    const res = await runUpsellEngine(db, { orgId: DEMO_ORG_ID, clientId: c.id });
    logResult(c.name, res);
  }
}

function logResult(
  label: string,
  res: Awaited<ReturnType<typeof runUpsellEngine>>,
): void {
  if (!res.ok) {
    console.log(`✗ ${label}: failed (${res.error})`);
    return;
  }
  if (res.proposalId === null) {
    console.log(`· ${label}: no eligible opportunities — skipped`);
    return;
  }
  console.log(
    `✓ ${label}: proposal ${res.proposalId} from ${res.insightIds.length} insight(s) · tokens in ${res.tokensIn}/out ${res.tokensOut}`,
  );
}

main()
  .catch((err) => {
    console.error("[upsell:run] fatal:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    void closeDb();
  });
