import { NextResponse } from "next/server";
import { jsonError, withErrorHandling } from "../../../../../lib/server/http";
import { requireOrgId } from "../../../../../lib/server/org";
import {
  createProjectMetric,
  getProjectMetrics,
  projectExists,
  recomputeProjectMetrics,
} from "../../../../../lib/server/queries";
import {
  isUuid,
  metricDefinitionInputSchema,
  readJsonBody,
  zodSummary,
} from "../../../../../lib/server/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ projectId: string }> };

export const GET = withErrorHandling(async (_req: Request, { params }: Ctx) => {
  const orgId = await requireOrgId();
  const { projectId } = await params;
  if (!isUuid(projectId)) return jsonError(404, "project_not_found");
  if (!(await projectExists(orgId, projectId)))
    return jsonError(404, "project_not_found");
  return NextResponse.json(await getProjectMetrics(orgId, projectId));
});

export const POST = withErrorHandling(async (req: Request, { params }: Ctx) => {
  const orgId = await requireOrgId();
  const { projectId } = await params;
  if (!isUuid(projectId)) return jsonError(404, "project_not_found");
  if (!(await projectExists(orgId, projectId)))
    return jsonError(404, "project_not_found");

  const parsed = metricDefinitionInputSchema.safeParse(await readJsonBody(req));
  if (!parsed.success) return jsonError(400, zodSummary(parsed.error));

  const result = await createProjectMetric(orgId, projectId, parsed.data);
  if (!result.ok) {
    if (result.error === "duplicate")
      return jsonError(409, "metric_key_exists");
    return jsonError(400, "invalid_metric_definition");
  }

  // Populate the new metric's rollups over the trailing 30 days. A recompute
  // hiccup must not fail the create — the definition is already committed.
  try {
    await recomputeProjectMetrics(orgId, projectId);
  } catch (err) {
    console.error("[metrics] recompute after create failed:", err);
  }

  return NextResponse.json({ definition: result.definition }, { status: 201 });
});
