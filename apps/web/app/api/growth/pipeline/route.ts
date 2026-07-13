import { NextResponse } from "next/server";
import { withErrorHandling } from "../../../../lib/server/http";
import { requireOrgId } from "../../../../lib/server/org";
import { getGrowthPipeline } from "../../../../lib/server/growth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/growth/pipeline — the opportunity pipeline: automation_opportunity /
 * upsell insights still in play (new | reviewed), each with its client + project
 * and a cited-evidence count, for the Growth screen's review → convert flow.
 */
export const GET = withErrorHandling(async () => {
  const orgId = await requireOrgId();
  const pipeline = await getGrowthPipeline(orgId);
  return NextResponse.json({ pipeline });
});
