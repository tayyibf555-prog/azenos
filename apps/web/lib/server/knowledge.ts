import { embedOne } from "@azen/agents";
import { db } from "@azen/db";

/**
 * Industry knowledge retrieval (docs/phase6/CONTRACTS.md §P6-LEARN). The Industry
 * Learning agent writes knowledge_articles and embeds each with Voyage (voyage-3.5,
 * 1024-dim); this is the READ side: embed the caller's query with Voyage, then rank
 * articles by pgvector cosine distance (`embedding <=> $query`).
 *
 * Graceful degradation is the contract (spec §13): with no VOYAGE_API_KEY the query
 * can't be embedded → return []. With a key but no embedded articles yet → the
 * `embedding is not null` filter yields [] too. Either way the caller (the Learn
 * search box, or Ask Azen's search_knowledge tool) shows "no entries yet" rather
 * than crashing.
 */

export interface KnowledgeHit {
  id: string;
  industryId: string;
  industrySlug: string;
  industryName: string;
  title: string;
  bodyMd: string;
  kind: string;
  /**
   * Cosine similarity `1 - (embedding <=> query)`; pgvector's `<=>` distance
   * spans [0,2], so the raw score spans [-1,1]. Only hits at or above
   * SIMILARITY_FLOOR are returned, so a surfaced score is always in
   * [SIMILARITY_FLOOR, 1] — higher is closer.
   */
  score: number;
}

/**
 * Minimum cosine similarity for a hit to count as relevant. Without a floor any
 * non-empty query against a KB with ≥1 embedded article always returns the
 * top-N nearest rows regardless of relevance (and can surface negative-similarity
 * matches), feeding the model unrelated primers as if authoritative. The floor
 * makes an off-topic query degrade to [] — the same "no relevant entry" signal
 * as an empty KB — rather than confidently-wrong context.
 */
const SIMILARITY_FLOOR = 0.3;

interface HitRow {
  id: string;
  industry_id: string;
  industry_slug: string;
  industry_name: string;
  title: string;
  body_md: string;
  kind: string;
  score: number;
}

/** pgvector text literal for a bound query vector: '[0.1,0.2,...]'. */
function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(",")}]`;
}

/**
 * Semantic search over the org's knowledge base. Returns the top `limit` articles
 * by cosine similarity to `queryText`, or [] when embeddings are unavailable
 * (missing VOYAGE_API_KEY, an embedding failure, or no embedded articles yet).
 */
export async function searchKnowledge(
  orgId: string,
  queryText: string,
  limit = 6,
): Promise<KnowledgeHit[]> {
  const trimmed = queryText.trim();
  if (trimmed.length === 0) return [];

  const vec = await embedOne(trimmed, "query");
  if (!vec) return []; // no key or embedding failed → degrade gracefully

  const literal = toVectorLiteral(vec);
  const cap = Math.min(Math.max(1, Math.trunc(limit)), 20);

  const rows = (await db.$client`
    select ka.id::text as id, ka.industry_id::text as industry_id,
      i.slug as industry_slug, i.name as industry_name,
      ka.title, ka.body_md, ka.kind::text as kind,
      (1 - (ka.embedding <=> ${literal}::vector))::float8 as score
    from knowledge_articles ka
    join industries i on i.id = ka.industry_id
    where ka.org_id = ${orgId}::uuid and ka.embedding is not null
      and (1 - (ka.embedding <=> ${literal}::vector)) >= ${SIMILARITY_FLOOR}
    order by ka.embedding <=> ${literal}::vector
    limit ${cap}
  `) as unknown as HitRow[];

  return rows.map((r) => ({
    id: r.id,
    industryId: r.industry_id,
    industrySlug: r.industry_slug,
    industryName: r.industry_name,
    title: r.title,
    bodyMd: r.body_md,
    kind: r.kind,
    score: Number(r.score),
  }));
}
