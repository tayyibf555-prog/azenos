import { NextResponse } from "next/server";
import { jsonError, withErrorHandling } from "../../../../lib/server/http";
import { requireOrgId } from "../../../../lib/server/org";
import { updateInsightStatus } from "../../../../lib/server/queries";
import {
  insightPatchSchema,
  isUuid,
  readJsonBody,
  zodSummary,
} from "../../../../lib/server/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ insightId: string }> };

export const PATCH = withErrorHandling(async (req: Request, { params }: Ctx) => {
  const orgId = await requireOrgId();
  const { insightId } = await params;
  if (!isUuid(insightId)) return jsonError(404, "insight_not_found");

  const parsed = insightPatchSchema.safeParse(await readJsonBody(req));
  if (!parsed.success) return jsonError(400, zodSummary(parsed.error));

  const insight = await updateInsightStatus(orgId, insightId, parsed.data.status);
  if (!insight) return jsonError(404, "insight_not_found");
  return NextResponse.json({ insight });
});
