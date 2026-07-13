import { z } from "zod";
import { searchKnowledge as searchKnowledgeBase } from "../../knowledge";
import { defineTool } from "./types";

/**
 * search_knowledge — real pgvector retrieval over the industry knowledge base
 * (knowledge_articles with Voyage embeddings), wired to searchKnowledge
 * (P6-LEARN). Embeds the query with Voyage and ranks articles by cosine
 * similarity. When retrieval yields nothing — no VOYAGE_API_KEY, no embedded
 * articles yet, or no relevant match — it returns a clear note so the model tells
 * the user the KB has no entries rather than hallucinating an answer.
 */
export const searchKnowledge = defineTool({
  name: "search_knowledge",
  description:
    "Search the industry knowledge base (industry primers, weekly digests, patterns, playbooks) by meaning. Use for questions about how an industry operates, common FAQs, booking curves, conversion norms, or reusable playbooks. Returns the closest-matching articles; if the knowledge base has no entries yet it says so.",
  inputSchema: z.object({ text: z.string().min(1) }).strict(),
  run: async (orgId, input) => {
    const hits = await searchKnowledgeBase(orgId, input.text, 6);
    if (hits.length === 0) {
      return {
        ok: true,
        data: { results: [], note: "no knowledge base entries yet" },
      };
    }
    return {
      ok: true,
      data: {
        results: hits.map((h) => ({
          id: h.id,
          industry: h.industryName,
          kind: h.kind,
          title: h.title,
          bodyMd: h.bodyMd,
          score: Number(h.score.toFixed(4)),
        })),
        count: hits.length,
      },
    };
  },
});
