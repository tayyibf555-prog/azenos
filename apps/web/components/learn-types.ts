/**
 * JSON shapes for the Learn screen client components (P6-LEARN). Mirrors the
 * return types in apps/web/lib/server/learn.ts + lib/server/knowledge.ts. Pure
 * types — no runtime code, safe in client bundles.
 */

export interface IndustrySummary {
  id: string;
  slug: string;
  name: string;
  articleCount: number;
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

export interface KnowledgeHit {
  id: string;
  industryId: string;
  industrySlug: string;
  industryName: string;
  title: string;
  bodyMd: string;
  kind: string;
  score: number;
}

export interface IndustriesResponse {
  industries: IndustrySummary[];
}

export interface ArticlesResponse {
  articles: KnowledgeArticleItem[];
}

export interface SearchResponse {
  results: KnowledgeHit[];
}

export interface ApiErrorShape {
  error: string;
}

/** Article kinds, in display order, with a label + tone colour name. */
export const ARTICLE_KINDS = [
  "industry_primer",
  "weekly_digest",
  "pattern",
  "playbook",
] as const;
export type ArticleKind = (typeof ARTICLE_KINDS)[number];

export const KIND_LABEL: Record<string, string> = {
  industry_primer: "Primer",
  weekly_digest: "Weekly digest",
  pattern: "Pattern",
  playbook: "Playbook",
};
