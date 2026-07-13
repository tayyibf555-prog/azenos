import { NextResponse } from "next/server";
import { withErrorHandling } from "../../../../lib/server/http";
import { searchKnowledge } from "../../../../lib/server/knowledge";
import { requireOrgId } from "../../../../lib/server/org";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/learn/search?q=… — semantic search over the knowledge base (Voyage
 * embedding of the query → pgvector cosine ranking). An empty q, a missing
 * VOYAGE_API_KEY, or no embedded articles all return { results: [] } gracefully —
 * never an error — so the Learn search box can say "no matches / not available".
 */
export const GET = withErrorHandling(async (req: Request) => {
  const orgId = await requireOrgId();
  const q = new URL(req.url).searchParams.get("q") ?? "";
  const results = await searchKnowledge(orgId, q, 8);
  return NextResponse.json({ results });
});
