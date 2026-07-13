import { NextResponse } from "next/server";
import { jsonError, withErrorHandling } from "../../../../../../lib/server/http";
import { requireOrgId } from "../../../../../../lib/server/org";
import {
  deleteProjectMetric,
  projectExists,
} from "../../../../../../lib/server/queries";
import { isUuid, metricKeySchema } from "../../../../../../lib/server/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ projectId: string; key: string }> };

export const DELETE = withErrorHandling(
  async (_req: Request, { params }: Ctx) => {
    const orgId = await requireOrgId();
    const { projectId, key } = await params;
    if (!isUuid(projectId)) return jsonError(404, "project_not_found");
    if (!metricKeySchema.safeParse(key).success)
      return jsonError(404, "metric_not_found");
    if (!(await projectExists(orgId, projectId)))
      return jsonError(404, "project_not_found");

    // Globals (project_id NULL) never match the project-scoped delete → 404.
    const deleted = await deleteProjectMetric(orgId, projectId, key);
    if (!deleted) return jsonError(404, "metric_not_found");
    return NextResponse.json({ ok: true });
  },
);
