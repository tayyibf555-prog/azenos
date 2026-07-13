/**
 * Voyage AI embeddings via PLAIN fetch — no SDK (docs/phase6/CONTRACTS.md
 * §P6-LEARN; owner decision 2026-07-11, spec §12). Shared by the Industry
 * Learning agent (embeds each knowledge article) and apps/web's knowledge
 * retrieval (embeds the query). One helper, one place, so the request shape,
 * model id, and dimension can never drift between write-side and read-side.
 *
 * Graceful degradation is the contract (spec §13): with no VOYAGE_API_KEY — or
 * on ANY provider/network error — embedTexts returns null (never throws). The
 * caller then writes an article with a null embedding, or a search returns [].
 *
 * The dimension is pinned to EMBEDDING_DIMS so it matches the pgvector column
 * (vector(1024)); a mismatch would make the pgvector insert/search fail.
 */

import { EMBEDDING_DIMS, EMBEDDING_MODEL } from "@azen/config";

const VOYAGE_URL = "https://api.voyageai.com/v1/embeddings";
/** Voyage recommends distinguishing stored documents from search queries. */
export type VoyageInputType = "document" | "query";

/** True when VOYAGE_API_KEY is present (retrieval/embedding is available). */
export function voyageConfigured(): boolean {
  return Boolean(process.env.VOYAGE_API_KEY);
}

interface VoyageResponse {
  data?: { embedding: number[]; index: number }[];
}

/**
 * Embed a batch of texts with Voyage (voyage-3.5, 1024-dim). Returns embeddings
 * in the SAME order as `texts`, or null when the key is absent or the call
 * fails — so every caller degrades gracefully. Empty input → null (nothing to
 * embed, no request made).
 */
export async function embedTexts(
  texts: readonly string[],
  inputType?: VoyageInputType,
): Promise<number[][] | null> {
  const key = process.env.VOYAGE_API_KEY;
  if (!key || texts.length === 0) return null;

  try {
    const res = await fetch(VOYAGE_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: texts,
        output_dimension: EMBEDDING_DIMS,
        ...(inputType ? { input_type: inputType } : {}),
      }),
    });
    if (!res.ok) {
      console.error(`[voyage] embeddings HTTP ${res.status}`);
      return null;
    }
    const json = (await res.json()) as VoyageResponse;
    const data = json.data;
    if (!Array.isArray(data) || data.length !== texts.length) {
      console.error("[voyage] unexpected embeddings response shape");
      return null;
    }
    // Order by the returned index so embeddings align with the input texts.
    const ordered: number[][] = new Array(texts.length);
    for (const row of data) {
      if (
        typeof row.index !== "number" ||
        row.index < 0 ||
        row.index >= texts.length ||
        !Array.isArray(row.embedding)
      ) {
        console.error("[voyage] malformed embedding row");
        return null;
      }
      ordered[row.index] = row.embedding;
    }
    for (const e of ordered) if (!Array.isArray(e)) return null;
    return ordered;
  } catch (err) {
    console.error("[voyage] embeddings request failed:", err);
    return null;
  }
}

/**
 * Embed ONE text (a search query). Convenience over embedTexts — returns the
 * single vector or null (missing key / failure).
 */
export async function embedOne(
  text: string,
  inputType?: VoyageInputType,
): Promise<number[] | null> {
  const out = await embedTexts([text], inputType);
  return out ? (out[0] ?? null) : null;
}
