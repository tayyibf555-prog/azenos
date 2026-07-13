import { NextResponse } from "next/server";
import {
  jsonError,
  withErrorHandling,
} from "../../../../../../lib/server/http";
import { requireOrgId } from "../../../../../../lib/server/org";
import {
  projectExists,
  revokeAndReissueKey,
} from "../../../../../../lib/server/queries";
import { isUuid } from "../../../../../../lib/server/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ projectId: string }> };

export const POST = withErrorHandling(async (_req: Request, { params }: Ctx) => {
  const orgId = await requireOrgId();
  const { projectId } = await params;
  if (!isUuid(projectId)) return jsonError(404, "project_not_found");
  if (!(await projectExists(orgId, projectId))) {
    return jsonError(404, "project_not_found");
  }
  const reissued = await revokeAndReissueKey(orgId, projectId);
  if (!reissued) return jsonError(404, "no_active_key");
  // Fresh pair → new ingest URL; plaintext secret shown once.
  return NextResponse.json(reissued);
});
