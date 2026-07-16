/**
 * Health evaluator (docs/phase8/CONTRACTS.md — P8-HEALTH). Deterministic in
 * (orgId, now): reads the event spine + money/feedback tables, runs the pure
 * checks (checks.ts), then reconciles alert_instances and writes back the
 * objective projects.health badge.
 *
 * Reconciliation contract:
 *  - dedupe: an open instance of the same (project, check) is left untouched so
 *    a breach fires ONCE, not per run;
 *  - auto-resolve: an open health instance whose check no longer breaches gets
 *    resolved_at = now;
 *  - ownership: only rows this evaluator created (evidence.source = 'health')
 *    are ever mutated — instances from the ingest pipeline are never touched.
 *
 * Escalation: a critical instance still unacked ESCALATION_AFTER_MINUTES after
 * it fired is pushed to WhatsApp via the existing Phase-3 delivery layer. No
 * Twilio key → the sender degrades gracefully (no network) and the evaluator
 * reports it so the Health screen can surface the "escalation needs TWILIO_*"
 * banner. Each instance escalates at most once (evidence.escalated_at guard).
 */
import { sendWhatsApp } from "@azen/agents";
import { alertInstances, db, projects } from "@azen/db";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  ESCALATION_AFTER_MINUTES,
  type HealthBadge,
  type ProjectHealthInput,
  type ProjectSlo,
  evaluateProject,
} from "./checks";
// Phase 9 (P9-COST): additive cost-spike rule. Its signals fold into the same
// per-project (project, check) reconciliation as the Phase-8 checks below.
import { costSpikeSignals } from "./rules/cost-spike";

export interface EvaluateOptions {
  /** Fixed evaluation clock — defaults to new Date(). Pass for deterministic tests. */
  now?: Date;
  /** Set false to skip the WhatsApp escalation pass (default true). */
  escalate?: boolean;
}

export interface EvaluateResult {
  evaluatedProjects: number;
  /** New alert_instances opened this run. */
  opened: number;
  /** Open instances auto-resolved this run (condition cleared). */
  resolved: number;
  /** Open health instances still breaching after reconciliation. */
  stillOpen: number;
  escalations: {
    attempted: number;
    sent: number;
    /** false when TWILIO_* is absent — drives the Health screen banner. */
    twilioConfigured: boolean;
    /** false when Twilio IS configured but no escalation recipient resolves
     *  (owner phone_whatsapp null and OWNER_WHATSAPP_TO unset) — otherwise the
     *  send is silently dropped every run with no owner-visible warning. */
    recipientConfigured: boolean;
  };
  /** Objective badge written per project, keyed by project id. */
  health: Record<string, HealthBadge>;
}

interface BaseRow {
  project_id: string;
  client_id: string;
  slo: ProjectSlo | null;
  last_event_at: Date | string | null;
  total_24h: number | string;
  errors_24h: number | string;
  errors_window: number | string;
  p95_ms: number | string | null;
}

interface HeartbeatRow {
  project_id: string;
  hb_count: number | string;
  max_internal_gap_min: number | string | null;
  last_hb: Date | string | null;
}

interface FeedbackRow {
  project_id: string;
  neg: number | string;
}

interface RetainerRow {
  project_id: string;
  past_due: boolean;
}

interface OpenInstanceRow {
  id: string;
  projectId: string | null;
  severity: "info" | "warn" | "critical";
  message: string;
  ackedAt: Date | null;
  firedAt: Date;
  evidence: Record<string, unknown>;
}

function num(v: number | string | null | undefined): number {
  if (v === null || v === undefined) return 0;
  return typeof v === "number" ? v : Number(v);
}

/** Raw db.execute returns timestamptz as strings — normalise to Date. */
function toDate(v: Date | string | null): Date | null {
  if (v === null) return null;
  return v instanceof Date ? v : new Date(v);
}

function checkOf(evidence: Record<string, unknown>): string | null {
  const c = evidence["check"];
  return typeof c === "string" ? c : null;
}

/** Read the org owner's WhatsApp destination (users.owner → env fallback). */
async function resolveEscalationTo(orgId: string): Promise<string | null> {
  const rows = (await db.execute(sql`
    select phone_whatsapp
    from users
    where org_id = ${orgId}
    order by (role = 'owner') desc, created_at asc
    limit 1
  `)) as unknown as { phone_whatsapp: string | null }[];
  const owner = rows[0]?.phone_whatsapp ?? null;
  return owner ?? process.env.OWNER_WHATSAPP_TO ?? null;
}

/**
 * Read + assemble every live project's ProjectHealthInput. Pure reads (no
 * writes) so the Health screen can render the grid off the same numbers the
 * evaluator judges. Deterministic in (orgId, now).
 */
export async function loadProjectHealthInputs(
  orgId: string,
  now: Date,
): Promise<ProjectHealthInput[]> {
  // postgres.js binds a raw Date awkwardly under an explicit ::timestamptz cast;
  // pass the ISO string and let Postgres parse it (deterministic, tz-explicit).
  const nowIso = now.toISOString();
  const cutoff24 = sql`(${nowIso}::timestamptz - interval '24 hours')`;

  // ── Per-project spine aggregates ────────────────────────────────────────────
  const baseRows = (await db.execute(sql`
    select
      p.id as project_id,
      p.client_id as client_id,
      p.slo as slo,
      max(e.occurred_at) as last_event_at,
      count(e.id) filter (where e.occurred_at >= ${cutoff24}) as total_24h,
      count(e.id) filter (
        where e.type = 'system.error' and e.occurred_at >= ${cutoff24}
      ) as errors_24h,
      count(e.id) filter (
        where e.type = 'system.error'
          and e.occurred_at >= (${nowIso}::timestamptz - interval '30 minutes')
      ) as errors_window,
      percentile_cont(0.95) within group (
        order by (e.data->>'duration_ms')::numeric
      ) filter (
        where (e.data ? 'duration_ms') and e.occurred_at >= ${cutoff24}
      ) as p95_ms
    from projects p
    left join events e on e.project_id = p.id and e.org_id = ${orgId}
    where p.org_id = ${orgId} and p.status = 'live'
    group by p.id, p.client_id, p.slo
  `)) as unknown as BaseRow[];

  // Heartbeat health needs two different windows. Existence + the last-seen
  // timestamp are computed ALL-TIME so a project whose heartbeat agent died
  // >24h ago still reads as "has an agent" with a huge gap-to-now (→ critical),
  // instead of collapsing to "na / no heartbeat agents" (which cannot be
  // distinguished from a project that never had one). The worst INTERNAL gap
  // stays a 24h window so a long-since-recovered historical outage doesn't
  // falsely re-fire on a currently-healthy agent.
  const heartbeatRows = (await db.execute(sql`
    with hb24 as (
      select project_id, occurred_at,
        lag(occurred_at) over (
          partition by project_id order by occurred_at
        ) as prev
      from events
      where org_id = ${orgId} and type = 'agent.heartbeat'
        and occurred_at >= ${cutoff24}
    ),
    gaps as (
      select project_id,
        max(extract(epoch from (occurred_at - prev)) / 60) as max_internal_gap_min
      from hb24
      group by project_id
    ),
    ever as (
      select project_id,
        count(*) as hb_count,
        max(occurred_at) as last_hb
      from events
      where org_id = ${orgId} and type = 'agent.heartbeat'
      group by project_id
    )
    select ever.project_id as project_id,
      ever.hb_count as hb_count,
      gaps.max_internal_gap_min as max_internal_gap_min,
      ever.last_hb as last_hb
    from ever
    left join gaps on gaps.project_id = ever.project_id
  `)) as unknown as HeartbeatRow[];

  const feedbackRows = (await db.execute(sql`
    select project_id, count(*) as neg
    from feedback_items
    where org_id = ${orgId}
      and created_at >= ${cutoff24}
      and (kind = 'bug' or severity >= 3)
    group by project_id
  `)) as unknown as FeedbackRow[];

  const retainerRows = (await db.execute(sql`
    select p.id as project_id,
      coalesce(bool_or(s.status = 'past_due'), false) as past_due
    from projects p
    left join subscriptions s
      on s.org_id = ${orgId}
      and (s.project_id = p.id or (s.project_id is null and s.client_id = p.client_id))
    where p.org_id = ${orgId} and p.status = 'live'
    group by p.id
  `)) as unknown as RetainerRow[];

  const heartbeatByProject = new Map<string, HeartbeatRow>();
  for (const r of heartbeatRows) heartbeatByProject.set(r.project_id, r);
  const negByProject = new Map<string, number>();
  for (const r of feedbackRows) negByProject.set(r.project_id, num(r.neg));
  const retainerByProject = new Map<string, boolean>();
  for (const r of retainerRows) retainerByProject.set(r.project_id, r.past_due);

  // ── Build inputs ────────────────────────────────────────────────────────────
  const inputs: ProjectHealthInput[] = [];
  for (const row of baseRows) {
    const hb = heartbeatByProject.get(row.project_id);
    const hasHeartbeats = hb ? num(hb.hb_count) > 0 : false;
    let maxHeartbeatGapMin: number | null = null;
    if (hasHeartbeats && hb) {
      const internal =
        hb.max_internal_gap_min === null ? 0 : num(hb.max_internal_gap_min);
      const lastHb = toDate(hb.last_hb);
      const gapToNow = lastHb
        ? (now.getTime() - lastHb.getTime()) / 60_000
        : 0;
      maxHeartbeatGapMin = Math.max(internal, gapToNow);
    }

    const input: ProjectHealthInput = {
      projectId: row.project_id,
      clientId: row.client_id,
      slo: row.slo ?? null,
      lastEventAt: toDate(row.last_event_at),
      errorCountWindow: num(row.errors_window),
      totalEvents24h: num(row.total_24h),
      errorEvents24h: num(row.errors_24h),
      hasHeartbeats,
      maxHeartbeatGapMin,
      p95DurationMs: row.p95_ms === null ? null : num(row.p95_ms),
      negativeFeedback24h: negByProject.get(row.project_id) ?? 0,
      retainerPastDue: retainerByProject.get(row.project_id) ?? false,
    };

    inputs.push(input);
  }

  return inputs;
}

export async function evaluateHealth(
  orgId: string,
  opts: EvaluateOptions = {},
): Promise<EvaluateResult> {
  const now = opts.now ?? new Date();
  const inputs = await loadProjectHealthInputs(orgId, now);
  // Additive Phase-9 cost-spike signals (own file), computed like `inputs`
  // BEFORE the transaction so the read is outside the advisory lock.
  const extraSignals = await costSpikeSignals(orgId, now);

  // ── Evaluate ────────────────────────────────────────────────────────────────
  const evaluations = new Map<string, ReturnType<typeof evaluateProject>>();
  const healthByProject: Record<string, HealthBadge> = {};
  for (const input of inputs) {
    const evalResult = evaluateProject(input, now);
    evaluations.set(input.projectId, evalResult);
    healthByProject[input.projectId] = evalResult.health;
  }

  // ── Reconcile alert_instances (health-owned rows only) ──────────────────────
  // Serialise concurrent evaluate runs for the same org (the Health screen's
  // "Re-evaluate now" button racing the 15-min cron) under a transaction-scoped
  // advisory lock: there is NO unique constraint on (project, check) — migration
  // 0009 ships only a non-unique open index — so a bare read-then-insert could
  // let two runs both observe "no open instance" and both insert a duplicate.
  // The lock makes the read → insert/update/resolve sequence atomic per org.
  const openByKey = new Map<string, OpenInstanceRow>();
  const inserts: (typeof alertInstances.$inferInsert)[] = [];
  const toResolve: string[] = [];

  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${orgId}))`);

    const openRows = (await tx
      .select({
        id: alertInstances.id,
        projectId: alertInstances.projectId,
        severity: alertInstances.severity,
        message: alertInstances.message,
        ackedAt: alertInstances.ackedAt,
        firedAt: alertInstances.firedAt,
        evidence: alertInstances.evidence,
      })
      .from(alertInstances)
      .where(
        and(
          eq(alertInstances.orgId, orgId),
          isNull(alertInstances.resolvedAt),
          sql`${alertInstances.evidence}->>'source' = 'health'`,
        ),
      )) as OpenInstanceRow[];

    for (const r of openRows) {
      const check = checkOf(r.evidence);
      if (r.projectId && check) openByKey.set(`${r.projectId}|${check}`, r);
    }

    // Insert new breaches; UPGRADE the severity/message of an already-open
    // instance when the same breach worsens (e.g. freshness warn → critical) so
    // it becomes eligible for the critical-only escalation query and the stored
    // row matches the live grid. A plain "already open, skip" would freeze the
    // row at its first-fire severity forever. Evidence is left untouched so the
    // escalated_at guard is never clobbered.
    const currentKeys = new Set<string>();
    const severityUpdates: {
      id: string;
      severity: "warn" | "critical";
      message: string;
    }[] = [];
    for (const [projectId, evalResult] of evaluations) {
      for (const signal of evalResult.signals) {
        const key = `${projectId}|${signal.check}`;
        currentKeys.add(key);
        const existing = openByKey.get(key);
        if (existing) {
          if (
            existing.severity !== signal.severity ||
            existing.message !== signal.message
          ) {
            severityUpdates.push({
              id: existing.id,
              severity: signal.severity,
              message: signal.message,
            });
          }
          continue; // already open — fire once, but keep it current
        }
        inserts.push({
          orgId,
          projectId,
          kind: signal.kind,
          severity: signal.severity,
          message: signal.message,
          evidence: { ...signal.evidence, source: "health" },
          firedAt: now,
        });
      }
    }

    // Additive cost-spike signals (P9-COST): same fire-once / keep-current /
    // auto-resolve semantics as the checks above, keyed on (project,'cost_spike').
    for (const signal of extraSignals) {
      const key = `${signal.projectId}|${signal.check}`;
      currentKeys.add(key);
      const existing = openByKey.get(key);
      if (existing) {
        if (
          existing.severity !== signal.severity ||
          existing.message !== signal.message
        ) {
          severityUpdates.push({
            id: existing.id,
            severity: signal.severity,
            message: signal.message,
          });
        }
        continue;
      }
      inserts.push({
        orgId,
        projectId: signal.projectId,
        kind: signal.kind,
        severity: signal.severity,
        message: signal.message,
        evidence: { ...signal.evidence, source: "health" },
        firedAt: now,
      });
    }

    if (inserts.length > 0) await tx.insert(alertInstances).values(inserts);
    for (const u of severityUpdates) {
      await tx
        .update(alertInstances)
        .set({ severity: u.severity, message: u.message })
        .where(eq(alertInstances.id, u.id));
    }

    // Auto-resolve: any open health instance whose check no longer breaches,
    // INCLUDING instances whose project is no longer live (paused/archived and
    // thus absent from this run's currentKeys) — otherwise such an alert lingers
    // open forever, keeping the banner lit and re-qualifying for escalation.
    for (const r of openRows) {
      const check = checkOf(r.evidence);
      if (!r.projectId || !check) continue;
      const key = `${r.projectId}|${check}`;
      if (!currentKeys.has(key)) toResolve.push(r.id);
    }
    if (toResolve.length > 0) {
      await tx
        .update(alertInstances)
        .set({ resolvedAt: now })
        .where(inArray(alertInstances.id, toResolve));
    }
  });

  // ── Write objective health badge per project ────────────────────────────────
  for (const [projectId, badge] of Object.entries(healthByProject)) {
    await db
      .update(projects)
      .set({ health: badge })
      .where(and(eq(projects.id, projectId), eq(projects.orgId, orgId)));
  }

  // ── Escalation ──────────────────────────────────────────────────────────────
  const escalations = {
    attempted: 0,
    sent: 0,
    twilioConfigured: true,
    recipientConfigured: true,
  };
  if (opts.escalate !== false) {
    const escalationRows = (await db
      .select({
        id: alertInstances.id,
        projectId: alertInstances.projectId,
        severity: alertInstances.severity,
        ackedAt: alertInstances.ackedAt,
        firedAt: alertInstances.firedAt,
        evidence: alertInstances.evidence,
        message: alertInstances.message,
      })
      .from(alertInstances)
      .where(
        and(
          eq(alertInstances.orgId, orgId),
          eq(alertInstances.severity, "critical"),
          isNull(alertInstances.ackedAt),
          isNull(alertInstances.resolvedAt),
          sql`${alertInstances.evidence}->>'source' = 'health'`,
          sql`not (${alertInstances.evidence} ? 'escalated_at')`,
          sql`${alertInstances.firedAt} <= (${now.toISOString()}::timestamptz - interval '${sql.raw(String(ESCALATION_AFTER_MINUTES))} minutes')`,
        ),
      )) as {
      id: string;
      message: string;
    }[];

    if (escalationRows.length > 0) {
      const to = await resolveEscalationTo(orgId);
      if (!to) escalations.recipientConfigured = false;
      for (const row of escalationRows) {
        escalations.attempted += 1;
        const res = await sendWhatsApp({
          to: to ?? "",
          body: `🚨 Azen OS health alert (critical, unacked ${ESCALATION_AFTER_MINUTES}m+): ${row.message}`,
        });
        if (res.ok) {
          escalations.sent += 1;
          await db
            .update(alertInstances)
            .set({
              evidence: sql`jsonb_set(${alertInstances.evidence}, '{escalated_at}', to_jsonb(${now.toISOString()}::text))`,
            })
            .where(eq(alertInstances.id, row.id));
        } else if (res.reason === "whatsapp_not_configured") {
          escalations.twilioConfigured = false;
        } else if (res.reason === "whatsapp_no_recipient") {
          // Twilio IS configured, but no recipient resolved — surface it rather
          // than silently dropping the escalation on every run.
          escalations.recipientConfigured = false;
        }
      }
    }
  }

  const stillOpen = openByKey.size - toResolve.length + inserts.length;

  return {
    evaluatedProjects: inputs.length,
    opened: inserts.length,
    resolved: toResolve.length,
    stillOpen,
    escalations,
    health: healthByProject,
  };
}
