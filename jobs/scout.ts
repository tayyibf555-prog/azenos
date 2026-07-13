/**
 * Opportunity Scout schedule — daily, per project, Europe/London (spec §9.4;
 * docs/phase6/CONTRACTS.md §P6-SCOUT).
 *
 * Trigger.dev v3 is an OWNER to-do: this package intentionally declares no
 * dependencies yet. Activating the hosted schedule is:
 *   1. `pnpm --filter @azen/jobs add @trigger.dev/sdk @azen/agents @azen/db`
 *   2. deploy with the Trigger.dev CLI.
 * Until then we load the SDK defensively — if it isn't installed this module
 * still imports cleanly and exports a plain stub, so nothing in the repo depends
 * on an uninstalled package. Local-first scheduling meanwhile is the CLI:
 *
 *   pnpm --filter @azen/agents scout:run
 *
 * driven by launchd/cron (a little after the conversation clustering so the
 * day's scout_candidate FAQ clusters are in). Example (08:30 London on macOS
 * launchd honours the local zone):
 *
 *   30 8 * * *  cd /path/to/azen && pnpm --filter @azen/agents scout:run
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
 * Scout the demo org's projects (one runOpportunityScout per non-terminal
 * project). @azen/agents + @azen/db are imported lazily so this file is inert
 * (and importable) until those deps are declared here. Returns a compact
 * per-project tally.
 */
async function runScout(): Promise<{
  ok: boolean;
  projects: { project: string; opportunities: number; sameDayPings: number; error?: string }[];
}> {
  const [{ runOpportunityScoutForOrgDefault }, { DEMO_ORG_ID }] = await Promise.all([
    import("@azen/agents"),
    import("@azen/db"),
  ]);
  const out = await runOpportunityScoutForOrgDefault(DEMO_ORG_ID);
  const projects = out.projects.map((p) =>
    p.result.ok
      ? {
          project: p.projectName,
          opportunities: p.result.opportunitiesWritten,
          sameDayPings: p.result.sameDayPings,
        }
      : {
          project: p.projectName,
          opportunities: 0,
          sameDayPings: 0,
          error: p.result.error,
        },
  );
  return { ok: projects.every((p) => p.error === undefined), projects };
}

// Real task when the SDK is present; otherwise a documented stub the lead can
// inspect. Either way `scoutTask` is a stable export.
export const scoutTask = schedules
  ? schedules.task({
      id: "opportunity-scout",
      cron: { pattern: "30 8 * * *", timezone: "Europe/London" },
      run: async () => runScout(),
    })
  : {
      id: "opportunity-scout",
      stub: true as const,
      note: "install @trigger.dev/sdk in jobs/ to activate the daily Europe/London schedule",
      run: runScout,
    };

export default scoutTask;
