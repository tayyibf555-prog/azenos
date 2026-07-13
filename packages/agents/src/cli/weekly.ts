/**
 * Weekly Synthesizer CLI (docs/phase5/CONTRACTS.md §P5-WEEKLY):
 *   pnpm --filter @azen/agents weekly:run [--week=YYYY-MM-DD] [--deliver] [--dry]
 *
 * Runs runWeeklySynth against the DEMO org and prints the headline, the WhatsApp
 * text, and the delivery result. --week snaps to that week's Monday; omit it to
 * summarise the most recent complete week. Delivery defaults to DRY-RUN (prints
 * the would-send payloads, no network) unless --deliver is passed; --dry forces
 * dry-run even with --deliver. Local-first: this is how the weekly synth is
 * exercised until Trigger.dev is wired (see jobs/weekly.ts).
 */

import { DEMO_ORG_ID, closeDb, db } from "@azen/db";
import { runWeeklySynth } from "../agents/weekly";

interface CliArgs {
  week?: string;
  deliver: boolean;
  dryRun: boolean;
}

function parseArgs(argv: readonly string[]): CliArgs {
  let week: string | undefined;
  let deliver = false;
  let dry = false;
  for (const arg of argv) {
    if (arg.startsWith("--week=")) week = arg.slice("--week=".length).trim() || undefined;
    else if (arg === "--deliver") deliver = true;
    else if (arg === "--dry") dry = true;
  }
  return { week, deliver: true, dryRun: dry || !deliver };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const res = await runWeeklySynth(db, {
    orgId: DEMO_ORG_ID,
    weekStart: args.week,
    deliver: args.deliver,
    dryRun: args.dryRun,
  });

  if (!res.ok) {
    console.error(`\n✗ Weekly synth failed: ${res.error}`);
    process.exitCode = 1;
    return;
  }

  const brief = await loadBrief(res.briefId);
  console.log("\n=== Weekly Synthesizer ===");
  console.log(`brief id : ${res.briefId}`);
  console.log(`week     : ${res.weekStart} → ${res.weekEnd}`);
  console.log(`prior ed : ${res.referencedPriorEdition ? "referenced" : "none"}`);
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
    console.error("[weekly:run] fatal:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    void closeDb();
  });
