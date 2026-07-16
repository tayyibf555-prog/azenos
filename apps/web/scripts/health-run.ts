/**
 * Health cron entrypoint (docs/phase8/CONTRACTS.md — P8-HEALTH). Runs one
 * evaluation pass per org, ~15-min cadence in production. Defensively
 * importable: no DB connection opens until it actually runs. Ownership note:
 * the evaluator lives web-side (lib/server/health), so the "job" is this tsx
 * script hitting evaluateHealth directly rather than a packages/agents job —
 * the simplest wiring that keeps all Health code in this workstream.
 *
 *   pnpm --filter @azen/web exec tsx scripts/health-run.ts [orgId]
 */
import { closeDb, db, organizations } from "@azen/db";
import { evaluateHealth } from "../lib/server/health/evaluate";

async function main(): Promise<void> {
  const only = process.argv[2];
  const orgs = only
    ? [{ id: only }]
    : await db.select({ id: organizations.id }).from(organizations);

  let opened = 0;
  let resolved = 0;
  for (const org of orgs) {
    const res = await evaluateHealth(org.id);
    opened += res.opened;
    resolved += res.resolved;
    console.log(
      `[health] org=${org.id} projects=${res.evaluatedProjects} opened=${res.opened} resolved=${res.resolved} open=${res.stillOpen} escalations=${res.escalations.sent}/${res.escalations.attempted}`,
    );
    if (res.escalations.attempted > 0 && !res.escalations.twilioConfigured) {
      console.warn("[health] escalation needs TWILIO_* — none sent");
    } else if (res.escalations.attempted > 0 && !res.escalations.recipientConfigured) {
      console.warn(
        `[health] org=${org.id} escalation had no recipient — set the owner's phone_whatsapp or OWNER_WHATSAPP_TO`,
      );
    }
  }
  console.log(`[health] done — ${orgs.length} org(s), +${opened} opened, ${resolved} resolved`);
}

main()
  .then(() => closeDb())
  .catch(async (err) => {
    console.error("[health] run failed:", err);
    await closeDb();
    process.exit(1);
  });
