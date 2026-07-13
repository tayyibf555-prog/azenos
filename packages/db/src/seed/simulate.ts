import { parseEvent } from "@azen/events";
import { signBody } from "@azen/events/signing";
import { PROJECTS } from "./demo-data";
import { generateProjectDay } from "./generators";
import { londonTodayUTC } from "./time";

/**
 * pnpm simulate --project=<slug> [--date=YYYY-MM-DD] [--endpoint=<url>] [--dry]
 *
 * Replays a realistic day of events against a local/preview ingest endpoint
 * (spec §13). Requests are signed exactly like the SDK (§6.2):
 *   X-Azen-Signature: t=<unix>,v1=HMAC-SHA256(secret, `${t}.${body}`)
 *
 * The ingest endpoint ships in Phase 1 — until then use --dry to inspect the
 * generated payloads.
 */

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split("=").slice(1).join("=");
  const idx = process.argv.indexOf(`--${name}`);
  if (idx !== -1 && process.argv[idx + 1] && !process.argv[idx + 1]!.startsWith("--")) {
    return process.argv[idx + 1];
  }
  return undefined;
}

const flag = (name: string) => process.argv.includes(`--${name}`);

async function main() {
  const slug = arg("project");
  const project = PROJECTS.find((p) => p.slug === slug);
  if (!project) {
    console.error(
      `Usage: pnpm simulate --project=<slug> [--date=YYYY-MM-DD] [--endpoint=url] [--dry]\n\nProjects:\n${PROJECTS.map((p) => `  ${p.slug}`).join("\n")}`,
    );
    process.exit(1);
  }

  const dateStr = arg("date");
  const date = dateStr ? new Date(`${dateStr}T00:00:00Z`) : londonTodayUTC();
  if (Number.isNaN(date.getTime())) {
    console.error(`Invalid --date "${dateStr}" — use YYYY-MM-DD`);
    process.exit(1);
  }

  const appUrl = process.env.APP_URL || "http://localhost:3000";
  const endpoint =
    arg("endpoint") || `${appUrl}/api/ingest/${project.publicKey}`;
  const dry = flag("dry");

  // dayIndex/totalDays at the top of the growth curve = "today's" volume
  const events = generateProjectDay(project, date, {
    dayIndex: 89,
    totalDays: 90,
  });

  // simulate keys must not collide with seeded history
  const stamped = events.map((e) => ({
    ...e,
    idempotency_key: e.idempotency_key.replace(/^seed:/, "sim:"),
  }));

  for (const e of stamped) {
    const check = parseEvent(e);
    if (!check.ok) throw new Error(`generated invalid event: ${check.error}`);
  }

  console.log(
    `Simulating ${stamped.length} events for ${project.slug} on ${date.toISOString().slice(0, 10)}`,
  );

  if (dry) {
    for (const e of stamped) console.log(JSON.stringify(e));
    console.log(`\n--dry run: nothing sent. Endpoint would be ${endpoint}`);
    return;
  }

  let sent = 0;
  let failed = 0;
  for (const e of stamped) {
    const body = JSON.stringify(e);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-azen-signature": signBody(project.demoSecret, body),
        },
        body,
      });
      if (res.ok) {
        sent++;
      } else {
        failed++;
        if (failed <= 3) {
          console.error(`  ${res.status} ${await res.text().catch(() => "")}`);
        }
      }
    } catch (err) {
      console.error(
        `\nCould not reach ${endpoint} — the ingest endpoint ships in Phase 1.`,
        `\nRun with --dry to inspect payloads instead.\n`,
      );
      throw err;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  console.log(`Done: ${sent} accepted, ${failed} failed.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
