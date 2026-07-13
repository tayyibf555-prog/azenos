"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Markdown } from "../../components/Markdown";
import { COLORS, tint } from "../../components/ui";
import { formatLondonDate } from "../../lib/format";
import {
  KIND_LABEL,
  type ApiErrorShape,
  type ArticlesResponse,
  type IndustrySummary,
  type KnowledgeArticleItem,
  type KnowledgeHit,
  type SearchResponse,
} from "../../components/learn-types";

const KIND_COLOR: Record<string, string> = {
  industry_primer: COLORS.blue,
  weekly_digest: COLORS.teal,
  pattern: COLORS.violet,
  playbook: COLORS.green,
};

function KindBadge({ kind }: { kind: string }) {
  const tone = KIND_COLOR[kind] ?? COLORS.grey;
  return (
    <span
      className="badge"
      style={{
        color: tone,
        background: tint(tone, 0.12),
        borderColor: tint(tone, 0.28),
      }}
    >
      {KIND_LABEL[kind] ?? kind}
    </span>
  );
}

/**
 * The Learn workspace (P6-LEARN): the industry index on the left, the selected
 * industry's articles (or semantic search results) on the right. Selecting an
 * industry fetches its articles; the search box embeds the query via Voyage +
 * pgvector (GET /api/learn/search) and shows the closest matches across all
 * industries. When VOYAGE_API_KEY is absent, search degrades to an empty result
 * with a clear note — never an error.
 */
export function LearnWorkspace({
  initialIndustries,
  initialIndustryId,
  initialArticles,
}: {
  initialIndustries: IndustrySummary[];
  initialIndustryId: string | null;
  initialArticles: KnowledgeArticleItem[];
}) {
  const [industries] = useState<IndustrySummary[]>(initialIndustries);
  const [activeId, setActiveId] = useState<string | null>(initialIndustryId);
  const [articles, setArticles] = useState<KnowledgeArticleItem[]>(initialArticles);
  const [articlesBusy, setArticlesBusy] = useState(false);

  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [results, setResults] = useState<KnowledgeHit[]>([]);
  const cacheRef = useRef<Map<string, KnowledgeArticleItem[]>>(
    new Map(initialIndustryId ? [[initialIndustryId, initialArticles]] : []),
  );

  const activeIndustry = industries.find((i) => i.id === activeId) ?? null;

  const selectIndustry = useCallback(async (id: string): Promise<void> => {
    setActiveId(id);
    const cached = cacheRef.current.get(id);
    if (cached) {
      setArticles(cached);
      return;
    }
    setArticlesBusy(true);
    try {
      const res = await fetch(`/api/learn/${id}`, { cache: "no-store" });
      const json = (await res.json()) as ArticlesResponse | ApiErrorShape;
      if (res.ok && !("error" in json)) {
        cacheRef.current.set(id, json.articles);
        setArticles(json.articles);
      } else {
        setArticles([]);
      }
    } catch {
      setArticles([]);
    } finally {
      setArticlesBusy(false);
    }
  }, []);

  // Debounced semantic search.
  useEffect(() => {
    const q = query.trim();
    if (q.length === 0) {
      setSearched(false);
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const handle = setTimeout(async () => {
      try {
        const res = await fetch(`/api/learn/search?q=${encodeURIComponent(q)}`, {
          cache: "no-store",
        });
        const json = (await res.json()) as SearchResponse | ApiErrorShape;
        if (res.ok && !("error" in json)) setResults(json.results);
        else setResults([]);
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
        setSearched(true);
      }
    }, 320);
    return () => clearTimeout(handle);
  }, [query]);

  const isSearchMode = query.trim().length > 0;

  if (industries.length === 0) {
    return (
      <div className="card" style={{ padding: "40px 28px" }}>
        <div className="empty">
          <span className="empty-title">No knowledge base entries yet</span>
          <span style={{ fontSize: 13, lineHeight: 1.6 }}>
            The Industry Learning agent distils patterns across your clients into
            reusable articles. Run{" "}
            <code className="kbd">pnpm --filter @azen/agents learn:run</code> (needs
            ANTHROPIC_API_KEY) to populate it, and set VOYAGE_API_KEY to make it
            semantically searchable.
          </span>
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 240px) minmax(0, 1fr)",
        gap: 20,
        alignItems: "start",
      }}
    >
      {/* ── industry index ─────────────────────────────────────────────── */}
      <aside className="card" style={{ padding: 8, position: "sticky", top: 16 }}>
        <div
          style={{
            fontSize: 11,
            fontWeight: 650,
            textTransform: "uppercase",
            letterSpacing: "0.05em",
            color: "var(--text-3)",
            padding: "8px 10px 6px",
          }}
        >
          Industries · {industries.length}
        </div>
        <div style={{ display: "grid", gap: 2 }}>
          {industries.map((ind) => {
            const active = ind.id === activeId && !isSearchMode;
            return (
              <button
                key={ind.id}
                type="button"
                onClick={() => {
                  setQuery("");
                  void selectIndustry(ind.id);
                }}
                style={{
                  textAlign: "left",
                  display: "grid",
                  gap: 3,
                  padding: "9px 10px",
                  borderRadius: 8,
                  cursor: "pointer",
                  background: active ? "var(--card-2)" : "transparent",
                  border: "1px solid",
                  borderColor: active ? "var(--border)" : "transparent",
                }}
              >
                <span
                  style={{
                    fontSize: 13.5,
                    fontWeight: 600,
                    color: active ? "var(--text)" : "var(--text-2)",
                  }}
                >
                  {ind.name}
                </span>
                <span className="faint" style={{ fontSize: 11 }}>
                  {ind.articleCount} article{ind.articleCount === 1 ? "" : "s"}
                  {ind.lastUpdated ? ` · ${formatLondonDate(ind.lastUpdated)}` : ""}
                </span>
              </button>
            );
          })}
        </div>
      </aside>

      {/* ── reader / search ────────────────────────────────────────────── */}
      <section style={{ display: "grid", gap: 16, minWidth: 0 }}>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search the knowledge base — e.g. 'when do dental bookings peak?'"
          aria-label="Search the knowledge base"
          className="input"
          style={{
            width: "100%",
            padding: "10px 14px",
            fontSize: 13.5,
            borderRadius: 10,
            background: "var(--panel)",
            border: "1px solid var(--border)",
            color: "var(--text)",
          }}
        />

        {isSearchMode ? (
          <SearchResults
            query={query}
            searching={searching}
            searched={searched}
            results={results}
          />
        ) : (
          <IndustryArticles
            industry={activeIndustry}
            articles={articles}
            busy={articlesBusy}
          />
        )}
      </section>
    </div>
  );
}

function IndustryArticles({
  industry,
  articles,
  busy,
}: {
  industry: IndustrySummary | null;
  articles: KnowledgeArticleItem[];
  busy: boolean;
}) {
  if (busy) {
    return (
      <div className="card" style={{ padding: 24 }}>
        <span className="muted" style={{ fontSize: 13 }}>
          Loading…
        </span>
      </div>
    );
  }
  if (!industry) {
    return (
      <div className="card" style={{ padding: 24 }}>
        <span className="muted" style={{ fontSize: 13 }}>
          Select an industry to read its knowledge.
        </span>
      </div>
    );
  }
  if (articles.length === 0) {
    return (
      <div className="card" style={{ padding: 24 }}>
        <div className="empty">
          <span className="empty-title">No articles for {industry.name} yet</span>
          <span style={{ fontSize: 13 }}>
            Run the Industry Learning agent to distil this industry's patterns.
          </span>
        </div>
      </div>
    );
  }
  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ fontSize: 15, fontWeight: 650 }}>
        {industry.name}{" "}
        <span className="faint" style={{ fontWeight: 400, fontSize: 13 }}>
          · {articles.length} article{articles.length === 1 ? "" : "s"}
        </span>
      </div>
      {articles.map((a) => (
        <ArticleCard key={a.id} article={a} />
      ))}
    </div>
  );
}

function ArticleCard({ article: a }: { article: KnowledgeArticleItem }) {
  return (
    <article className="card" style={{ padding: "16px 18px", display: "grid", gap: 10 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <h3 style={{ fontSize: 15, fontWeight: 650, lineHeight: 1.3 }}>{a.title}</h3>
        <KindBadge kind={a.kind} />
      </div>
      <Markdown source={a.bodyMd} />
      {a.sourceNotes.length > 0 && (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 6,
            marginTop: 2,
            paddingTop: 10,
            borderTop: "1px solid var(--border)",
          }}
        >
          <span
            className="faint"
            style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em" }}
          >
            Grounded in
          </span>
          {a.sourceNotes.map((note, i) => (
            <span key={i} className="chip" style={{ fontSize: 11 }}>
              {note}
            </span>
          ))}
        </div>
      )}
      <span className="faint" style={{ fontSize: 11 }}>
        {formatLondonDate(a.createdAt)}
      </span>
    </article>
  );
}

function SearchResults({
  query,
  searching,
  searched,
  results,
}: {
  query: string;
  searching: boolean;
  searched: boolean;
  results: KnowledgeHit[];
}) {
  if (searching && !searched) {
    return (
      <div className="card" style={{ padding: 24 }}>
        <span className="muted" style={{ fontSize: 13 }}>
          Searching “{query.trim()}”…
        </span>
      </div>
    );
  }
  if (results.length === 0) {
    return (
      <div className="card" style={{ padding: 24 }}>
        <div className="empty">
          <span className="empty-title">No matches</span>
          <span style={{ fontSize: 13, lineHeight: 1.6 }}>
            Nothing in the knowledge base matched “{query.trim()}”. Semantic search
            needs VOYAGE_API_KEY and embedded articles — without them this returns
            nothing.
          </span>
        </div>
      </div>
    );
  }
  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div className="faint" style={{ fontSize: 12.5 }}>
        {results.length} match{results.length === 1 ? "" : "es"} for “{query.trim()}”
      </div>
      {results.map((h) => (
        <article
          key={h.id}
          className="card"
          style={{ padding: "16px 18px", display: "grid", gap: 10 }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
            }}
          >
            <h3 style={{ fontSize: 15, fontWeight: 650, lineHeight: 1.3 }}>
              {h.title}
            </h3>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flex: "none" }}>
              <span className="faint" style={{ fontSize: 11 }}>
                {h.industryName}
              </span>
              <KindBadge kind={h.kind} />
            </div>
          </div>
          <Markdown source={h.bodyMd} />
          <span className="faint" style={{ fontSize: 11 }}>
            similarity {(h.score * 100).toFixed(0)}%
          </span>
        </article>
      ))}
    </div>
  );
}
