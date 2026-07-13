/**
 * Industry Learning agent (spec §9.6; docs/phase6/CONTRACTS.md §P6-LEARN).
 *
 * runIndustryLearning builds a DETERMINISTIC, ANONYMISED aggregate pack of ONE
 * industry's operational patterns across every project the agency runs in it —
 * the booking curve (when appointments land), the top FAQ topics, the funnel
 * conversion, and opportunity/behaviour patterns that recur across ≥2 clients —
 * then passes it through the fleet chassis (runAgent, agent 'industry_learner')
 * with a versioned prompt + the LearnOutput zod schema. Each returned article is
 * written to `knowledge_articles` (kinds industry_primer | weekly_digest |
 * pattern | playbook) and EMBEDDED with Voyage (voyage-3.5, 1024-dim) so the
 * knowledge base is retrievable by pgvector. Article dedup reuses the Phase 5
 * convo-cluster fingerprint approach: kind + normalized-title, so a weekly re-run
 * UPDATES the same row (and refreshes its embedding) instead of duplicating.
 *
 * Graceful degradation (spec §13): with no ANTHROPIC_API_KEY the runAgent call
 * returns a typed error and NO articles are written (never a crash). With no
 * VOYAGE_API_KEY the article is still written but its embedding is null (it just
 * won't surface in vector search until re-embedded). An industry with no projects
 * or no signal short-circuits before any model call.
 *
 * @azen/agents has no drizzle-orm dependency, so conditional reads/updates go
 * through the postgres-js client (db.$client); inserts use db.insert(...).values,
 * matching the Scout + Upsell + convo-cluster agents.
 */

import { randomUUID } from "node:crypto";
import { AGENT_MODEL } from "@azen/config";
import { type Db, agentRuns, db as defaultDb, knowledgeArticles } from "@azen/db";
import { z } from "zod";
import { getAnthropic } from "../anthropic";
import { learnSystemPrompt, learnWebResearchSystemPrompt } from "../prompts/learn";
import { type AgentErrorCode, runAgent } from "../runner";
import { embedTexts } from "../voyage";

// ── output contract (docs/phase6/CONTRACTS.md §P6-LEARN exact) ────────────────
export const learnOutputSchema = z.object({
  articles: z.array(
    z.object({
      kind: z.enum(["industry_primer", "weekly_digest", "pattern", "playbook"]),
      title: z.string(),
      body_md: z.string(),
      sources: z.array(z.string()),
    }),
  ),
});

export type LearnOutput = z.infer<typeof learnOutputSchema>;
export type LearnArticle = LearnOutput["articles"][number];
export type KnowledgeKind = LearnArticle["kind"];

// ── deterministic data pack ───────────────────────────────────────────────────

export interface LearnBookingCurvePoint {
  /** ISO day-of-week, 0=Sunday … 6=Saturday (Europe/London). */
  day: number;
  count: number;
}

export interface LearnFaqTopic {
  topic: string;
  count: number;
  /** distinct clients the topic recurs across (>=2 → industry-wide). */
  clientCount: number;
}

export interface LearnConversion {
  leads: number;
  bookings: number;
  completed: number;
  /** bookings ÷ leads, whole percent (0 when no leads). */
  bookingRatePct: number;
}

export interface LearnRepeatedPattern {
  pattern: string;
  clientCount: number;
  note: string;
}

export interface LearnWebCitation {
  url: string;
  title: string;
}

export interface LearnWebResearch {
  /** the model's plain-text industry brief from its web searches. */
  findings: string;
  /** the pages the web_search tool actually returned (deduped by url). */
  citations: LearnWebCitation[];
}

export interface LearnPack {
  industryId: string;
  industrySlug: string;
  industryName: string;
  clientCount: number;
  projectCount: number;
  window: { days: number };
  bookingCurve: { byDayOfWeek: LearnBookingCurvePoint[] };
  topFaqTopics: LearnFaqTopic[];
  conversion: LearnConversion;
  repeatedPatterns: LearnRepeatedPattern[];
  priorArticleTitles: string[];
  /**
   * External industry research from the web_search pre-step (§9.6). null when no
   * ANTHROPIC_API_KEY, when the runner client can't reach web search, or when the
   * search returned nothing — the article writer then works from internal signal
   * only (graceful degradation). Context + citations only, never a figure source.
   */
  webResearch: LearnWebResearch | null;
  generatedAt: string;
}

/** Aggregate window (spec §9.6 — durable patterns need a broad look-back). */
const WINDOW_DAYS = 90;
/** Cap FAQ topics + patterns folded into the pack (prompt-size guard). */
const MAX_TOPICS = 12;
const MAX_PATTERNS = 12;
const LEARN_MAX_TOKENS = 4000;
/** Web-search pre-step budget (spec §9.6: "max ~8 searches"). */
const MAX_WEB_SEARCHES = 8;
const WEB_RESEARCH_MAX_TOKENS = 2000;

const num = (v: unknown): number => Number(v ?? 0);

/** Normalize a title into a stable kebab-case token for the fingerprint. */
export function normalizeTitle(raw: string): string {
  return (
    raw
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "article"
  );
}

/**
 * Article fingerprint for dedup: industry + kind + normalized-title. Stored in
 * knowledge_articles.sources.fingerprint (there is no dedicated column) so a
 * weekly re-run collapses onto the same row (the convo-cluster scheme reused).
 */
export function learnFingerprint(
  industryId: string,
  kind: string,
  title: string,
): string {
  return `learn:${industryId}:${kind}:${normalizeTitle(title)}`;
}

export interface RunIndustryLearningOptions {
  orgId: string;
  industryId: string;
}

export type RunIndustryLearningResult =
  | {
      ok: true;
      /** null when the pack was empty and no model call was made. */
      runId: string | null;
      articlesWritten: number;
      /** how many articles received a Voyage embedding (0 when no key). */
      articlesEmbedded: number;
      tokensIn: number;
      tokensOut: number;
    }
  | { ok: false; error: AgentErrorCode };

// ── deterministic pack builder ────────────────────────────────────────────────

interface IndustryRow {
  slug: string;
  name: string;
  client_count: number;
  project_count: number;
}

interface CurveRow {
  dow: number;
  count: number;
}

interface TopicRow {
  topic: string;
  count: number;
  client_count: number;
}

interface FunnelRow {
  leads: number;
  bookings: number;
  completed: number;
}

interface PatternRow {
  pattern: string;
  client_count: number;
  note: string | null;
}

interface TitleRow {
  title: string;
}

/**
 * Build the deterministic Industry-Learning pack. Pure SQL over the events +
 * insights spines, joined through projects → clients filtered by industry, so
 * every figure is an ANONYMISED aggregate (counts only — no client identity
 * reaches the model). Returns industryFound=false for an unknown/foreign
 * industry so the caller can short-circuit.
 */
export async function buildLearnPack(
  db: Db,
  orgId: string,
  industryId: string,
): Promise<{ pack: LearnPack; industryFound: boolean }> {
  const client = db.$client;

  const indRows = (await client`
    select i.slug as slug, i.name as name,
      count(distinct c.id)::int as client_count,
      count(distinct p.id)::int as project_count
    from industries i
    left join clients c on c.industry_id = i.id and c.org_id = ${orgId}::uuid
    left join projects p on p.client_id = c.id and p.org_id = ${orgId}::uuid
    where i.id = ${industryId}::uuid and i.org_id = ${orgId}::uuid
    group by i.slug, i.name
    limit 1
  `) as unknown as IndustryRow[];
  const industryFound = indRows.length > 0;
  const ind = indRows[0];

  // ── booking curve: appointments by London day-of-week ────────────────────────
  const curveRows = (await client`
    select extract(dow from (e.occurred_at at time zone 'Europe/London'))::int as dow,
      count(*)::int as count
    from events e
    join projects p on p.id = e.project_id
    join clients c on c.id = p.client_id
    where e.org_id = ${orgId}::uuid and c.industry_id = ${industryId}::uuid
      and e.type like 'booking.%'
      and e.occurred_at >= now() - make_interval(days => ${WINDOW_DAYS})
    group by 1
    order by 1
  `) as unknown as CurveRow[];
  const byDayOfWeek: LearnBookingCurvePoint[] = curveRows.map((r) => ({
    day: num(r.dow),
    count: num(r.count),
  }));

  // ── top FAQ topics: faq_cluster insights grouped by title, across clients ────
  const topicRows = (await client`
    select i.title as topic,
      count(*)::int as count,
      count(distinct c.id)::int as client_count
    from insights i
    join projects p on p.id = i.project_id
    join clients c on c.id = p.client_id
    where i.org_id = ${orgId}::uuid and c.industry_id = ${industryId}::uuid
      and i.kind = 'faq_cluster' and i.status <> 'dismissed'
    group by i.title
    order by count desc, client_count desc
    limit ${MAX_TOPICS}
  `) as unknown as TopicRow[];
  const topFaqTopics: LearnFaqTopic[] = topicRows.map((r) => ({
    topic: r.topic,
    count: num(r.count),
    clientCount: num(r.client_count),
  }));

  // ── conversion funnel: leads → bookings → completed ──────────────────────────
  const funnelRows = (await client`
    select
      count(*) filter (where e.type like 'lead.%' or e.type = 'form.submitted')::int as leads,
      count(*) filter (where e.type like 'booking.%' and e.type <> 'booking.completed')::int as bookings,
      count(*) filter (where e.type = 'booking.completed')::int as completed
    from events e
    join projects p on p.id = e.project_id
    join clients c on c.id = p.client_id
    where e.org_id = ${orgId}::uuid and c.industry_id = ${industryId}::uuid
      and e.occurred_at >= now() - make_interval(days => ${WINDOW_DAYS})
  `) as unknown as FunnelRow[];
  const f = funnelRows[0] ?? { leads: 0, bookings: 0, completed: 0 };
  const leads = num(f.leads);
  const bookings = num(f.bookings);
  const conversion: LearnConversion = {
    leads,
    bookings,
    completed: num(f.completed),
    bookingRatePct: leads > 0 ? Math.round((bookings / leads) * 100) : 0,
  };

  // ── repeated patterns: automation_opportunity insights across ≥2 clients ─────
  const patternRows = (await client`
    select i.title as pattern,
      count(distinct c.id)::int as client_count,
      (array_agg(i.body_md order by i.created_at desc))[1] as note
    from insights i
    join projects p on p.id = i.project_id
    join clients c on c.id = p.client_id
    where i.org_id = ${orgId}::uuid and c.industry_id = ${industryId}::uuid
      and i.kind in ('automation_opportunity', 'upsell')
      and i.status not in ('dismissed')
    group by i.title
    having count(distinct c.id) >= 2
    order by client_count desc, count(*) desc
    limit ${MAX_PATTERNS}
  `) as unknown as PatternRow[];
  const repeatedPatterns: LearnRepeatedPattern[] = patternRows.map((r) => ({
    pattern: r.pattern,
    clientCount: num(r.client_count),
    note: r.note ?? "",
  }));

  // ── prior article titles (avoid duplicating the KB) ──────────────────────────
  const titleRows = (await client`
    select title from knowledge_articles
    where org_id = ${orgId}::uuid and industry_id = ${industryId}::uuid
    order by created_at desc
    limit 50
  `) as unknown as TitleRow[];

  const genRows = (await client`
    select to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as iso
  `) as unknown as { iso: string }[];

  const pack: LearnPack = {
    industryId,
    industrySlug: ind?.slug ?? "",
    industryName: ind?.name ?? "",
    clientCount: num(ind?.client_count),
    projectCount: num(ind?.project_count),
    window: { days: WINDOW_DAYS },
    bookingCurve: { byDayOfWeek },
    topFaqTopics,
    conversion,
    repeatedPatterns,
    priorArticleTitles: titleRows.map((r) => r.title),
    webResearch: null,
    generatedAt: genRows[0]!.iso,
  };

  return { pack, industryFound };
}

/** True when the pack carries at least one signal worth asking the model about. */
function packHasSignal(pack: LearnPack): boolean {
  return (
    pack.projectCount > 0 &&
    (pack.bookingCurve.byDayOfWeek.length > 0 ||
      pack.topFaqTopics.length > 0 ||
      pack.conversion.leads > 0 ||
      pack.conversion.bookings > 0 ||
      pack.repeatedPatterns.length > 0)
  );
}

// ── web-search research pre-step (§9.6) ───────────────────────────────────────

/** The slices of the create() response the researcher step reads (no `any`). */
interface WebResearchCitation {
  url?: string;
  title?: string;
}
interface WebResearchBlock {
  type: string;
  text?: string;
  citations?: WebResearchCitation[] | null;
}
interface WebResearchResponse {
  content?: WebResearchBlock[];
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** Compact anonymised summary of the pack for the researcher's user turn. */
function buildResearchQuery(pack: LearnPack): string {
  return JSON.stringify({
    industry: pack.industryName || pack.industrySlug,
    windowDays: pack.window.days,
    clientCount: pack.clientCount,
    projectCount: pack.projectCount,
    conversion: pack.conversion,
    topFaqTopics: pack.topFaqTopics.slice(0, 6).map((t) => t.topic),
    repeatedPatterns: pack.repeatedPatterns.slice(0, 6).map((p) => p.pattern),
  });
}

/**
 * Research the wider industry with Anthropic's native web_search tool — one
 * scoped direct client call (the server runs the search loop, up to ~8 searches),
 * per CONTRACTS.md §P6-LEARN. Returns the model's brief plus the URLs it actually
 * cited, or null on ANY failure: no ANTHROPIC_API_KEY, a client that can't reach
 * web search (e.g. the mocked test client whose messages has only `parse`), a
 * provider error, or an empty result. The article writer then works from internal
 * signal alone (graceful degradation, §13). Logs a succeeded agent_runs row on the
 * happy path; these tokens are kept OUT of the article-writing run's totals.
 */
async function researchIndustryWeb(
  db: Db,
  orgId: string,
  pack: LearnPack,
): Promise<LearnWebResearch | null> {
  const startedAt = new Date();
  try {
    const client = getAnthropic();
    const raw = (await client.messages.create({
      model: AGENT_MODEL,
      max_tokens: WEB_RESEARCH_MAX_TOKENS,
      system: learnWebResearchSystemPrompt(),
      messages: [{ role: "user", content: buildResearchQuery(pack) }],
      tools: [
        { type: "web_search_20260209", name: "web_search", max_uses: MAX_WEB_SEARCHES },
      ],
    })) as unknown as WebResearchResponse;

    let findings = "";
    const citations: LearnWebCitation[] = [];
    const seen = new Set<string>();
    for (const block of raw.content ?? []) {
      if (block.type !== "text" || typeof block.text !== "string") continue;
      findings += block.text;
      for (const c of block.citations ?? []) {
        if (c.url && !seen.has(c.url)) {
          seen.add(c.url);
          citations.push({ url: c.url, title: c.title ?? c.url });
        }
      }
    }

    await logWebResearchRun(
      db,
      orgId,
      startedAt,
      num(raw.usage?.input_tokens),
      num(raw.usage?.output_tokens),
    );

    findings = findings.trim();
    if (findings.length === 0 && citations.length === 0) return null;
    return { findings, citations };
  } catch (err) {
    console.error("[learn] web research skipped (using internal signal only):", err);
    return null;
  }
}

/** Best-effort agent_runs audit row for the web-search pre-step (§P6-LEARN). */
async function logWebResearchRun(
  db: Db,
  orgId: string,
  startedAt: Date,
  tokensIn: number,
  tokensOut: number,
): Promise<void> {
  const finishedAt = new Date();
  try {
    await db.insert(agentRuns).values({
      id: randomUUID(),
      orgId,
      agent: "industry_learner",
      projectId: null,
      clientId: null,
      startedAt,
      finishedAt,
      status: "succeeded",
      model: AGENT_MODEL,
      tokensIn,
      tokensOut,
      // Same v1 cost model as the runner (USD-cents ≈ pence).
      costEstimatePence: Math.round((tokensIn * 0.03 + tokensOut * 0.15) / 1000),
      error: null,
      outputRefs: {
        agent: "industry_learner",
        phase: "web_search",
        durationMs: finishedAt.getTime() - startedAt.getTime(),
      },
    });
  } catch (err) {
    console.error("[learn] web research agent_runs log failed:", err);
  }
}

// ── run + persist ─────────────────────────────────────────────────────────────

export async function runIndustryLearning(
  db: Db,
  opts: RunIndustryLearningOptions,
): Promise<RunIndustryLearningResult> {
  const { pack, industryFound } = await buildLearnPack(
    db,
    opts.orgId,
    opts.industryId,
  );

  // Unknown industry or a completely quiet pack → nothing to learn; skip the call.
  if (!industryFound || !packHasSignal(pack)) {
    return {
      ok: true,
      runId: null,
      articlesWritten: 0,
      articlesEmbedded: 0,
      tokensIn: 0,
      tokensOut: 0,
    };
  }

  // Contract-mandated pre-step (§P6-LEARN): research the wider industry with the
  // native web_search tool via a scoped direct client call, logged to agent_runs.
  // Degrades to null (internal signal only) with no key / no web-search support.
  pack.webResearch = await researchIndustryWeb(db, opts.orgId, pack);

  const run = await runAgent<LearnOutput>({
    agent: "industry_learner",
    orgId: opts.orgId,
    projectId: null,
    clientId: null,
    systemPrompt: learnSystemPrompt(),
    userContent: JSON.stringify(pack),
    schema: learnOutputSchema,
    dataSnapshot: pack as unknown as Record<string, unknown>,
    maxTokens: LEARN_MAX_TOKENS,
  });

  if (!run.ok) return { ok: false, error: run.error };

  const { articlesWritten, articlesEmbedded } = await writeArticles(
    db,
    opts.orgId,
    pack,
    run.output.articles,
  );

  return {
    ok: true,
    runId: run.runId,
    articlesWritten,
    articlesEmbedded,
    tokensIn: run.tokensIn,
    tokensOut: run.tokensOut,
  };
}

interface ExistingArticleRow {
  id: string;
  fingerprint: string | null;
}

/**
 * Persist articles as knowledge_articles, idempotently. Each article is embedded
 * with Voyage (voyage-3.5, document input) — one batched call for the whole set;
 * a missing key or failure yields null embeddings (article still written). Rows
 * matched by fingerprint (industry+kind+normalized-title, stored in sources) are
 * UPDATED in place (and re-embedded); new fingerprints are INSERTed.
 */
async function writeArticles(
  db: Db,
  orgId: string,
  pack: LearnPack,
  articles: LearnArticle[],
): Promise<{ articlesWritten: number; articlesEmbedded: number }> {
  if (articles.length === 0) return { articlesWritten: 0, articlesEmbedded: 0 };

  const client = db.$client;

  // Existing rows for this industry, keyed by their stored fingerprint.
  const existingRows = (await client`
    select id::text as id, sources->>'fingerprint' as fingerprint
    from knowledge_articles
    where org_id = ${orgId}::uuid and industry_id = ${pack.industryId}::uuid
  `) as unknown as ExistingArticleRow[];
  const byFingerprint = new Map<string, string>();
  for (const r of existingRows) {
    if (r.fingerprint) byFingerprint.set(r.fingerprint, r.id);
  }

  // Embed the article bodies (title + body for a richer vector) in one batch.
  const embedInputs = articles.map((a) => `${a.title}\n\n${a.body_md}`);
  const embeddings = await embedTexts(embedInputs, "document");

  const seen = new Set<string>();
  let articlesWritten = 0;
  let articlesEmbedded = 0;

  for (let idx = 0; idx < articles.length; idx++) {
    const a = articles[idx]!;
    const fingerprint = learnFingerprint(pack.industryId, a.kind, a.title);
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);

    const embedding = embeddings?.[idx] ?? null;
    if (embedding) articlesEmbedded += 1;

    const sources: Record<string, unknown> = {
      fingerprint,
      notes: a.sources,
      // Web citations gathered by the web_search pre-step (schema comment on
      // knowledge_articles.sources: "event stats + web citations"). Empty array
      // when the search degraded (no key / no result).
      web_citations: pack.webResearch?.citations ?? [],
      pattern_stats: {
        client_count: pack.clientCount,
        project_count: pack.projectCount,
        window_days: pack.window.days,
        booking_rate_pct: pack.conversion.bookingRatePct,
      },
    };

    const existingId = byFingerprint.get(fingerprint);
    if (existingId) {
      // Update in place; embedding is refreshed only when we have a fresh vector
      // (a transient Voyage outage must not wipe a good stored embedding).
      if (embedding) {
        await client`
          update knowledge_articles set
            title = ${a.title}, body_md = ${a.body_md},
            sources = ${JSON.stringify(sources)}::jsonb,
            embedding = ${toVectorLiteral(embedding)}::vector
          where id = ${existingId}::uuid
        `;
      } else {
        await client`
          update knowledge_articles set
            title = ${a.title}, body_md = ${a.body_md},
            sources = ${JSON.stringify(sources)}::jsonb
          where id = ${existingId}::uuid
        `;
      }
    } else {
      await db.insert(knowledgeArticles).values({
        orgId,
        industryId: pack.industryId,
        title: a.title,
        bodyMd: a.body_md,
        sources,
        kind: a.kind,
        embedding,
      });
    }
    articlesWritten += 1;
  }

  return { articlesWritten, articlesEmbedded };
}

/** pgvector text literal for a raw update: '[0.1,0.2,...]'. */
function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(",")}]`;
}

// ── org fan-out (used by the CLI + the weekly job) ────────────────────────────

export interface RunIndustryLearningForOrgResult {
  industries: {
    industryId: string;
    industryName: string;
    result: RunIndustryLearningResult;
  }[];
}

/**
 * Learn every industry in an org that has at least one active project. Errors on
 * one industry (budget halt or a missing API key) do not stop the rest — each
 * industry's typed result is returned for the caller to log.
 */
export async function runIndustryLearningForOrg(
  db: Db,
  orgId: string,
): Promise<RunIndustryLearningForOrgResult> {
  const rows = (await db.$client`
    select distinct i.id::text as id, i.name as name
    from industries i
    join clients c on c.industry_id = i.id and c.org_id = ${orgId}::uuid
    join projects p on p.client_id = c.id and p.org_id = ${orgId}::uuid
    where i.org_id = ${orgId}::uuid and p.status not in ('completed', 'cancelled')
    order by i.name
  `) as unknown as { id: string; name: string }[];

  const industries: RunIndustryLearningForOrgResult["industries"] = [];
  for (const ind of rows) {
    const result = await runIndustryLearning(db, { orgId, industryId: ind.id });
    industries.push({ industryId: ind.id, industryName: ind.name, result });
  }
  return { industries };
}

/** Convenience for the CLI / cron: run against the default pooled db. */
export function runIndustryLearningForOrgDefault(
  orgId: string,
): Promise<RunIndustryLearningForOrgResult> {
  return runIndustryLearningForOrg(defaultDb, orgId);
}
