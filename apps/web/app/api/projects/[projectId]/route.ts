import { NextResponse } from "next/server";
import { jsonError, withErrorHandling } from "../../../../lib/server/http";
import { requireOrgId } from "../../../../lib/server/org";
import {
  deleteProject,
  getProjectWithClient,
  listEventTypesSeen,
  listProjectKeys,
  updateProject,
} from "../../../../lib/server/queries";
import {
  isUuid,
  projectPatchSchema,
  readJsonBody,
  zodSummary,
} from "../../../../lib/server/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ projectId: string }> };

export const GET = withErrorHandling(async (_req: Request, { params }: Ctx) => {
  const orgId = await requireOrgId();
  const { projectId } = await params;
  if (!isUuid(projectId)) return jsonError(404, "project_not_found");
  const row = await getProjectWithClient(orgId, projectId);
  if (!row) return jsonError(404, "project_not_found");
  const [keys, eventTypesSeen] = await Promise.all([
    listProjectKeys(orgId, projectId),
    listEventTypesSeen(orgId, projectId),
  ]);
  return NextResponse.json({
    project: row.project,
    client: row.client,
    keys,
    eventTypesSeen,
  });
});

export const PATCH = withErrorHandling(async (req: Request, { params }: Ctx) => {
  const orgId = await requireOrgId();
  const { projectId } = await params;
  if (!isUuid(projectId)) return jsonError(404, "project_not_found");
  const parsed = projectPatchSchema.safeParse(await readJsonBody(req));
  if (!parsed.success) return jsonError(400, zodSummary(parsed.error));
  const project = await updateProject(orgId, projectId, parsed.data);
  if (!project) return jsonError(404, "project_not_found");
  return NextResponse.json({ project });
});

export const DELETE = withErrorHandling(
  async (_req: Request, { params }: Ctx) => {
    const orgId = await requireOrgId();
    const { projectId } = await params;
    if (!isUuid(projectId)) return jsonError(404, "project_not_found");
    const deleted = await deleteProject(orgId, projectId);
    if (!deleted) return jsonError(404, "project_not_found");
    return NextResponse.json({ deleted: true, projectId });
  },
);
