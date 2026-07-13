import { NextResponse } from "next/server";
import { z } from "zod";
import { jsonError, withErrorHandling } from "../../../../lib/server/http";
import { getIndustryArticles } from "../../../../lib/server/learn";
import { requireOrgId } from "../../../../lib/server/org";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const paramsSchema = z.object({ industryId: z.uuid() });

/**
 * GET /api/learn/[industryId] — every knowledge article for one industry (primer,
 * weekly digests, patterns, playbooks), newest first. A malformed id → 400.
 */
export const GET = withErrorHandling(
  async (_req: Request, ctx: { params: Promise<{ industryId: string }> }) => {
    const orgId = await requireOrgId();
    const parsed = paramsSchema.safeParse(await ctx.params);
    if (!parsed.success) return jsonError(400, "invalid industryId");

    const articles = await getIndustryArticles(orgId, parsed.data.industryId);
    return NextResponse.json({ articles });
  },
);
