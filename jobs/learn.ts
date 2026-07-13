/**
 * Industry Learning schedule — weekly, per active industry, Europe/London (spec
 * §9.6; docs/phase6/CONTRACTS.md §P6-LEARN).
 *
 * Trigger.dev v3 is an OWNER to-do: this package intentionally declares no
 * dependencies yet. Activating the hosted schedule is:
 *   1. `pnpm --filter @azen/jobs add @trigger.dev/sdk @azen/agents @azen/db`
 *   2. deploy with the Trigger.dev CLI.
 * Until then we load the SDK defensively — if it isn't installed this module
 * still imports cleanly and exports a plain stub, so nothing in the repo depends
 * on an uninstalled package. Local-first scheduling meanwhile is the CLI:
 *
 *   pnpm --filter @azen/agents learn:run
 *
 * driven by launchd/cron. Weekly is enough — industry knowledge is durable and
 * the aggregate window is 90 days. Example (Mondays 07:00 London):
 *
 *   0 7 * * 1  cd /path/to/azen && pnpm --filter @azen/agents learn:run
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
 * Learn the demo org's active industries (one runIndustryLearning per industry
 * with an active project). @azen/agents + @azen/db are imported lazily so this
 * file is inert (and importable) until those deps are declared here. Returns a
 * compact per-industry tally.
 */
async function runLearn(): Promise<{
  ok: boolean;
  industries: {
    industry: string;
    articles: number;
    embedded: number;
    error?: string;
  }[];
}> {
  const [{ runIndustryLearningForOrgDefault }, { DEMO_ORG_ID }] = await Promise.all([
    import("@azen/agents"),
    import("@azen/db"),
  ]);
  const out = await runIndustryLearningForOrgDefault(DEMO_ORG_ID);
  const industries = out.industries.map((ind) =>
    ind.result.ok
      ? {
          industry: ind.industryName,
          articles: ind.result.articlesWritten,
          embedded: ind.result.articlesEmbedded,
        }
      : {
          industry: ind.industryName,
          articles: 0,
          embedded: 0,
          error: ind.result.error,
        },
  );
  return { ok: industries.every((i) => i.error === undefined), industries };
}

// Real task when the SDK is present; otherwise a documented stub the lead can
// inspect. Either way `learnTask` is a stable export.
export const learnTask = schedules
  ? schedules.task({
      id: "industry-learning",
      cron: { pattern: "0 7 * * 1", timezone: "Europe/London" },
      run: async () => runLearn(),
    })
  : {
      id: "industry-learning",
      stub: true as const,
      note: "install @trigger.dev/sdk in jobs/ to activate the weekly Europe/London schedule",
      run: runLearn,
    };

export default learnTask;
