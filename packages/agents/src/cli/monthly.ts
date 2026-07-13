/**
 * Monthly Strategist CLI (docs/phase5/CONTRACTS.md §P5-MONTHLY):
 *   pnpm --filter @azen/agents monthly:run [--month=YYYY-MM] [--deliver] [--dry]
 *
 * Runs runMonthlyStrategist against the DEMO org for the given (default: last
 * complete) London month and prints the owner headline, the WhatsApp text, how
 * many per-client value reports + upsell dossiers were written, and the owner-
 * report delivery result. Delivery defaults to DRY-RUN (prints the would-send
 * payloads, no network) unless --deliver is passed; --dry forces dry-run even
 * with --deliver. Local-first: this is how the monthly report is exercised until
 * Trigger.dev is wired (see jobs/monthly.ts).
 */

import { DEMO_ORG_ID, closeDb, db } from "@azen/db";
import { runMonthlyStrategist } from "../agents/monthly";

interface CliArgs {
  month?: string;
  deliver: boolean;
  dryRun: boolean;
}

function parseArgs(argv: readonly string[]): CliArgs {
  let month: string | undefined;
  let deliver = false;
  let dry = false;
  for (const arg of argv) {
    if (arg.startsWith("--month=")) month = arg.slice("--month=".length).trim();
    else if (arg === "--deliver") deliver = true;
    else if (arg === "--dry") dry = true;
  }
  // Safe default: exercise delivery in dry-run so the payloads are visible;
  // --deliver opts into a real send unless --dry overrides.
  return { month, deliver: true, dryRun: dry || !deliver };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const res = await runMonthlyStrategist(db, {
    orgId: DEMO_ORG_ID,
    monthStart: args.month,
    deliver: args.deliver,
    dryRun: args.dryRun,
  });

  if (!res.ok) {
    console.error(`\n✗ Monthly strategist failed: ${res.error}`);
    process.exitCode = 1;
    return;
  }

  const owner = await loadBrief(res.ownerBriefId);
  console.log("\n=== Monthly Strategist ===");
  console.log(`month           : ${res.forMonth}`);
  console.log(`owner brief id  : ${res.ownerBriefId}`);
  console.log(`client reports  : ${res.clientReports.length}`);
  console.log(`upsell dossiers : ${res.upsellDossiers.length}`);
  console.log(`tokens          : in ${res.tokensIn} / out ${res.tokensOut}`);
  console.log(`\nHEADLINE : ${owner?.headline ?? "(unavailable)"}`);
  console.log(`\nWHATSAPP (${(owner?.body_whatsapp ?? "").length} chars):`);
  console.log(owner?.body_whatsapp ?? "(none)");

  for (const cr of res.clientReports) {
    console.log(`  · value report  → ${cr.clientName} (${cr.briefId})`);
  }
  for (const d of res.upsellDossiers) {
    console.log(`  · upsell dossier → ${d.clientName} (${d.briefId})`);
  }

  if (res.delivered) {
    console.log(`\nOWNER DELIVERY (${res.delivered.dryRun ? "dry-run" : "live"}):`);
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
    console.error("[monthly:run] fatal:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    void closeDb();
  });
