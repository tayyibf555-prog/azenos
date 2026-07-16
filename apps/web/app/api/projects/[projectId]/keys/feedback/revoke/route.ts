import { NextResponse } from "next/server";
import {
  jsonError,
  withErrorHandling,
} from "../../../../../../../lib/server/http";
import { requireOrgId } from "../../../../../../../lib/server/org";
import {
  projectExists,
  revokeAndReissueFeedbackKey,
} from "../../../../../../../lib/server/queries";
import { isUuid } from "../../../../../../../lib/server/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ projectId: string }> };

// Phase 7 §B: revoke & reissue the PUBLIC feedback-widget key (no secret).
export const POST = withErrorHandling(async (_req: Request, { params }: Ctx) => {
  const orgId = await requireOrgId();
  const { projectId } = await params;
  if (!isUuid(projectId)) return jsonError(404, "project_not_found");
  if (!(await projectExists(orgId, projectId))) {
    return jsonError(404, "project_not_found");
  }
  const reissued = await revokeAndReissueFeedbackKey(orgId, projectId);
  return NextResponse.json(reissued);
});
