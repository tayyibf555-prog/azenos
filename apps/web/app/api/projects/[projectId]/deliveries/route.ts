import { NextResponse } from "next/server";
import { jsonError, withErrorHandling } from "../../../../../lib/server/http";
import { requireOrgId } from "../../../../../lib/server/org";
import {
  listProjectDeliveries,
  projectExists,
} from "../../../../../lib/server/queries";
import {
  deliveriesQuerySchema,
  isUuid,
  searchParamsObject,
  zodSummary,
} from "../../../../../lib/server/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ projectId: string }> };

export const GET = withErrorHandling(async (req: Request, { params }: Ctx) => {
  const orgId = await requireOrgId();
  const { projectId } = await params;
  if (!isUuid(projectId)) return jsonError(404, "project_not_found");
  if (!(await projectExists(orgId, projectId))) {
    return jsonError(404, "project_not_found");
  }
  const parsed = deliveriesQuerySchema.safeParse(searchParamsObject(req));
  if (!parsed.success) return jsonError(400, zodSummary(parsed.error));
  const deliveries = await listProjectDeliveries(
    orgId,
    projectId,
    parsed.data.limit,
  );
  return NextResponse.json({ deliveries });
});
