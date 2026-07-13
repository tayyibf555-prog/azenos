import { db, industries, knowledgeArticles } from "@azen/db";
import { and, desc, eq, sql } from "drizzle-orm";

/**
 * Learn screen data (docs/phase6/CONTRACTS.md §P6-LEARN). Read-only loaders over
 * knowledge_articles + industries, org-scoped. The Industry Learning agent writes
 * the articles (industry primer / weekly digest / pattern / playbook); this is the
 * surface that lists them per industry. Semantic search lives separately in
 * lib/server/knowledge.ts (Voyage + pgvector).
 *
 * postgres-js/bigint values are coerced with Number(); dates are ISO strings.
 */

export interface IndustrySummary {
  id: string;
  slug: string;
  name: string;
  articleCount: number;
  /** article kinds present, for a quick "what's covered" chip row. */
  kinds: string[];
  lastUpdated: string | null;
}

export interface KnowledgeArticleItem {
  id: string;
  industryId: string;
  title: string;
  bodyMd: string;
  kind: string;
  sourceNotes: string[];
  createdAt: string;
}

const num = (v: unknown): number => Number(v ?? 0);

/**
 * Every industry that has at least one knowledge article, with its article count,
 * the kinds present, and when it was last refreshed. Industries with no articles
 * are omitted (nothing to show yet).
 */
export async function getIndustriesWithArticles(
  orgId: string,
): Promise<IndustrySummary[]> {
  const rows = await db
    .select({
      id: industries.id,
      slug: industries.slug,
      name: industries.name,
      articleCount: sql<string>`count(${knowledgeArticles.id})`,
      kinds: sql<string[]>`coalesce(array_agg(distinct ${knowledgeArticles.kind}::text) filter (where ${knowledgeArticles.id} is not null), '{}')`,
      lastUpdated: sql<string | null>`max(${knowledgeArticles.createdAt})`,
    })
    .from(industries)
    .innerJoin(
      knowledgeArticles,
      and(
        eq(knowledgeArticles.industryId, industries.id),
        eq(knowledgeArticles.orgId, orgId),
      ),
    )
    .where(eq(industries.orgId, orgId))
    .groupBy(industries.id, industries.slug, industries.name)
    .orderBy(industries.name);

  return rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    name: r.name,
    articleCount: num(r.articleCount),
    kinds: Array.isArray(r.kinds) ? r.kinds : [],
    lastUpdated: r.lastUpdated ? new Date(r.lastUpdated).toISOString() : null,
  }));
}

function sourceNotesFrom(sources: Record<string, unknown> | null): string[] {
  const notes = sources?.["notes"];
  if (!Array.isArray(notes)) return [];
  return notes.filter((n): n is string => typeof n === "string");
}

/** All knowledge articles for one industry, newest first. */
export async function getIndustryArticles(
  orgId: string,
  industryId: string,
): Promise<KnowledgeArticleItem[]> {
  const rows = await db
    .select({
      id: knowledgeArticles.id,
      industryId: knowledgeArticles.industryId,
      title: knowledgeArticles.title,
      bodyMd: knowledgeArticles.bodyMd,
      kind: knowledgeArticles.kind,
      sources: knowledgeArticles.sources,
      createdAt: knowledgeArticles.createdAt,
    })
    .from(knowledgeArticles)
    .where(
      and(
        eq(knowledgeArticles.orgId, orgId),
        eq(knowledgeArticles.industryId, industryId),
      ),
    )
    .orderBy(desc(knowledgeArticles.createdAt), desc(knowledgeArticles.id));

  return rows.map((r) => ({
    id: r.id,
    industryId: r.industryId,
    title: r.title,
    bodyMd: r.bodyMd,
    kind: r.kind,
    sourceNotes: sourceNotesFrom(r.sources),
    createdAt: r.createdAt.toISOString(),
  }));
}
