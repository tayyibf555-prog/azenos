/**
 * Conversation clustering agent (spec §8.3, §9; docs/phase5/CONTRACTS.md
 * §P5-CONVO).
 *
 * runConvoClustering builds a DETERMINISTIC pack of a project's `llm.conversation`
 * events for a 7-day London window (plus the prior week's per-topic counts for
 * trend), passes it through the fleet chassis (runAgent) with a versioned prompt
 * + the ConvoClusterOutput zod schema, then writes one `insights` row per cluster
 * (kind `faq_cluster`). Rows are keyed by fingerprint = project + normalized topic
 * so a daily re-run UPDATES the same rows instead of duplicating them (idempotent,
 * §P5-CONVO). Clusters the model marks `is_unautomated_repetition` get
 * evidence.scout_candidate=true — the Opportunity Scout (Phase 6) reads these.
 *
 * Graceful degradation (spec §13): with no ANTHROPIC_API_KEY the runAgent call
 * returns a typed error and NO insights are written (never a crash). A window
 * with zero conversations short-circuits before any model call.
 *
 * @azen/agents has no drizzle-orm dependency, so conditional reads/updates go
 * through the postgres-js client (db.$client); inserts use db.insert(...).values,
 * matching the Daily Brief agent.
 *
 * AGENT-KIND NOTE (reported to the lead): os_agent_kind has no dedicated
 * `conversation_cluster` value and the schema is lead-owned (no migration in this
 * workstream), so runAgent logs these runs under the most semantically aligned
 * existing kind, `opportunity_scout` — the contract explicitly ties conversation
 * clustering to the Scout ("unautomated-repetition flags cross-filed for the
 * Scout"). Switch to a dedicated kind if the lead adds one.
 */

import { type Db, db as defaultDb, insights } from "@azen/db";
import { z } from "zod";
import { convoClusterSystemPrompt } from "../prompts/convo-cluster";
import { type AgentErrorCode, runAgent } from "../runner";

// ── output contract (docs/phase5/CONTRACTS.md §P5-CONVO exact) ────────────────
export const convoClusterOutputSchema = z.object({
  clusters: z.array(
    z.object({
      topic: z.string(),
      count: z.number(),
      share_pct: z.number(),
      example_event_ids: z.array(z.string()),
      trend_vs_last_week: z.enum(["up", "down", "flat", "new"]),
      is_unautomated_repetition: z.boolean(),
      note: z.string(),
    }),
  ),
});

export type ConvoClusterOutput = z.infer<typeof convoClusterOutputSchema>;
export type ConvoTrend = ConvoClusterOutput["clusters"][number]["trend_vs_last_week"];

// ── deterministic data pack ───────────────────────────────────────────────────

export interface ConvoConversation {
  eventId: string;
  occurredAt: string;
  channel: string | null;
  intent: string | null;
  topics: string[];
  resolution: string | null;
  sentiment: string | null;
  summary: string | null;
}

export interface ConvoClusterPack {
  projectId: string;
  projectName: string;
  window: { fromDay: string; toDay: string; days: number };
  totals: { thisWeek: number; lastWeek: number };
  resolution: { resolved: number; escalated: number; abandoned: number };
  sentiment: { positive: number; neutral: number; negative: number };
  conversations: ConvoConversation[];
  lastWeekTopicCounts: { topic: string; count: number }[];
  generatedAt: string;
}

/** Newest N conversations included verbatim in the pack (prompt-size guard). */
const MAX_CONVERSATIONS = 400;
/** Days in each comparison window. */
const WINDOW_DAYS = 7;

export interface RunConvoClusteringOptions {
  orgId: string;
  projectId: string;
  /**
   * London calendar day (YYYY-MM-DD) that ENDS the this-week window (inclusive).
   * Default = yesterday (the latest complete London day).
   */
  forDayLondon?: string;
}

export type RunConvoClusteringResult =
  | {
      ok: true;
      /** null when the window was empty and no model call was made. */
      runId: string | null;
      clustersWritten: number;
      scoutCandidates: number;
      tokensIn: number;
      tokensOut: number;
      window: { fromDay: string; toDay: string };
    }
  | { ok: false; error: AgentErrorCode };

const num = (v: unknown): number => Number(v ?? 0);

/** clamp 0-1 confidence bucket derived from a cluster's share of the week. */
function confidenceFromShare(sharePct: number): "low" | "med" | "high" {
  if (sharePct >= 35) return "high";
  if (sharePct >= 15) return "med";
  return "low";
}

/**
 * Fingerprint for dedup (§P5-CONVO): project + normalized topic. The insights
 * fingerprint index is (project_id, fingerprint); embedding the projectId here
 * too matches the contract wording literally and keeps the key globally unique.
 */
export function convoFingerprint(projectId: string, topic: string): string {
  const slug =
    topic
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "untopiced";
  return `faq:${projectId}:${slug}`;
}

interface WindowRow {
  this_from: string;
  this_to: string;
  from_day: string;
  to_day: string;
  last_from: string;
  last_to: string;
  generated_at: string;
}

interface ConvRow {
  event_id: string;
  occurred_at: string;
  channel: string | null;
  intent: string | null;
  resolution: string | null;
  sentiment: string | null;
  summary: string | null;
  topics: unknown;
}

interface CountRow {
  this_week: number;
  last_week: number;
  resolved: number;
  escalated: number;
  abandoned: number;
  positive: number;
  neutral: number;
  negative: number;
}

interface TopicCountRow {
  topic: string;
  count: number;
}

/**
 * Build the deterministic conversation pack. All window boundaries are derived
 * inside Postgres from the London day using the shared rollup bucket pattern
 * (`… at time zone 'Europe/London'`), so every boundary is DST-correct. Pure SQL
 * over the `events` spine — no raw-event dumps beyond the capped, structured
 * conversation list the model needs to cluster.
 */
export async function buildConvoClusterPack(
  db: Db,
  orgId: string,
  projectId: string,
  forDayLondon?: string,
): Promise<{ pack: ConvoClusterPack; projectFound: boolean }> {
  const client = db.$client;

  const projRows = (await client`
    select name from projects where id = ${projectId}::uuid and org_id = ${orgId}::uuid limit 1
  `) as unknown as { name: string }[];
  const projectFound = projRows.length > 0;
  const projectName = projRows[0]?.name ?? "";

  // ── window boundaries (this week ends on forDay inclusive; last week before) ──
  // day_start is the NAIVE London wall-clock midnight of the last day in the
  // this-week window; every UTC boundary converts a naive-local expression back
  // with `at time zone 'Europe/London'` (the shared DST-safe rollup pattern).
  // WINDOW_DAYS is fixed at 7, so the intervals are literal (postgres-js binds
  // ${} as parameters, which cannot appear inside an interval literal).
  const winRows = (forDayLondon
    ? await client`
        with base as (select ${forDayLondon}::timestamp as day_start)
        select
          to_char(((day_start - interval '6 days') at time zone 'Europe/London') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as this_from,
          to_char(((day_start + interval '1 day') at time zone 'Europe/London') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as this_to,
          to_char(day_start - interval '6 days', 'YYYY-MM-DD') as from_day,
          to_char(day_start, 'YYYY-MM-DD') as to_day,
          to_char(((day_start - interval '13 days') at time zone 'Europe/London') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as last_from,
          to_char(((day_start - interval '6 days') at time zone 'Europe/London') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as last_to,
          to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as generated_at
        from base`
    : await client`
        with base as (select date_trunc('day', now() at time zone 'Europe/London') - interval '1 day' as day_start)
        select
          to_char(((day_start - interval '6 days') at time zone 'Europe/London') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as this_from,
          to_char(((day_start + interval '1 day') at time zone 'Europe/London') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as this_to,
          to_char(day_start - interval '6 days', 'YYYY-MM-DD') as from_day,
          to_char(day_start, 'YYYY-MM-DD') as to_day,
          to_char(((day_start - interval '13 days') at time zone 'Europe/London') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as last_from,
          to_char(((day_start - interval '6 days') at time zone 'Europe/London') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as last_to,
          to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as generated_at
        from base`) as unknown as WindowRow[];
  const w = winRows[0]!;

  // ── this-week + last-week counts, resolution + sentiment mix (full window) ──
  const countRows = (await client`
    select
      count(*) filter (where occurred_at >= ${w.this_from}::timestamptz and occurred_at < ${w.this_to}::timestamptz)::int as this_week,
      count(*) filter (where occurred_at >= ${w.last_from}::timestamptz and occurred_at < ${w.last_to}::timestamptz)::int as last_week,
      count(*) filter (where occurred_at >= ${w.this_from}::timestamptz and occurred_at < ${w.this_to}::timestamptz and data->>'resolution' = 'resolved')::int as resolved,
      count(*) filter (where occurred_at >= ${w.this_from}::timestamptz and occurred_at < ${w.this_to}::timestamptz and data->>'resolution' = 'escalated')::int as escalated,
      count(*) filter (where occurred_at >= ${w.this_from}::timestamptz and occurred_at < ${w.this_to}::timestamptz and data->>'resolution' = 'abandoned')::int as abandoned,
      count(*) filter (where occurred_at >= ${w.this_from}::timestamptz and occurred_at < ${w.this_to}::timestamptz and data->>'sentiment' = 'positive')::int as positive,
      count(*) filter (where occurred_at >= ${w.this_from}::timestamptz and occurred_at < ${w.this_to}::timestamptz and data->>'sentiment' = 'neutral')::int as neutral,
      count(*) filter (where occurred_at >= ${w.this_from}::timestamptz and occurred_at < ${w.this_to}::timestamptz and data->>'sentiment' = 'negative')::int as negative
    from events
    where org_id = ${orgId}::uuid and project_id = ${projectId}::uuid and type = 'llm.conversation'
  `) as unknown as CountRow[];
  const c = countRows[0]!;

  // ── the conversations themselves (this week, capped, newest first) ──────────
  const convRows = (await client`
    select
      id::text as event_id,
      to_char(occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as occurred_at,
      data->>'channel' as channel,
      data->>'intent' as intent,
      data->>'resolution' as resolution,
      data->>'sentiment' as sentiment,
      data->>'summary' as summary,
      data->'topics' as topics
    from events
    where org_id = ${orgId}::uuid and project_id = ${projectId}::uuid and type = 'llm.conversation'
      and occurred_at >= ${w.this_from}::timestamptz and occurred_at < ${w.this_to}::timestamptz
    order by occurred_at desc
    limit ${MAX_CONVERSATIONS}
  `) as unknown as ConvRow[];

  const conversations: ConvoConversation[] = convRows.map((r) => ({
    eventId: r.event_id,
    occurredAt: r.occurred_at,
    channel: r.channel,
    intent: r.intent,
    topics: Array.isArray(r.topics)
      ? (r.topics as unknown[]).filter((t): t is string => typeof t === "string")
      : [],
    resolution: r.resolution,
    sentiment: r.sentiment,
    summary: r.summary,
  }));

  // ── last-week per-topic counts (for trend) ──────────────────────────────────
  const topicRows = (await client`
    select topic, count(*)::int as count
    from (
      select jsonb_array_elements_text(data->'topics') as topic
      from events
      where org_id = ${orgId}::uuid and project_id = ${projectId}::uuid and type = 'llm.conversation'
        and occurred_at >= ${w.last_from}::timestamptz and occurred_at < ${w.last_to}::timestamptz
        and jsonb_typeof(data->'topics') = 'array'
    ) t
    group by topic
    order by count desc, topic
  `) as unknown as TopicCountRow[];

  const pack: ConvoClusterPack = {
    projectId,
    projectName,
    window: { fromDay: w.from_day, toDay: w.to_day, days: WINDOW_DAYS },
    totals: { thisWeek: num(c.this_week), lastWeek: num(c.last_week) },
    resolution: {
      resolved: num(c.resolved),
      escalated: num(c.escalated),
      abandoned: num(c.abandoned),
    },
    sentiment: {
      positive: num(c.positive),
      neutral: num(c.neutral),
      negative: num(c.negative),
    },
    conversations,
    lastWeekTopicCounts: topicRows.map((r) => ({
      topic: r.topic,
      count: num(r.count),
    })),
    generatedAt: w.generated_at,
  };

  return { pack, projectFound };
}

// ── run + persist ─────────────────────────────────────────────────────────────

interface ExistingFingerprintRow {
  id: string;
  fingerprint: string | null;
  status: string;
}

export async function runConvoClustering(
  db: Db,
  opts: RunConvoClusteringOptions,
): Promise<RunConvoClusteringResult> {
  const { pack, projectFound } = await buildConvoClusterPack(
    db,
    opts.orgId,
    opts.projectId,
    opts.forDayLondon,
  );

  // Unknown project or an empty week → nothing to cluster; skip the model call.
  if (!projectFound || pack.conversations.length === 0) {
    return {
      ok: true,
      runId: null,
      clustersWritten: 0,
      scoutCandidates: 0,
      tokensIn: 0,
      tokensOut: 0,
      window: { fromDay: pack.window.fromDay, toDay: pack.window.toDay },
    };
  }

  const run = await runAgent<ConvoClusterOutput>({
    // os_agent_kind has no conversation-cluster value; log under the Scout-aligned
    // kind (see file header note). Non-critical: subject to the budget halt.
    agent: "opportunity_scout",
    orgId: opts.orgId,
    projectId: opts.projectId,
    clientId: null,
    systemPrompt: convoClusterSystemPrompt(),
    userContent: JSON.stringify(pack),
    schema: convoClusterOutputSchema,
    dataSnapshot: pack as unknown as Record<string, unknown>,
    maxTokens: 3000,
  });

  if (!run.ok) return { ok: false, error: run.error };

  // Only cite eventIds the model was actually given (drop any hallucinated ids).
  const validIds = new Set(pack.conversations.map((cv) => cv.eventId));

  const written = await writeClusters(
    db,
    opts.orgId,
    opts.projectId,
    run.output.clusters,
    validIds,
    pack.window,
  );

  return {
    ok: true,
    runId: run.runId,
    clustersWritten: written.clustersWritten,
    scoutCandidates: written.scoutCandidates,
    tokensIn: run.tokensIn,
    tokensOut: run.tokensOut,
    window: { fromDay: pack.window.fromDay, toDay: pack.window.toDay },
  };
}

/**
 * Persist clusters as faq_cluster insights, idempotently. Existing rows for the
 * project (matched by fingerprint) are UPDATED in place; new fingerprints are
 * INSERTed. A row's review status is left untouched on update so a re-run never
 * resurrects an insight the owner has dismissed.
 *
 * Label drift retirement (§P5-CONVO idempotency): the clustering prompt is
 * non-deterministic, so a topic can re-slug across runs ("Booking" → "Bookings"
 * → a new fingerprint). Without cleanup the prior run's row is orphaned and the
 * Conversations tab (latest-state, not window-bound) renders it forever with a
 * frozen count/share. After writing this run's clusters we therefore retire the
 * still-untouched, agent-written rows whose fingerprint did NOT appear in this
 * run — but only status='new' rows, so owner-engaged insights (reviewed/
 * actioned/converted) and dismissed ones (which the monthly strategist reads to
 * learn what the owner ignores, §9.3) are preserved.
 */
async function writeClusters(
  db: Db,
  orgId: string,
  projectId: string,
  clusters: ConvoClusterOutput["clusters"],
  validIds: Set<string>,
  window: { fromDay: string; toDay: string },
): Promise<{ clustersWritten: number; scoutCandidates: number }> {
  const client = db.$client;

  const existingRows = (await client`
    select id::text as id, fingerprint, status::text as status
    from insights
    where org_id = ${orgId}::uuid and project_id = ${projectId}::uuid and kind = 'faq_cluster'
  `) as unknown as ExistingFingerprintRow[];
  const byFingerprint = new Map<string, string>();
  for (const r of existingRows) {
    if (r.fingerprint) byFingerprint.set(r.fingerprint, r.id);
  }

  // De-duplicate clusters that collapse to the same fingerprint within one run
  // (e.g. the model emits 'Booking' and 'Bookings') — keep the first, largest.
  const seen = new Set<string>();
  let clustersWritten = 0;
  let scoutCandidates = 0;

  for (const cl of clusters) {
    const fingerprint = convoFingerprint(projectId, cl.topic);
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);

    const exampleIds = cl.example_event_ids.filter((id) => validIds.has(id));
    const sharePct = Math.round(cl.share_pct * 10) / 10;
    const isScout = cl.is_unautomated_repetition === true;
    if (isScout) scoutCandidates += 1;

    const evidence: Record<string, unknown> = {
      event_ids: exampleIds,
      count: Math.round(cl.count),
      share_pct: sharePct,
      trend: cl.trend_vs_last_week,
      window: { from: window.fromDay, to: window.toDay },
    };
    if (isScout) evidence.scout_candidate = true;

    const confidence = confidenceFromShare(sharePct);
    const existingId = byFingerprint.get(fingerprint);

    if (existingId) {
      await client`
        update insights set
          title = ${cl.topic},
          body_md = ${cl.note},
          evidence = ${JSON.stringify(evidence)}::jsonb,
          confidence = ${confidence}::insight_confidence
        where id = ${existingId}::uuid
      `;
    } else {
      await db.insert(insights).values({
        orgId,
        projectId,
        kind: "faq_cluster",
        title: cl.topic,
        bodyMd: cl.note,
        evidence,
        fingerprint,
        confidence,
        status: "new",
        createdBy: "agent",
      });
    }
    clustersWritten += 1;
  }

  // Retire orphaned, still-untouched rows whose label drifted out of this run.
  const orphanIds = existingRows
    .filter(
      (r) => r.fingerprint !== null && !seen.has(r.fingerprint) && r.status === "new",
    )
    .map((r) => r.id);
  if (orphanIds.length > 0) {
    await client`
      delete from insights
      where org_id = ${orgId}::uuid and project_id = ${projectId}::uuid
        and kind = 'faq_cluster' and status = 'new'
        and id::text = any(${orphanIds})
    `;
  }

  return { clustersWritten, scoutCandidates };
}

// ── org fan-out (used by the CLI + the daily job) ─────────────────────────────

export interface RunConvoClusteringForOrgResult {
  projects: {
    projectId: string;
    projectName: string;
    result: RunConvoClusteringResult;
  }[];
}

/**
 * Cluster conversations for every non-terminal project in an org. Errors on one
 * project (e.g. a budget halt or a missing API key) do not stop the rest — each
 * project's typed result is returned for the caller to log.
 */
export async function runConvoClusteringForOrg(
  db: Db,
  orgId: string,
  forDayLondon?: string,
): Promise<RunConvoClusteringForOrgResult> {
  const rows = (await db.$client`
    select id::text as id, name
    from projects
    where org_id = ${orgId}::uuid and status not in ('completed', 'cancelled')
    order by name
  `) as unknown as { id: string; name: string }[];

  const projects: RunConvoClusteringForOrgResult["projects"] = [];
  for (const p of rows) {
    const result = await runConvoClustering(db, {
      orgId,
      projectId: p.id,
      forDayLondon,
    });
    projects.push({ projectId: p.id, projectName: p.name, result });
  }
  return { projects };
}

/** Convenience for the CLI / cron: run against the default pooled db. */
export function runConvoClusteringForOrgDefault(
  orgId: string,
  forDayLondon?: string,
): Promise<RunConvoClusteringForOrgResult> {
  return runConvoClusteringForOrg(defaultDb, orgId, forDayLondon);
}
