import { NextResponse } from "next/server";
import { jsonError, withErrorHandling } from "../../../../../lib/server/http";
import { requireOrgId } from "../../../../../lib/server/org";
import { projectExists } from "../../../../../lib/server/queries";
import { isUuid, searchParamsObject, zodSummary } from "../../../../../lib/server/schemas";
import { agentsQuerySchema, getProjectAgents } from "./query";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ projectId: string }> };

export const GET = withErrorHandling(async (req: Request, { params }: Ctx) => {
  const orgId = await requireOrgId();
  const { projectId } = await params;
  if (!isUuid(projectId)) return jsonError(404, "project_not_found");

  const parsed = agentsQuerySchema.safeParse(searchParamsObject(req));
  if (!parsed.success) return jsonError(400, zodSummary(parsed.error));

  if (!(await projectExists(orgId, projectId))) {
    return jsonError(404, "project_not_found");
  }

  const data = await getProjectAgents(orgId, projectId, parsed.data);
  return NextResponse.json(data);
});
