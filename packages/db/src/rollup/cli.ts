import { eq, sql } from "drizzle-orm";
import { closeDb, db } from "../client";
import { projects } from "../schema/index";
import { runRollups } from "./engine";

/**
 * pnpm --filter @azen/db rollup:run [--project=<slug>] [--force]
 * Backfills/refreshes metric_rollups. `--force` ignores the watermark and
 * recomputes the trailing 90 days; the default drains the incremental backlog.
 */

interface Args {
  projectSlug?: string;
  force: boolean;
}

function parseArgs(argv: string[]): Args {
  let projectSlug: string | undefined;
  let force = false;
  for (const a of argv) {
    if (a === "--force") force = true;
    else if (a.startsWith("--project=")) projectSlug = a.slice("--project=".length);
  }
  return { projectSlug, force };
}

async function main(): Promise<void> {
  const { projectSlug, force } = parseArgs(process.argv.slice(2));

  let projectId: string | undefined;
  if (projectSlug) {
    const [p] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.slug, projectSlug))
      .limit(1);
    if (!p) throw new Error(`no project with slug "${projectSlug}"`);
    projectId = p.id;
  }

  console.log(
    `Rolling up ${projectSlug ? `project ${projectSlug}` : "all projects"}${force ? " [force]" : ""}…`,
  );
  const summary = await runRollups(db, { projectId, force });
  console.log(
    `\nprojects=${summary.projects} passes=${summary.passes} buckets=${summary.bucketsRecomputed} anomalies=${summary.anomaliesCreated}`,
  );

  const scope = projectId ? sql`project_id = ${projectId}::uuid` : sql`true`;
  const rows = (await db.execute(
    sql`select period, count(*)::int as n from metric_rollups where ${scope} group by period order by period`,
  )) as unknown as { period: string; n: number }[];
  console.log("\nmetric_rollups rows by period:");
  let total = 0;
  for (const r of rows) {
    total += Number(r.n);
    console.log(`  ${r.period.padEnd(6)} ${r.n}`);
  }
  console.log(`  ${"total".padEnd(6)} ${total}`);
}

main()
  .catch((err) => {
    console.error("rollup:run failed:", err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
