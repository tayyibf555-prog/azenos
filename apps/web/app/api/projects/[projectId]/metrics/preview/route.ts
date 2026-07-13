import { NextResponse } from "next/server";
import { jsonError, withErrorHandling } from "../../../../../../lib/server/http";
import { requireOrgId } from "../../../../../../lib/server/org";
import {
  previewMetric,
  projectExists,
} from "../../../../../../lib/server/queries";
import {
  isUuid,
  metricDefinitionInputSchema,
  readJsonBody,
  zodSummary,
} from "../../../../../../lib/server/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ projectId: string }> };

export const POST = withErrorHandling(async (req: Request, { params }: Ctx) => {
  const orgId = await requireOrgId();
  const { projectId } = await params;
  if (!isUuid(projectId)) return jsonError(404, "project_not_found");
  if (!(await projectExists(orgId, projectId)))
    return jsonError(404, "project_not_found");

  const parsed = metricDefinitionInputSchema.safeParse(await readJsonBody(req));
  if (!parsed.success) return jsonError(400, zodSummary(parsed.error));

  const result = await previewMetric(projectId, parsed.data);
  if (result === null) return jsonError(400, "invalid_metric_definition");
  return NextResponse.json(result);
});
