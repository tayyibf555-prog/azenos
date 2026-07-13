/**
 * Opportunity Scout agent (spec §9.4; docs/phase6/CONTRACTS.md §P6-SCOUT).
 *
 * runOpportunityScout builds a DETERMINISTIC 30-day pack of ONE project's
 * operational signals — FAQ clusters already flagged as unautomated repetition
 * (scout_candidate), escalation patterns, repetitive human task.completed work,
 * error/drop-off patterns, and UNUSED TAXONOMY AREAS (deterministic absences,
 * e.g. bookings but no payments → "payment collection not automated") — plus any
 * industry playbooks from the knowledge base (empty until P6-LEARN). It passes
 * the pack through the fleet chassis (runAgent) with a versioned prompt + the
 * ScoutOutput zod schema, then writes one `insights` row per opportunity (kind
 * `automation_opportunity`). Rows are keyed by fingerprint = project + normalized
 * slug so a daily re-run UPDATES the same rows instead of duplicating them
 * (idempotent — the Phase 5 convo-cluster dedup/retirement approach reused here).
 * High-confidence opportunities get evidence.same_day_ping=true (WhatsApp is
 * delivered via the existing delivery layer only if keys are present).
 *
 * The unused-taxonomy detector (detectUnusedTaxonomyAreas) is PURE SQL over the
 * events spine — presence/absence of high-value categories in the window — so it
 * fires with no model and is unit-testable against hand-built events.
 *
 * Graceful degradation (spec §13): with no ANTHROPIC_API_KEY the runAgent call
 * returns a typed error and NO insights are written (never a crash). A pack with
 * no signals at all short-circuits before any model call.
 *
 * @azen/agents has no drizzle-orm dependency, so conditional reads/updates go
 * through the postgres-js client (db.$client); inserts use db.insert(...).values,
 * matching the Daily Brief + convo-cluster agents.
 */

import { type Db, db as defaultDb, insights } from "@azen/db";
import { z } from "zod";
import { scoutSystemPrompt } from "../prompts/scout";
import { type AgentErrorCode, runAgent } from "../runner";

// ── output contract (docs/phase6/CONTRACTS.md §P6-SCOUT exact) ────────────────
export const scoutOutputSchema = z.object({
  opportunities: z.array(
    z.object({
      title: z.string(),
      detected_md: z.string(),
      evidence_event_ids: z.array(z.string()),
      estimated_hours_saved_monthly: z.number(),
      estimated_value_pence: z.number(),
      confidence: z.enum(["low", "med", "high"]),
      suggested_price_band_pence: z.tuple([z.number(), z.number()]),
      fingerprint: z.string(),
    }),
  ),
});

export type ScoutOutput = z.infer<typeof scoutOutputSchema>;
export type ScoutOpportunity = ScoutOutput["opportunities"][number];

// ── deterministic data pack ───────────────────────────────────────────────────

export interface ScoutCandidate {
  insightId: string;
  title: string;
  note: string;
  count: number;
  sharePct: number;
  exampleEventIds: string[];
}

export interface ScoutEscalationReason {
  reason: string;
  count: number;
  exampleEventIds: string[];
}

export interface ScoutRepetitiveTask {
  what: string;
  count: number;
  totalMinutes: number;
  exampleEventIds: string[];
}

export interface ScoutErrorGroup {
  component: string;
  message: string;
  count: number;
  exampleEventIds: string[];
}

export interface UnusedTaxonomyArea {
  title: string;
  why: string;
  present: string[];
  missing: string[];
}

export interface ScoutPlaybook {
  title: string;
  bodyMd: string;
}

export interface ScoutPack {
  projectId: string;
  projectName: string;
  clientName: string;
  industrySlug: string | null;
  window: { fromDay: string; toDay: string; days: number };
  scoutCandidates: ScoutCandidate[];
  escalations: { total: number; byReason: ScoutEscalationReason[] };
  repetitiveHumanTasks: ScoutRepetitiveTask[];
  errors: { total: number; byComponent: ScoutErrorGroup[] };
  abandonedConversations: { total: number; exampleEventIds: string[]; topics: string[] };
  unusedTaxonomyAreas: UnusedTaxonomyArea[];
  playbooks: ScoutPlaybook[];
  generatedAt: string;
}

/** Days analysed by the Scout (spec §9.4 "last 30 days"). */
const WINDOW_DAYS = 30;
/** Cap example event ids cited per grouped signal (prompt-size guard). */
const MAX_EXAMPLE_IDS = 8;

export interface RunOpportunityScoutOptions {
  orgId: string;
  projectId: string;
  /**
   * London calendar day (YYYY-MM-DD) that ENDS the window (inclusive).
   * Default = yesterday (the latest complete London day).
   */
  forDayLondon?: string;
}

export type RunOpportunityScoutResult =
  | {
      ok: true;
      /** null when the pack was empty and no model call was made. */
      runId: string | null;
      opportunitiesWritten: number;
      sameDayPings: number;
      tokensIn: number;
      tokensOut: number;
      window: { fromDay: string; toDay: string };
    }
  | { ok: false; error: AgentErrorCode };

const num = (v: unknown): number => Number(v ?? 0);

/** Normalize a model-provided fingerprint slug into a stable kebab-case token. */
export function normalizeSlug(raw: string): string {
  return (
    raw
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "opportunity"
  );
}

/**
 * Fingerprint for dedup (§9.4): project + normalized-slug. Mirrors the
 * convo-cluster fingerprint scheme so a daily re-run collapses onto the same row.
 */
export function scoutFingerprint(projectId: string, slug: string): string {
  return `scout:${projectId}:${normalizeSlug(slug)}`;
}

/** low/med/high → the insight_confidence enum (identity; validated by zod). */
function confidenceEnum(c: ScoutOpportunity["confidence"]): "low" | "med" | "high" {
  return c;
}

// ── window boundaries (30-day, London, DST-safe) ──────────────────────────────

interface WindowRow {
  win_from: string;
  win_to: string;
  from_day: string;
  to_day: string;
  generated_at: string;
}

/**
 * The window is the 30 London days ENDING on forDay inclusive. All boundaries
 * are derived inside Postgres from the naive London wall-clock midnight using
 * the shared `… at time zone 'Europe/London'` rollup pattern, so every UTC
 * boundary is DST-correct. WINDOW_DAYS is fixed at 30 (postgres-js binds ${} as
 * parameters, which cannot appear inside an interval literal).
 */
async function loadWindow(db: Db, forDayLondon?: string): Promise<WindowRow> {
  const client = db.$client;
  const rows = (forDayLondon
    ? await client`
        with base as (select ${forDayLondon}::timestamp as day_start)
        select
          to_char(((day_start - interval '29 days') at time zone 'Europe/London') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as win_from,
          to_char(((day_start + interval '1 day') at time zone 'Europe/London') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as win_to,
          to_char(day_start - interval '29 days', 'YYYY-MM-DD') as from_day,
          to_char(day_start, 'YYYY-MM-DD') as to_day,
          to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as generated_at
        from base`
    : await client`
        with base as (select date_trunc('day', now() at time zone 'Europe/London') - interval '1 day' as day_start)
        select
          to_char(((day_start - interval '29 days') at time zone 'Europe/London') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as win_from,
          to_char(((day_start + interval '1 day') at time zone 'Europe/London') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as win_to,
          to_char(day_start - interval '29 days', 'YYYY-MM-DD') as from_day,
          to_char(day_start, 'YYYY-MM-DD') as to_day,
          to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as generated_at
        from base`) as unknown as WindowRow[];
  return rows[0]!;
}

// ── unused-taxonomy detector (PURE SQL — testable) ────────────────────────────

interface PresenceRow {
  bookings: number;
  payments_or_invoices: number;
  leads: number;
  bookings_completed: number;
  reviews: number;
  quotes: number;
  payments: number;
}

/**
 * Detect high-value taxonomy AREAS the project operates in but never automates,
 * as an ABSENCE: a category it DOES emit paired with a high-value category it
 * does NOT. Pure SQL — one presence-count query over the events window, then a
 * fixed, deterministic rule table. No model, no event ids (the evidence is the
 * documented gap). fromIso/toIso are half-open [from, to) UTC instants (the same
 * boundaries the pack window uses).
 */
export async function detectUnusedTaxonomyAreas(
  db: Db,
  orgId: string,
  projectId: string,
  fromIso: string,
  toIso: string,
): Promise<UnusedTaxonomyArea[]> {
  const rows = (await db.$client`
    select
      count(*) filter (where type like 'booking.%')::int as bookings,
      count(*) filter (where type like 'payment.%' or type like 'invoice.%')::int as payments_or_invoices,
      count(*) filter (where type like 'lead.%' or type = 'form.submitted')::int as leads,
      count(*) filter (where type = 'booking.completed')::int as bookings_completed,
      count(*) filter (where type = 'review.received')::int as reviews,
      count(*) filter (where type like 'quote.%')::int as quotes,
      count(*) filter (where type like 'payment.%')::int as payments
    from events
    where org_id = ${orgId}::uuid and project_id = ${projectId}::uuid
      and occurred_at >= ${fromIso}::timestamptz and occurred_at < ${toIso}::timestamptz
  `) as unknown as PresenceRow[];
  const p = rows[0]!;

  const areas: UnusedTaxonomyArea[] = [];

  // Bookings happen but nothing is ever charged → payment collection is manual.
  if (num(p.bookings) > 0 && num(p.payments_or_invoices) === 0) {
    areas.push({
      title: "Payment collection not automated",
      why: "This project books appointments but the OS never sees a payment or invoice event — deposits and payment collection are still done by hand.",
      present: ["booking.*"],
      missing: ["payment.*", "invoice.*"],
    });
  }

  // Leads are captured but nothing is ever booked → lead-to-booking is manual.
  if (num(p.leads) > 0 && num(p.bookings) === 0) {
    areas.push({
      title: "Lead-to-booking conversion not automated",
      why: "Leads and form submissions arrive but the OS never sees a booking event — turning enquiries into appointments is still a manual follow-up.",
      present: ["lead.*", "form.submitted"],
      missing: ["booking.*"],
    });
  }

  // Appointments complete but reviews are never captured → review requests manual.
  if (num(p.bookings_completed) > 0 && num(p.reviews) === 0) {
    areas.push({
      title: "Review requests not automated",
      why: "Appointments are completed but no review is ever recorded — asking happy customers for a review is not automated.",
      present: ["booking.completed"],
      missing: ["review.received"],
    });
  }

  // Quotes go out but nothing is ever charged → quote-to-payment is manual.
  if (num(p.quotes) > 0 && num(p.payments) === 0) {
    areas.push({
      title: "Quote-to-payment collection not automated",
      why: "Quotes are sent but the OS never sees a payment — collecting on accepted quotes is still handled manually.",
      present: ["quote.*"],
      missing: ["payment.*"],
    });
  }

  return areas;
}

// ── deterministic pack builder ────────────────────────────────────────────────

interface ProjectRow {
  name: string;
  client_name: string;
  industry_slug: string | null;
  industry_id: string | null;
}

interface CandidateRow {
  id: string;
  title: string;
  body_md: string;
  evidence: Record<string, unknown> | null;
}

interface ReasonRow {
  reason: string | null;
  count: number;
  ids: string[];
}

interface TaskRow {
  what: string | null;
  count: number;
  minutes: number;
  ids: string[];
}

interface ErrorRow {
  component: string | null;
  message: string | null;
  count: number;
  ids: string[];
}

interface AbandonedRow {
  total: number;
  ids: string[];
  topics: string[] | null;
}

interface PlaybookRow {
  title: string;
  body_md: string;
}

const strArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/**
 * Build the deterministic Scout pack. Pure SQL over the events + insights spines;
 * every grouped signal carries a capped list of real example event ids the model
 * may cite. Returns projectFound=false for an unknown/foreign project so the
 * caller can short-circuit.
 */
export async function buildScoutPack(
  db: Db,
  orgId: string,
  projectId: string,
  forDayLondon?: string,
): Promise<{ pack: ScoutPack; projectFound: boolean }> {
  const client = db.$client;
  const w = await loadWindow(db, forDayLondon);

  const projRows = (await client`
    select p.name as name, c.name as client_name,
      i.slug as industry_slug, c.industry_id::text as industry_id
    from projects p
    join clients c on c.id = p.client_id
    left join industries i on i.id = c.industry_id
    where p.id = ${projectId}::uuid and p.org_id = ${orgId}::uuid
    limit 1
  `) as unknown as ProjectRow[];
  const projectFound = projRows.length > 0;
  const proj = projRows[0];

  // ── scout candidates: faq_cluster insights already flagged as repetition ─────
  const candRows = (await client`
    select id::text as id, title, body_md, evidence
    from insights
    where org_id = ${orgId}::uuid and project_id = ${projectId}::uuid
      and kind = 'faq_cluster' and status <> 'dismissed'
      and evidence->>'scout_candidate' = 'true'
    order by (evidence->>'share_pct')::numeric desc nulls last
  `) as unknown as CandidateRow[];
  const scoutCandidates: ScoutCandidate[] = candRows.map((r) => {
    const ev = r.evidence ?? {};
    return {
      insightId: r.id,
      title: r.title,
      note: r.body_md,
      count: num(ev["count"]),
      sharePct: num(ev["share_pct"]),
      exampleEventIds: strArray(ev["event_ids"]).slice(0, MAX_EXAMPLE_IDS),
    };
  });

  // ── escalations: agent.escalated_to_human grouped by reason ──────────────────
  const reasonRows = (await client`
    select coalesce(data->>'reason', 'unspecified') as reason,
      count(*)::int as count,
      (array_agg(id::text order by occurred_at desc))[1:${MAX_EXAMPLE_IDS}] as ids
    from events
    where org_id = ${orgId}::uuid and project_id = ${projectId}::uuid
      and type = 'agent.escalated_to_human'
      and occurred_at >= ${w.win_from}::timestamptz and occurred_at < ${w.win_to}::timestamptz
    group by 1
    order by count desc, reason
  `) as unknown as ReasonRow[];
  const byReason: ScoutEscalationReason[] = reasonRows.map((r) => ({
    reason: r.reason ?? "unspecified",
    count: num(r.count),
    exampleEventIds: strArray(r.ids),
  }));
  const escalationsTotal = byReason.reduce((s, r) => s + r.count, 0);

  // ── repetitive human tasks: task.completed by a HUMAN, grouped by what ───────
  const taskRows = (await client`
    select coalesce(data->>'what', 'unspecified') as what,
      count(*)::int as count,
      coalesce(sum((data->>'minutes_spent')::numeric), 0)::int as minutes,
      (array_agg(id::text order by occurred_at desc))[1:${MAX_EXAMPLE_IDS}] as ids
    from events
    where org_id = ${orgId}::uuid and project_id = ${projectId}::uuid
      and type = 'task.completed'
      and coalesce(data->>'by', actor->>'kind') in ('human', 'person')
      and occurred_at >= ${w.win_from}::timestamptz and occurred_at < ${w.win_to}::timestamptz
    group by 1
    order by count desc, minutes desc, what
  `) as unknown as TaskRow[];
  const repetitiveHumanTasks: ScoutRepetitiveTask[] = taskRows.map((r) => ({
    what: r.what ?? "unspecified",
    count: num(r.count),
    totalMinutes: num(r.minutes),
    exampleEventIds: strArray(r.ids),
  }));

  // ── errors: system.error grouped by component + message ──────────────────────
  const errorRows = (await client`
    select coalesce(data->>'component', 'unknown') as component,
      coalesce(data->>'message', '') as message,
      count(*)::int as count,
      (array_agg(id::text order by occurred_at desc))[1:${MAX_EXAMPLE_IDS}] as ids
    from events
    where org_id = ${orgId}::uuid and project_id = ${projectId}::uuid
      and type = 'system.error'
      and occurred_at >= ${w.win_from}::timestamptz and occurred_at < ${w.win_to}::timestamptz
    group by 1, 2
    order by count desc, component
  `) as unknown as ErrorRow[];
  const byComponent: ScoutErrorGroup[] = errorRows.map((r) => ({
    component: r.component ?? "unknown",
    message: r.message ?? "",
    count: num(r.count),
    exampleEventIds: strArray(r.ids),
  }));
  const errorsTotal = byComponent.reduce((s, r) => s + r.count, 0);

  // ── abandoned conversations: llm.conversation resolution=abandoned ───────────
  const abRows = (await client`
    select
      count(*)::int as total,
      (array_agg(id::text order by occurred_at desc))[1:${MAX_EXAMPLE_IDS}] as ids,
      (
        select coalesce(array_agg(distinct topic), '{}')
        from events e2, jsonb_array_elements_text(e2.data->'topics') as topic
        where e2.org_id = ${orgId}::uuid and e2.project_id = ${projectId}::uuid
          and e2.type = 'llm.conversation' and e2.data->>'resolution' = 'abandoned'
          and e2.occurred_at >= ${w.win_from}::timestamptz and e2.occurred_at < ${w.win_to}::timestamptz
          and jsonb_typeof(e2.data->'topics') = 'array'
      ) as topics
    from events
    where org_id = ${orgId}::uuid and project_id = ${projectId}::uuid
      and type = 'llm.conversation' and data->>'resolution' = 'abandoned'
      and occurred_at >= ${w.win_from}::timestamptz and occurred_at < ${w.win_to}::timestamptz
  `) as unknown as AbandonedRow[];
  const ab = abRows[0]!;

  // ── unused taxonomy areas (pure SQL absence detection) ───────────────────────
  const unusedTaxonomyAreas = await detectUnusedTaxonomyAreas(
    db,
    orgId,
    projectId,
    w.win_from,
    w.win_to,
  );

  // ── industry playbooks (empty until P6-LEARN; read what exists) ──────────────
  let playbooks: ScoutPlaybook[] = [];
  if (proj?.industry_id) {
    const pbRows = (await client`
      select title, body_md
      from knowledge_articles
      where org_id = ${orgId}::uuid and industry_id = ${proj.industry_id}::uuid
        and kind in ('playbook', 'industry_primer')
      order by created_at desc
      limit 5
    `) as unknown as PlaybookRow[];
    playbooks = pbRows.map((r) => ({ title: r.title, bodyMd: r.body_md }));
  }

  const pack: ScoutPack = {
    projectId,
    projectName: proj?.name ?? "",
    clientName: proj?.client_name ?? "",
    industrySlug: proj?.industry_slug ?? null,
    window: { fromDay: w.from_day, toDay: w.to_day, days: WINDOW_DAYS },
    scoutCandidates,
    escalations: { total: escalationsTotal, byReason },
    repetitiveHumanTasks,
    errors: { total: errorsTotal, byComponent },
    abandonedConversations: {
      total: num(ab.total),
      exampleEventIds: strArray(ab.ids),
      topics: strArray(ab.topics),
    },
    unusedTaxonomyAreas,
    playbooks,
    generatedAt: w.generated_at,
  };

  return { pack, projectFound };
}

/** True when the pack carries at least one signal worth asking the model about. */
function packHasSignal(pack: ScoutPack): boolean {
  return (
    pack.scoutCandidates.length > 0 ||
    pack.escalations.total > 0 ||
    pack.repetitiveHumanTasks.length > 0 ||
    pack.errors.total > 0 ||
    pack.abandonedConversations.total > 0 ||
    pack.unusedTaxonomyAreas.length > 0
  );
}

// ── run + persist ─────────────────────────────────────────────────────────────

export async function runOpportunityScout(
  db: Db,
  opts: RunOpportunityScoutOptions,
): Promise<RunOpportunityScoutResult> {
  const { pack, projectFound } = await buildScoutPack(
    db,
    opts.orgId,
    opts.projectId,
    opts.forDayLondon,
  );

  // Unknown project or a completely quiet pack → nothing to scout; skip the call.
  if (!projectFound || !packHasSignal(pack)) {
    return {
      ok: true,
      runId: null,
      opportunitiesWritten: 0,
      sameDayPings: 0,
      tokensIn: 0,
      tokensOut: 0,
      window: { fromDay: pack.window.fromDay, toDay: pack.window.toDay },
    };
  }

  const run = await runAgent<ScoutOutput>({
    agent: "opportunity_scout",
    orgId: opts.orgId,
    projectId: opts.projectId,
    clientId: null,
    systemPrompt: scoutSystemPrompt(),
    userContent: JSON.stringify(pack),
    schema: scoutOutputSchema,
    dataSnapshot: pack as unknown as Record<string, unknown>,
    maxTokens: 4000,
  });

  if (!run.ok) return { ok: false, error: run.error };

  // Only cite event ids the model was actually given (drop hallucinations).
  const validIds = collectPackEventIds(pack);

  const written = await writeOpportunities(
    db,
    opts.orgId,
    opts.projectId,
    run.output.opportunities,
    validIds,
    pack.window,
  );

  return {
    ok: true,
    runId: run.runId,
    opportunitiesWritten: written.opportunitiesWritten,
    sameDayPings: written.sameDayPings,
    tokensIn: run.tokensIn,
    tokensOut: run.tokensOut,
    window: { fromDay: pack.window.fromDay, toDay: pack.window.toDay },
  };
}

/** Every real event id present anywhere in the pack (for hallucination filtering). */
function collectPackEventIds(pack: ScoutPack): Set<string> {
  const ids = new Set<string>();
  for (const c of pack.scoutCandidates) for (const id of c.exampleEventIds) ids.add(id);
  for (const r of pack.escalations.byReason) for (const id of r.exampleEventIds) ids.add(id);
  for (const t of pack.repetitiveHumanTasks) for (const id of t.exampleEventIds) ids.add(id);
  for (const e of pack.errors.byComponent) for (const id of e.exampleEventIds) ids.add(id);
  for (const id of pack.abandonedConversations.exampleEventIds) ids.add(id);
  return ids;
}

interface ExistingFingerprintRow {
  id: string;
  fingerprint: string | null;
  status: string;
}

/**
 * Persist opportunities as automation_opportunity insights, idempotently. Rows
 * matched by fingerprint are UPDATED in place; new fingerprints are INSERTed. A
 * row's review status is left untouched on update so a re-run never resurrects a
 * dismissed insight. After writing, orphaned still-'new' rows whose fingerprint
 * did NOT appear in this run are retired (the convo-cluster label-drift approach);
 * owner-engaged (reviewed/actioned) and dismissed rows are preserved.
 */
async function writeOpportunities(
  db: Db,
  orgId: string,
  projectId: string,
  opportunities: ScoutOpportunity[],
  validIds: Set<string>,
  window: { fromDay: string; toDay: string },
): Promise<{ opportunitiesWritten: number; sameDayPings: number }> {
  const client = db.$client;

  const existingRows = (await client`
    select id::text as id, fingerprint, status::text as status
    from insights
    where org_id = ${orgId}::uuid and project_id = ${projectId}::uuid
      and kind = 'automation_opportunity'
  `) as unknown as ExistingFingerprintRow[];
  const byFingerprint = new Map<string, string>();
  for (const r of existingRows) {
    if (r.fingerprint) byFingerprint.set(r.fingerprint, r.id);
  }

  const seen = new Set<string>();
  let opportunitiesWritten = 0;
  let sameDayPings = 0;

  for (const op of opportunities) {
    const fingerprint = scoutFingerprint(projectId, op.fingerprint);
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);

    const eventIds = op.evidence_event_ids.filter((id) => validIds.has(id));
    const confidence = confidenceEnum(op.confidence);
    const sameDayPing = confidence === "high";
    if (sameDayPing) sameDayPings += 1;

    const hoursSaved = Math.max(0, Math.round(op.estimated_hours_saved_monthly));
    const valuePence = Math.max(0, Math.round(op.estimated_value_pence));
    const priceBand: [number, number] = [
      Math.max(0, Math.round(op.suggested_price_band_pence[0])),
      Math.max(0, Math.round(op.suggested_price_band_pence[1])),
    ];

    const evidence: Record<string, unknown> = {
      event_ids: eventIds,
      aggregates: {
        estimated_hours_saved_monthly: hoursSaved,
        estimated_value_pence: valuePence,
        suggested_price_band_pence: priceBand,
      },
      window: { from: window.fromDay, to: window.toDay },
    };
    if (sameDayPing) evidence.same_day_ping = true;

    const existingId = byFingerprint.get(fingerprint);
    if (existingId) {
      await client`
        update insights set
          title = ${op.title},
          body_md = ${op.detected_md},
          evidence = ${JSON.stringify(evidence)}::jsonb,
          estimated_value_pence = ${valuePence},
          estimated_hours_saved_monthly = ${hoursSaved},
          confidence = ${confidence}::insight_confidence
        where id = ${existingId}::uuid
      `;
    } else {
      await db.insert(insights).values({
        orgId,
        projectId,
        kind: "automation_opportunity",
        title: op.title,
        bodyMd: op.detected_md,
        evidence,
        fingerprint,
        estimatedValuePence: valuePence,
        estimatedHoursSavedMonthly: hoursSaved,
        confidence,
        status: "new",
        createdBy: "agent",
      });
    }
    opportunitiesWritten += 1;
  }

  // Retire orphaned, still-'new' opportunities whose fingerprint left this run.
  const orphanIds = existingRows
    .filter(
      (r) => r.fingerprint !== null && !seen.has(r.fingerprint) && r.status === "new",
    )
    .map((r) => r.id);
  if (orphanIds.length > 0) {
    await client`
      delete from insights
      where org_id = ${orgId}::uuid and project_id = ${projectId}::uuid
        and kind = 'automation_opportunity' and status = 'new'
        and id::text = any(${orphanIds})
    `;
  }

  return { opportunitiesWritten, sameDayPings };
}

// ── org fan-out (used by the CLI + the daily job) ─────────────────────────────

export interface RunOpportunityScoutForOrgResult {
  projects: {
    projectId: string;
    projectName: string;
    result: RunOpportunityScoutResult;
  }[];
}

/**
 * Scout every non-terminal project in an org. Errors on one project (budget halt
 * or a missing API key) do not stop the rest — each project's typed result is
 * returned for the caller to log.
 */
export async function runOpportunityScoutForOrg(
  db: Db,
  orgId: string,
  forDayLondon?: string,
): Promise<RunOpportunityScoutForOrgResult> {
  const rows = (await db.$client`
    select id::text as id, name
    from projects
    where org_id = ${orgId}::uuid and status not in ('completed', 'cancelled')
    order by name
  `) as unknown as { id: string; name: string }[];

  const projects: RunOpportunityScoutForOrgResult["projects"] = [];
  for (const p of rows) {
    const result = await runOpportunityScout(db, {
      orgId,
      projectId: p.id,
      forDayLondon,
    });
    projects.push({ projectId: p.id, projectName: p.name, result });
  }
  return { projects };
}

/** Convenience for the CLI / cron: run against the default pooled db. */
export function runOpportunityScoutForOrgDefault(
  orgId: string,
  forDayLondon?: string,
): Promise<RunOpportunityScoutForOrgResult> {
  return runOpportunityScoutForOrg(defaultDb, orgId, forDayLondon);
}
