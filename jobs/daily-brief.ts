/**
 * Daily Brief schedule — 07:00 Europe/London (spec §9, §13; docs/phase3
 * CONTRACTS.md §P3-BRIEF).
 *
 * Trigger.dev v3 is an OWNER to-do: this package intentionally declares no
 * dependencies yet. Activating the hosted schedule is:
 *   1. `pnpm --filter @azen/jobs add @trigger.dev/sdk @azen/agents @azen/db`
 *   2. deploy with the Trigger.dev CLI.
 * Until then we load the SDK defensively — if it isn't installed this module
 * still imports cleanly and exports a plain stub, so nothing in the repo depends
 * on an uninstalled package. Local-first scheduling meanwhile is the CLI:
 *
 *   pnpm --filter @azen/agents brief:run --deliver
 *
 * driven by launchd/cron. Example crontab (07:00 London ≈ server-tz dependent —
 * prefer a launchd StartCalendarInterval on macOS which honours the local zone):
 *
 *   0 7 * * *  cd /path/to/azen && pnpm --filter @azen/agents brief:run --deliver
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
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const req = (0, eval)("require") as (id: string) => { schedules?: SchedulesApi };
    return req(moduleName).schedules ?? null;
  } catch {
    return null;
  }
}

const schedules = loadSchedules();

/**
 * Run the brief for the demo org. @azen/agents + @azen/db are imported lazily
 * so this file is inert (and importable) until those deps are declared here.
 */
async function runBrief(): Promise<{ ok: boolean }> {
  const [{ runDailyBriefDefault }, { DEMO_ORG_ID }] = await Promise.all([
    import("@azen/agents"),
    import("@azen/db"),
  ]);
  const res = await runDailyBriefDefault({ orgId: DEMO_ORG_ID, deliver: true });
  return { ok: res.ok };
}

// Real task when the SDK is present; otherwise a documented stub the lead can
// inspect. Either way `dailyBriefTask` is a stable export.
export const dailyBriefTask = schedules
  ? schedules.task({
      id: "daily-brief",
      cron: { pattern: "0 7 * * *", timezone: "Europe/London" },
      run: async () => runBrief(),
    })
  : {
      id: "daily-brief",
      stub: true as const,
      note: "install @trigger.dev/sdk in jobs/ to activate the 07:00 London schedule",
      run: runBrief,
    };

export default dailyBriefTask;
