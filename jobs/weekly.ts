/**
 * Weekly Synthesizer schedule — Mon 07:30 Europe/London (spec §9.2;
 * docs/phase5/CONTRACTS.md §P5-WEEKLY).
 *
 * Trigger.dev v3 is an OWNER to-do: this package intentionally declares no
 * dependencies yet. Activating the hosted schedule is:
 *   1. `pnpm --filter @azen/jobs add @trigger.dev/sdk @azen/agents @azen/db`
 *   2. deploy with the Trigger.dev CLI.
 * Until then we load the SDK defensively — if it isn't installed this module
 * still imports cleanly and exports a plain stub. Local-first scheduling
 * meanwhile is the CLI, driven by launchd/cron:
 *
 *   pnpm --filter @azen/agents weekly:run --deliver
 *
 * (Mon 07:30 London — prefer a launchd StartCalendarInterval on macOS which
 * honours the local zone.) Run AFTER the week's daily briefs exist so the
 * weekly pack can fold in the seven headlines.
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
 * Run the weekly synth for the demo org (most recent complete week). @azen/agents
 * + @azen/db are imported lazily so this file is inert (and importable) until
 * those deps are declared here.
 */
async function runWeekly(): Promise<{ ok: boolean }> {
  const [{ runWeeklySynthDefault }, { DEMO_ORG_ID }] = await Promise.all([
    import("@azen/agents"),
    import("@azen/db"),
  ]);
  const res = await runWeeklySynthDefault({ orgId: DEMO_ORG_ID, deliver: true });
  return { ok: res.ok };
}

// Real task when the SDK is present; otherwise a documented stub the lead can
// inspect. Either way `weeklySynthTask` is a stable export.
export const weeklySynthTask = schedules
  ? schedules.task({
      id: "weekly-synth",
      cron: { pattern: "30 7 * * 1", timezone: "Europe/London" },
      run: async () => runWeekly(),
    })
  : {
      id: "weekly-synth",
      stub: true as const,
      note: "install @trigger.dev/sdk in jobs/ to activate the Mon 07:30 London schedule",
      run: runWeekly,
    };

export default weeklySynthTask;
