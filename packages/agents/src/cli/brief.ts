/**
 * Daily Brief CLI (docs/phase3/CONTRACTS.md §P3-BRIEF):
 *   pnpm --filter @azen/agents brief:run [--day=YYYY-MM-DD] [--deliver] [--dry]
 *
 * Runs runDailyBrief against the DEMO org and prints the headline, the WhatsApp
 * text, and the delivery result. Delivery defaults to DRY-RUN (prints the
 * would-send payloads, no network) unless --deliver is passed; --dry forces
 * dry-run even with --deliver. Local-first: this is how the brief is exercised
 * every morning until Trigger.dev is wired (see jobs/daily-brief.ts).
 */

import { DEMO_ORG_ID, closeDb, db } from "@azen/db";
import { runDailyBrief } from "../agents/daily-brief";

interface CliArgs {
  day?: string;
  deliver: boolean;
  dryRun: boolean;
}

function parseArgs(argv: readonly string[]): CliArgs {
  let day: string | undefined;
  let deliver = false;
  let dry = false;
  for (const arg of argv) {
    if (arg.startsWith("--day=")) day = arg.slice("--day=".length).trim();
    else if (arg === "--deliver") deliver = true;
    else if (arg === "--dry") dry = true;
  }
  // Default posture is a safe dry-run; --deliver opts into a real send unless
  // --dry overrides. If neither flag is given we still exercise delivery in
  // dry-run so the payloads are visible.
  return { day, deliver: true, dryRun: dry || !deliver };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const res = await runDailyBrief(db, {
    orgId: DEMO_ORG_ID,
    forDay: args.day,
    deliver: args.deliver,
    dryRun: args.dryRun,
  });

  if (!res.ok) {
    console.error(`\n✗ Daily brief failed: ${res.error}`);
    process.exitCode = 1;
    return;
  }

  const brief = await loadBrief(res.briefId);
  console.log("\n=== Daily Brief ===");
  console.log(`brief id : ${res.briefId}`);
  console.log(`tokens   : in ${res.tokensIn} / out ${res.tokensOut}`);
  console.log(`\nHEADLINE : ${brief?.headline ?? "(unavailable)"}`);
  console.log(`\nWHATSAPP (${(brief?.body_whatsapp ?? "").length} chars):`);
  console.log(brief?.body_whatsapp ?? "(none)");

  if (res.delivered) {
    console.log(`\nDELIVERY (${res.delivered.dryRun ? "dry-run" : "live"}):`);
    console.log(`  email    : ${describe(res.delivered.email)}`);
    console.log(`  whatsapp : ${describe(res.delivered.whatsapp)}`);
    if (res.delivered.sms) console.log(`  sms      : ${describe(res.delivered.sms)}`);
    if (res.delivered.dryRun) {
      console.log("\nWould-send payloads:");
      console.log(JSON.stringify(res.delivered.payloads, null, 2));
    }
  }
}

function describe(r: { ok: boolean; reason?: string; id?: string }): string {
  return r.ok ? `ok${r.id ? ` (${r.id})` : ""}` : `skipped/failed (${r.reason})`;
}

interface CliBriefRow {
  headline: string;
  body_whatsapp: string | null;
}

async function loadBrief(briefId: string): Promise<CliBriefRow | undefined> {
  const rows = (await db.$client`
    select headline, body_whatsapp from briefs where id = ${briefId}::uuid limit 1
  `) as unknown as CliBriefRow[];
  return rows[0];
}

main()
  .catch((err) => {
    console.error("[brief:run] fatal:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    void closeDb();
  });
