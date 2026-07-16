import { NextResponse } from "next/server";
import { jsonError, withErrorHandling } from "../../../../../../lib/server/http";
import { requireOrgId } from "../../../../../../lib/server/org";
import {
  projectExists,
  updateFeedbackItemStatus,
} from "../../../../../../lib/server/queries";
import {
  feedbackStatusPatchSchema,
  isUuid,
  readJsonBody,
  zodSummary,
} from "../../../../../../lib/server/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ projectId: string; itemId: string }> };

/**
 * Triage board status transition (docs/phase7/PLAN.md §B2): `PATCH { status }`
 * moves a `feedback_items` row through new → seen → planned → done. Org +
 * project scoped — a cross-org or cross-project item id resolves to a plain
 * 404, same as an unknown one.
 */
export const PATCH = withErrorHandling(async (req: Request, { params }: Ctx) => {
  const orgId = await requireOrgId();
  const { projectId, itemId } = await params;
  if (!isUuid(projectId)) return jsonError(404, "project_not_found");
  if (!isUuid(itemId)) return jsonError(404, "feedback_item_not_found");
  if (!(await projectExists(orgId, projectId)))
    return jsonError(404, "project_not_found");

  const parsed = feedbackStatusPatchSchema.safeParse(await readJsonBody(req));
  if (!parsed.success) return jsonError(400, zodSummary(parsed.error));

  const item = await updateFeedbackItemStatus(
    orgId,
    projectId,
    itemId,
    parsed.data.status,
  );
  if (!item) return jsonError(404, "feedback_item_not_found");
  return NextResponse.json({ item });
});
