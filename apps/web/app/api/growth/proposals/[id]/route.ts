import { NextResponse } from "next/server";
import { jsonError, withErrorHandling } from "../../../../../lib/server/http";
import { requireOrgId } from "../../../../../lib/server/org";
import {
  proposalPatchSchema,
  updateProposalStatus,
} from "../../../../../lib/server/growth";
import { isUuid, readJsonBody, zodSummary } from "../../../../../lib/server/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * PATCH /api/growth/proposals/[id] — move a proposal along the board
 * (draft → ready → sent → won → lost). Org-scoped; unknown id → 404.
 */
export const PATCH = withErrorHandling(async (req: Request, { params }: Ctx) => {
  const orgId = await requireOrgId();
  const { id } = await params;
  if (!isUuid(id)) return jsonError(404, "proposal_not_found");

  const parsed = proposalPatchSchema.safeParse(await readJsonBody(req));
  if (!parsed.success) return jsonError(400, zodSummary(parsed.error));

  const row = await updateProposalStatus(orgId, id, parsed.data.status);
  if (!row) return jsonError(404, "proposal_not_found");
  return NextResponse.json({ proposal: row });
});
