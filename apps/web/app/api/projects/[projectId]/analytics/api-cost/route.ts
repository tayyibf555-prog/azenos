import { NextResponse } from "next/server";
import { jsonError, withErrorHandling } from "../../../../../../lib/server/http";
import { requireOrgId } from "../../../../../../lib/server/org";
import { isUuid } from "../../../../../../lib/server/schemas";
import {
  getProjectForAnalytics,
  parseRange,
} from "../../../../../../lib/server/analytics/base";
import { getApiCostData } from "../../../../../../lib/server/analytics/api-cost";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ projectId: string }> };

/**
 * API Cost & Usage (§10, rail #10) — the unified two-stream cost view.
 * READ-ONLY, org+project scoped, London-day windows. Never throws on an empty
 * project (every figure falls back to 0 / [] / null). See
 * lib/server/analytics/api-cost.ts for the merge math.
 */
export const GET = withErrorHandling(async (req: Request, { params }: Ctx) => {
  const orgId = await requireOrgId();
  const { projectId } = await params;
  if (!isUuid(projectId)) return jsonError(404, "project_not_found");

  const r = parseRange(new URL(req.url).searchParams);
  const project = await getProjectForAnalytics(orgId, projectId);
  if (!project) return jsonError(404, "project_not_found");

  const body = await getApiCostData(orgId, projectId, r);
  return NextResponse.json(body);
});
