import { NextResponse } from "next/server";
import { withErrorHandling } from "../../../../lib/server/http";
import { getIndustriesWithArticles } from "../../../../lib/server/learn";
import { requireOrgId } from "../../../../lib/server/org";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/learn/industries — every industry with at least one knowledge article,
 * each with its article count, the kinds present, and when it was last refreshed.
 */
export const GET = withErrorHandling(async () => {
  const orgId = await requireOrgId();
  const industries = await getIndustriesWithArticles(orgId);
  return NextResponse.json({ industries });
});
