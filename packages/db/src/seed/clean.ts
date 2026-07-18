import { and, eq, isNull, sql } from "drizzle-orm";
import { closeDb, db } from "../client";
import * as s from "../schema/index";
import {
  DEFAULT_ALERT_RULES,
  DEFAULT_METRIC_DEFINITIONS,
  ORG_ID,
  OWNER,
} from "./demo-data";

/**
 * pnpm seed:clean — the GO-LIVE bootstrap with ZERO sample data (owner
 * directive: "no sample data, I'm going to start using it live").
 *
 * Why the IDs matter: without hosted Supabase configured, requireOrgId()
 * (apps/web/lib/server/org.ts) returns DEMO_ORG_ID — which is exactly ORG_ID
 * here (re-exported from @azen/db). So a live-in-demo-mode app NEEDS an
 * organizations row with id = ORG_ID and an owner users row to exist, or every
 * org-scoped insert breaks. This seed creates ONLY:
 *   1. the org row {id: ORG_ID, name: "Azen AI"}
 *   2. the owner user row ({...OWNER, orgId: ORG_ID})
 *   3. org-default metric definitions + alert rules (projectId null)
 * and NOTHING else — no industries, clients, contacts, projects, keys, events,
 * bookings, money rows, feedback.
 *
 * Idempotent: running it twice is a no-op; running it against a DB that already
 * holds the demo seed changes NOTHING and says so.
 *   - org / owner  → insert … onConflictDoNothing() on the primary key.
 *   - metric defs  → no unique constraint covering (org, key, null project), so
 *                    guarded by a select-first existence check per key.
 *   - alert rules  → no unique constraint either, so guarded by a select-first
 *                    existence check per kind (the natural default-set key).
 *
 * --wipe: FIRST truncates the same table list seed/index.ts truncates, THEN
 * bootstraps. Destroys ALL data. Never wipes without the flag.
 *
 * Env: db client (../client) loads the repo-root .env, so
 * `DATABASE_URL=<override> pnpm --filter @azen/db seed:clean` works inline
 * (dotenv does not override an already-set process env var).
 */

const WIPE = process.argv.includes("--wipe");

async function main() {
  if (WIPE) {
    console.log(
      "!! --wipe: TRUNCATING EVERY TABLE — this destroys ALL data (org, clients, projects, events, money) before bootstrapping. !!",
    );
    // Verbatim truncate list from seed/index.ts.
    await db.execute(sql`
      truncate table
        webhook_deliveries, alert_rules,
        chat_messages, chat_sessions, agent_runs, knowledge_articles,
        upsell_proposals, insights, briefs,
        feedback_items,
        bookings, expenses, subscriptions, payments,
        metric_rollups, metric_definitions, events,
        project_integrations, project_keys, projects,
        contacts, clients, industries, users, organizations
      cascade
    `);
  }

  console.log("Bootstrapping Azen OS for GO-LIVE (zero sample data)…\n");

  // ── org (pk id) ───────────────────────────────────────────────────────────
  const orgInserted = await db
    .insert(s.organizations)
    .values({ id: ORG_ID, name: "Azen AI" })
    .onConflictDoNothing()
    .returning({ id: s.organizations.id });
  const orgCreated = orgInserted.length > 0;

  // ── owner user (pk id) ────────────────────────────────────────────────────
  const ownerInserted = await db
    .insert(s.users)
    .values({ ...OWNER, orgId: ORG_ID })
    .onConflictDoNothing()
    .returning({ id: s.users.id });
  const ownerCreated = ownerInserted.length > 0;

  // ── org-default metric definitions (projectId null) ───────────────────────
  // No unique constraint on (org_id, key, project_id) → select-first guard.
  const existingMetricKeys = new Set(
    (
      await db
        .select({ key: s.metricDefinitions.key })
        .from(s.metricDefinitions)
        .where(
          and(
            eq(s.metricDefinitions.orgId, ORG_ID),
            isNull(s.metricDefinitions.projectId),
          ),
        )
    ).map((r) => r.key),
  );
  const metricRowsToInsert = DEFAULT_METRIC_DEFINITIONS.filter(
    (m) => !existingMetricKeys.has(m.key),
  ).map((m) => ({
    orgId: ORG_ID,
    projectId: null,
    key: m.key,
    name: m.name,
    eventType: m.eventType,
    aggregation: m.aggregation,
    unit: m.unit,
    valuePath: "valuePath" in m ? m.valuePath : null,
    whereEquals: "whereEquals" in m ? m.whereEquals : null,
    goodDirection: m.goodDirection,
    isKpi: m.isKpi,
    sort: m.sort,
  }));
  if (metricRowsToInsert.length > 0) {
    await db.insert(s.metricDefinitions).values(metricRowsToInsert);
  }

  // ── org-default alert rules (projectId null) ──────────────────────────────
  // No unique constraint → select-first guard on `kind` (the default-set key).
  const existingAlertKinds = new Set(
    (
      await db
        .select({ kind: s.alertRules.kind })
        .from(s.alertRules)
        .where(
          and(eq(s.alertRules.orgId, ORG_ID), isNull(s.alertRules.projectId)),
        )
    ).map((r) => r.kind),
  );
  const alertRowsToInsert = DEFAULT_ALERT_RULES.filter(
    (a) => !existingAlertKinds.has(a.kind),
  ).map((a) => ({ ...a, orgId: ORG_ID, projectId: null }));
  if (alertRowsToInsert.length > 0) {
    await db.insert(s.alertRules).values(alertRowsToInsert);
  }

  // ── summary ───────────────────────────────────────────────────────────────
  const metricTotal = existingMetricKeys.size + metricRowsToInsert.length;
  const alertTotal = existingAlertKinds.size + alertRowsToInsert.length;
  const noop =
    !orgCreated &&
    !ownerCreated &&
    metricRowsToInsert.length === 0 &&
    alertRowsToInsert.length === 0;

  console.log(`Org:          ${orgCreated ? "created" : "already exists"} — Azen AI (${ORG_ID})`);
  console.log(`Owner:        ${ownerCreated ? "created" : "already exists"} — ${OWNER.email} (${OWNER.role})`);
  console.log(
    `Metric defs:  ${metricRowsToInsert.length} inserted, ${existingMetricKeys.size} already present (${metricTotal} org defaults total)`,
  );
  console.log(
    `Alert rules:  ${alertRowsToInsert.length} inserted, ${existingAlertKinds.size} already present (${alertTotal} org defaults total)`,
  );
  if (noop) {
    console.log("\nNo changes — everything already exists. This run was a no-op.");
  }
  console.log(
    "\nApp is ready with zero sample data — onboard your first client at /projects/new",
  );
}

main()
  .catch((err) => {
    console.error("Clean seed failed:", err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
