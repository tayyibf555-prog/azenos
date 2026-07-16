/**
 * KB-gap miner agent (docs/phase9/CONTRACTS.md §P9-KB).
 *
 * runKbGapMiner builds a DETERMINISTIC pack of ONE project's CONTENT GAPS — the
 * recurring `llm.conversation` intents that are FREQUENT and handled badly
 * (escalated, abandoned, or negative). It passes the pack through the fleet
 * chassis (runAgent) with a versioned prompt + the KbGapOutput zod schema, then
 * writes one `insights` row per gap (kind `automation_opportunity`) carrying
 * evidence.content_gap=true and the model's DRAFT (suggested KB article +
 * bot-improvement brief) inside evidence.draft. Because the Growth pipeline reads
 * automation_opportunity insights (status new|reviewed), these gaps flow straight
 * into the sellable-work funnel with no new write path.
 *
 * Rows are keyed by fingerprint = project + normalized intent slug so a re-run
 * UPDATES the same rows instead of duplicating them (the Phase 5 convo-cluster /
 * Phase 6 scout dedup + label-drift-retirement approach reused here). A row's
 * review status is left untouched on update so a re-run never resurrects a
 * dismissed insight; still-'new' rows whose fingerprint left this run are retired.
 *
 * The content-gap detector (buildKbGapPack) is PURE SQL over the events spine —
 * per-intent frequency + mishandled counts in a 30-day London window — so the
 * candidate gaps are deterministic and unit-testable against hand-built events.
 *
 * Graceful degradation (spec §13): with no ANTHROPIC_API_KEY the runAgent call
 * returns a typed error and NO insights are written (never a crash). A pack with
 * no gaps short-circuits before any model call.
 *
 * AGENT-KIND NOTE (reported to the lead): os_agent_kind has no dedicated
 * `kb_gap_miner` value and the schema is lead-owned (no migration in this
 * workstream), so runAgent logs these runs under `opportunity_scout` — the gaps
 * become automation_opportunity insights, exactly the Scout's output family.
 * Switch to a dedicated kind if the lead adds one.
 *
 * @azen/agents has no drizzle-orm dependency, so conditional reads/updates go
 * through the postgres-js client (db.$client); inserts use db.insert(...).values,
 * matching the convo-cluster + scout agents.
 */

import { type Db, db as defaultDb, insights } from "@azen/db";
import { z } from "zod";
import { kbGapSystemPrompt } from "../prompts/kb-gaps";
import { type AgentErrorCode, runAgent } from "../runner";

// ── output contract (docs/phase9/CONTRACTS.md §P9-KB) ─────────────────────────
export const kbGapOutputSchema = z.object({
  gaps: z.array(
    z.object({
      intent: z.string(),
      question: z.string(),
      article_title: z.string(),
      article_md: z.string(),
      bot_improvement: z.string(),
      example_event_ids: z.array(z.string()),
      estimated_hours_saved_monthly: z.number(),
      estimated_value_pence: z.number(),
      confidence: z.enum(["low", "med", "high"]),
      fingerprint: z.string(),
    }),
  ),
});

export type KbGapOutput = z.infer<typeof kbGapOutputSchema>;
export type KbGapDraft = KbGapOutput["gaps"][number];

// ── deterministic data pack ───────────────────────────────────────────────────

export interface KbGap {
  intent: string;
  total: number;
  escalated: number;
  abandoned: number;
  negative: number;
  resolved: number;
  /** Distinct conversations that escalated, were abandoned, or came back negative. */
  gapSignals: number;
  topics: string[];
  exampleEventIds: string[];
}

export interface KbGapPack {
  projectId: string;
  projectName: string;
  clientName: string;
  industrySlug: string | null;
  window: { fromDay: string; toDay: string; days: number };
  totals: { conversations: number };
  gaps: KbGap[];
  generatedAt: string;
}

/** Days analysed (matches the Scout's 30-day operational window). */
const WINDOW_DAYS = 30;
/** A candidate gap needs at least this many mishandled conversations. */
const MIN_GAP_SIGNALS = 3;
/** Cap gaps in the pack (most-mishandled first) — prompt-size guard. */
const MAX_GAPS = 12;
/** Cap example event ids cited per gap. */
const MAX_EXAMPLE_IDS = 5;

export interface RunKbGapMinerOptions {
  orgId: string;
  projectId: string;
  /**
   * London calendar day (YYYY-MM-DD) that ENDS the window (inclusive).
   * Default = yesterday (the latest complete London day).
   */
  forDayLondon?: string;
}

export type RunKbGapMinerResult =
  | {
      ok: true;
      /** null when the pack had no gaps and no model call was made. */
      runId: string | null;
      /** New content-gap insights INSERTED this run (genuinely new sellable work). */
      gapsWritten: number;
      /** Existing LIVE insights refreshed in place (not new; dismissed rows excluded). */
      gapsUpdated: number;
      tokensIn: number;
      tokensOut: number;
      window: { fromDay: string; toDay: string };
    }
  | { ok: false; error: AgentErrorCode };

const num = (v: unknown): number => Number(v ?? 0);

const strArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/** Normalize a slug into a stable kebab-case token (shared with scout scheme). */
export function normalizeGapSlug(raw: string): string {
  return (
    raw
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "content-gap"
  );
}

/**
 * Fingerprint for dedup (§P9-KB): project + normalized intent slug. Mirrors the
 * convo-cluster / scout fingerprint scheme so a re-run collapses onto the same row.
 */
export function kbGapFingerprint(projectId: string, slug: string): string {
  return `kbgap:${projectId}:${normalizeGapSlug(slug)}`;
}

interface WindowRow {
  win_from: string;
  win_to: string;
  from_day: string;
  to_day: string;
  generated_at: string;
}

/**
 * The window is the 30 London days ENDING on forDay inclusive. Every UTC boundary
 * is derived inside Postgres from the naive London wall-clock midnight using the
 * shared `… at time zone 'Europe/London'` rollup pattern, so it is DST-correct.
 * WINDOW_DAYS is fixed at 30 (postgres-js binds ${} as parameters, which cannot
 * appear inside an interval literal).
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

interface ProjectRow {
  name: string;
  client_name: string;
  industry_slug: string | null;
}

interface GapRow {
  intent: string;
  total: number;
  escalated: number;
  abandoned: number;
  negative: number;
  resolved: number;
  gap_signals: number;
  ids: string[] | null;
}

interface TotalRow {
  conversations: number;
}

/**
 * Build the deterministic KB-gap pack. Pure SQL over the events spine: group the
 * window's `llm.conversation` events by intent, count the mishandled ones
 * (escalated / abandoned / negative sentiment), and keep intents with at least
 * MIN_GAP_SIGNALS mishandled conversations, most-mishandled first. Each gap
 * carries a capped list of REAL event ids the model may cite (only from the
 * mishandled conversations — the evidence of the gap). Returns projectFound=false
 * for an unknown/foreign project so the caller can short-circuit.
 */
export async function buildKbGapPack(
  db: Db,
  orgId: string,
  projectId: string,
  forDayLondon?: string,
): Promise<{ pack: KbGapPack; projectFound: boolean }> {
  const client = db.$client;
  const w = await loadWindow(db, forDayLondon);

  const projRows = (await client`
    select p.name as name, c.name as client_name, i.slug as industry_slug
    from projects p
    join clients c on c.id = p.client_id
    left join industries i on i.id = c.industry_id
    where p.id = ${projectId}::uuid and p.org_id = ${orgId}::uuid
    limit 1
  `) as unknown as ProjectRow[];
  const projectFound = projRows.length > 0;
  const proj = projRows[0];

  const totalRows = (await client`
    select count(*)::int as conversations
    from events
    where org_id = ${orgId}::uuid and project_id = ${projectId}::uuid
      and type = 'llm.conversation'
      and occurred_at >= ${w.win_from}::timestamptz and occurred_at < ${w.win_to}::timestamptz
  `) as unknown as TotalRow[];

  // Per-intent content-gap detection. `mishandled` is the boolean that defines a
  // gap signal (escalated OR abandoned OR negative). We count it once per
  // conversation (a single convo that is both escalated AND negative counts once)
  // and cite only the mishandled conversations' ids.
  const gapRows = (await client`
    select
      coalesce(nullif(data->>'intent', ''), 'unspecified') as intent,
      count(*)::int as total,
      count(*) filter (where data->>'resolution' = 'escalated')::int as escalated,
      count(*) filter (where data->>'resolution' = 'abandoned')::int as abandoned,
      count(*) filter (where data->>'sentiment' = 'negative')::int as negative,
      count(*) filter (where data->>'resolution' = 'resolved')::int as resolved,
      count(*) filter (
        where data->>'resolution' in ('escalated','abandoned') or data->>'sentiment' = 'negative'
      )::int as gap_signals,
      (array_agg(id::text order by occurred_at desc) filter (
        where data->>'resolution' in ('escalated','abandoned') or data->>'sentiment' = 'negative'
      ))[1:${MAX_EXAMPLE_IDS}] as ids
    from events
    where org_id = ${orgId}::uuid and project_id = ${projectId}::uuid
      and type = 'llm.conversation'
      and occurred_at >= ${w.win_from}::timestamptz and occurred_at < ${w.win_to}::timestamptz
    group by 1
    having count(*) filter (
      where data->>'resolution' in ('escalated','abandoned') or data->>'sentiment' = 'negative'
    ) >= ${MIN_GAP_SIGNALS}
    order by gap_signals desc, total desc, intent
    limit ${MAX_GAPS}
  `) as unknown as GapRow[];

  // Topics per gap: a second focused pass keeps the group-by query simple and
  // avoids fighting jsonb aggregation. Cheap — one small query per project run.
  const gaps: KbGap[] = [];
  for (const r of gapRows) {
    const topicRows = (await client`
      select coalesce(array_agg(distinct topic), '{}') as topics
      from events e, jsonb_array_elements_text(e.data->'topics') as topic
      where e.org_id = ${orgId}::uuid and e.project_id = ${projectId}::uuid
        and e.type = 'llm.conversation'
        and coalesce(nullif(e.data->>'intent', ''), 'unspecified') = ${r.intent}
        and e.occurred_at >= ${w.win_from}::timestamptz and e.occurred_at < ${w.win_to}::timestamptz
        and jsonb_typeof(e.data->'topics') = 'array'
    `) as unknown as { topics: string[] | null }[];
    gaps.push({
      intent: r.intent,
      total: num(r.total),
      escalated: num(r.escalated),
      abandoned: num(r.abandoned),
      negative: num(r.negative),
      resolved: num(r.resolved),
      gapSignals: num(r.gap_signals),
      topics: strArray(topicRows[0]?.topics).slice(0, 12),
      exampleEventIds: strArray(r.ids),
    });
  }

  const pack: KbGapPack = {
    projectId,
    projectName: proj?.name ?? "",
    clientName: proj?.client_name ?? "",
    industrySlug: proj?.industry_slug ?? null,
    window: { fromDay: w.from_day, toDay: w.to_day, days: WINDOW_DAYS },
    totals: { conversations: num(totalRows[0]?.conversations) },
    gaps,
    generatedAt: w.generated_at,
  };

  return { pack, projectFound };
}

// ── run + persist ─────────────────────────────────────────────────────────────

export async function runKbGapMiner(
  db: Db,
  opts: RunKbGapMinerOptions,
): Promise<RunKbGapMinerResult> {
  const { pack, projectFound } = await buildKbGapPack(
    db,
    opts.orgId,
    opts.projectId,
    opts.forDayLondon,
  );

  // Unknown project or no gaps → nothing to mine; skip the model call.
  if (!projectFound || pack.gaps.length === 0) {
    return {
      ok: true,
      runId: null,
      gapsWritten: 0,
      gapsUpdated: 0,
      tokensIn: 0,
      tokensOut: 0,
      window: { fromDay: pack.window.fromDay, toDay: pack.window.toDay },
    };
  }

  const run = await runAgent<KbGapOutput>({
    // os_agent_kind has no kb-gap value; log under opportunity_scout (see header).
    agent: "opportunity_scout",
    orgId: opts.orgId,
    projectId: opts.projectId,
    clientId: null,
    systemPrompt: kbGapSystemPrompt(),
    userContent: JSON.stringify(pack),
    schema: kbGapOutputSchema,
    dataSnapshot: pack as unknown as Record<string, unknown>,
    maxTokens: 4000,
  });

  if (!run.ok) return { ok: false, error: run.error };

  // Only cite event ids the model was actually given (drop hallucinations), and
  // map each valid intent → its pack gap so evidence aggregates stay grounded.
  const validIds = new Set<string>();
  const gapByIntent = new Map<string, KbGap>();
  for (const g of pack.gaps) {
    gapByIntent.set(g.intent, g);
    for (const id of g.exampleEventIds) validIds.add(id);
  }

  const written = await writeGaps(
    db,
    opts.orgId,
    opts.projectId,
    run.output.gaps,
    validIds,
    gapByIntent,
    pack.window,
  );

  return {
    ok: true,
    runId: run.runId,
    gapsWritten: written.inserted,
    gapsUpdated: written.updated,
    tokensIn: run.tokensIn,
    tokensOut: run.tokensOut,
    window: { fromDay: pack.window.fromDay, toDay: pack.window.toDay },
  };
}

interface ExistingFingerprintRow {
  id: string;
  fingerprint: string | null;
  status: string;
}

/**
 * Persist gaps as automation_opportunity insights, idempotently. Rows matched by
 * fingerprint are UPDATED in place; new fingerprints are INSERTed. The draft
 * (suggested KB article + bot-improvement brief) is stored in evidence.draft and
 * evidence.content_gap=true flags these for the KB-gap surface / Growth reads. A
 * LIVE row's review status is left untouched on update; a DISMISSED row is left
 * entirely alone (not rewritten, not counted) so it stays hidden from Growth and
 * the reported figures reflect only actionable output. The result separates
 * `inserted` (new sellable work) from `updated` (existing live rows refreshed),
 * so an identical re-run reports 0 inserted. After writing, orphaned
 * still-'new' content-gap rows whose fingerprint left this run are retired
 * (the convo-cluster label-drift approach); owner-engaged and dismissed rows are
 * preserved. Retirement is scoped to content_gap rows so it never touches the
 * Scout's own automation_opportunity insights.
 */
async function writeGaps(
  db: Db,
  orgId: string,
  projectId: string,
  drafts: KbGapDraft[],
  validIds: Set<string>,
  gapByIntent: Map<string, KbGap>,
  window: { fromDay: string; toDay: string },
): Promise<{ inserted: number; updated: number }> {
  const client = db.$client;

  // Only content-gap rows participate in this run's fingerprint map + retirement.
  const existingRows = (await client`
    select id::text as id, fingerprint, status::text as status
    from insights
    where org_id = ${orgId}::uuid and project_id = ${projectId}::uuid
      and kind = 'automation_opportunity'
      and evidence->>'content_gap' = 'true'
  `) as unknown as ExistingFingerprintRow[];
  const byFingerprint = new Map<string, ExistingFingerprintRow>();
  for (const r of existingRows) {
    if (r.fingerprint) byFingerprint.set(r.fingerprint, r);
  }

  const seen = new Set<string>();
  let inserted = 0;
  let updated = 0;

  for (const d of drafts) {
    const fingerprint = kbGapFingerprint(projectId, d.fingerprint || d.intent);
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);

    const eventIds = d.example_event_ids.filter((id) => validIds.has(id));
    const confidence = d.confidence;
    const hoursSaved = Math.max(0, Math.round(d.estimated_hours_saved_monthly));
    const valuePence = Math.max(0, Math.round(d.estimated_value_pence));
    const gap = gapByIntent.get(d.intent);

    const evidence: Record<string, unknown> = {
      content_gap: true,
      event_ids: eventIds,
      intent: d.intent,
      question: d.question,
      draft: {
        article_title: d.article_title,
        article_md: d.article_md,
        bot_improvement: d.bot_improvement,
      },
      aggregates: {
        total: gap?.total ?? null,
        gap_signals: gap?.gapSignals ?? null,
        escalated: gap?.escalated ?? null,
        abandoned: gap?.abandoned ?? null,
        negative: gap?.negative ?? null,
        estimated_hours_saved_monthly: hoursSaved,
        estimated_value_pence: valuePence,
      },
      window: { from: window.fromDay, to: window.toDay },
    };

    const existing = byFingerprint.get(fingerprint);
    if (existing) {
      // A dismissed row is left untouched: it stays hidden from Growth and is not
      // actionable/new output, so it is neither rewritten nor counted. (Its
      // fingerprint is still `seen`, so it is never re-inserted or retired.)
      if (existing.status === "dismissed") continue;
      await client`
        update insights set
          title = ${d.article_title},
          body_md = ${d.article_md},
          evidence = ${JSON.stringify(evidence)}::jsonb,
          estimated_value_pence = ${valuePence},
          estimated_hours_saved_monthly = ${hoursSaved},
          confidence = ${confidence}::insight_confidence
        where id = ${existing.id}::uuid
      `;
      updated += 1;
    } else {
      await db.insert(insights).values({
        orgId,
        projectId,
        kind: "automation_opportunity",
        title: d.article_title,
        bodyMd: d.article_md,
        evidence,
        fingerprint,
        estimatedValuePence: valuePence,
        estimatedHoursSavedMonthly: hoursSaved,
        confidence,
        status: "new",
        createdBy: "agent",
      });
      inserted += 1;
    }
  }

  // Retire orphaned, still-'new' content-gap rows whose fingerprint left this run.
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
        and evidence->>'content_gap' = 'true'
        and id::text = any(${orphanIds})
    `;
  }

  return { inserted, updated };
}

// ── org fan-out (used by the CLI + the daily job) ─────────────────────────────

export interface RunKbGapMinerForOrgResult {
  projects: {
    projectId: string;
    projectName: string;
    result: RunKbGapMinerResult;
  }[];
}

/**
 * Mine content gaps for every non-terminal project in an org. Errors on one
 * project (budget halt or a missing API key) do not stop the rest — each
 * project's typed result is returned for the caller to log.
 */
export async function runKbGapMinerForOrg(
  db: Db,
  orgId: string,
  forDayLondon?: string,
): Promise<RunKbGapMinerForOrgResult> {
  const rows = (await db.$client`
    select id::text as id, name
    from projects
    where org_id = ${orgId}::uuid and status not in ('completed', 'cancelled')
    order by name
  `) as unknown as { id: string; name: string }[];

  const projects: RunKbGapMinerForOrgResult["projects"] = [];
  for (const p of rows) {
    const result = await runKbGapMiner(db, {
      orgId,
      projectId: p.id,
      forDayLondon,
    });
    projects.push({ projectId: p.id, projectName: p.name, result });
  }
  return { projects };
}

/** Convenience for the CLI / cron: run against the default pooled db. */
export function runKbGapMinerForOrgDefault(
  orgId: string,
  forDayLondon?: string,
): Promise<RunKbGapMinerForOrgResult> {
  return runKbGapMinerForOrg(defaultDb, orgId, forDayLondon);
}
