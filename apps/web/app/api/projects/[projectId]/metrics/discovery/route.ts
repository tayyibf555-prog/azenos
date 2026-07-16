import { NextResponse } from "next/server";
import { jsonError, withErrorHandling } from "../../../../../../lib/server/http";
import { requireOrgId } from "../../../../../../lib/server/org";
import { discoverMetrics } from "../../../../../../lib/server/metric-discovery";
import { isUuid } from "../../../../../../lib/server/schemas";
import { projectExists } from "../../../../../../lib/server/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ projectId: string }> };

/**
 * §P9-W0B — read-only metric discovery for the Metrics tab's "Available to
 * add" panel. No write path here: adding a metric still POSTs to the
 * existing /api/projects/[projectId]/metrics endpoint.
 */
export const GET = withErrorHandling(async (_req: Request, { params }: Ctx) => {
  const orgId = await requireOrgId();
  const { projectId } = await params;
  if (!isUuid(projectId)) return jsonError(404, "project_not_found");
  if (!(await projectExists(orgId, projectId)))
    return jsonError(404, "project_not_found");

  return NextResponse.json(await discoverMetrics(orgId, projectId));
});
