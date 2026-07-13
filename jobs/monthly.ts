/**
 * Monthly Strategist schedule — 1st of the month, 08:00 Europe/London (spec
 * §9.3; docs/phase5/CONTRACTS.md §P5-MONTHLY).
 *
 * Trigger.dev v3 is an OWNER to-do: this package intentionally declares no
 * dependencies yet. Activating the hosted schedule is:
 *   1. `pnpm --filter @azen/jobs add @trigger.dev/sdk @azen/agents @azen/db`
 *   2. deploy with the Trigger.dev CLI.
 * Until then we load the SDK defensively — if it isn't installed this module
 * still imports cleanly and exports a plain stub, so nothing in the repo depends
 * on an uninstalled package. Local-first scheduling meanwhile is the CLI:
 *
 *   pnpm --filter @azen/agents monthly:run
 *
 * driven by launchd/cron on the 1st. Example (08:00 London on macOS launchd
 * honours the local zone):
 *
 *   0 8 1 * *  cd /path/to/azen && pnpm --filter @azen/agents monthly:run --deliver
 */

// Minimal shape of the bits of @trigger.dev/sdk/v3 we use — declared locally so
// this file needs no @types when the SDK is absent.
interface ScheduleContext {
  externalId?: string;
}
interface SchedulesApi {
  task(def: {
    id: string;
    cron: { pattern: string; timezone: string } | string;
    run: (payload: unknown, ctx: ScheduleContext) => Promise<unknown>;
  }): unknown;
}

function loadSchedules(): SchedulesApi | null {
  try {
    // Indirected through a variable so bundlers don't hard-resolve the module
    // at build time when it isn't installed.
    const moduleName = "@trigger.dev/sdk/v3";
    const req = (0, eval)("require") as (id: string) => { schedules?: SchedulesApi };
    return req(moduleName).schedules ?? null;
  } catch {
    return null;
  }
}

const schedules = loadSchedules();

/**
 * Generate the demo org's monthly report for the last complete London month.
 * @azen/agents + @azen/db are imported lazily so this file is inert (and
 * importable) until those deps are declared here. Returns a compact tally.
 */
async function runMonthly(): Promise<{
  ok: boolean;
  forMonth?: string;
  ownerBriefId?: string;
  clientReports?: number;
  upsellDossiers?: number;
  error?: string;
}> {
  const [{ runMonthlyStrategistDefault }, { DEMO_ORG_ID }] = await Promise.all([
    import("@azen/agents"),
    import("@azen/db"),
  ]);
  // The scheduled run delivers for real (the owner report is the artefact).
  const res = await runMonthlyStrategistDefault({
    orgId: DEMO_ORG_ID,
    deliver: true,
  });
  if (!res.ok) return { ok: false, error: res.error };
  return {
    ok: true,
    forMonth: res.forMonth,
    ownerBriefId: res.ownerBriefId,
    clientReports: res.clientReports.length,
    upsellDossiers: res.upsellDossiers.length,
  };
}

// Real task when the SDK is present; otherwise a documented stub the lead can
// inspect. Either way `monthlyStrategistTask` is a stable export.
export const monthlyStrategistTask = schedules
  ? schedules.task({
      id: "monthly-strategist",
      cron: { pattern: "0 8 1 * *", timezone: "Europe/London" },
      run: async () => runMonthly(),
    })
  : {
      id: "monthly-strategist",
      stub: true as const,
      note: "install @trigger.dev/sdk in jobs/ to activate the 1st-of-month Europe/London schedule",
      run: runMonthly,
    };

export default monthlyStrategistTask;
