import { NextResponse } from "next/server";
import { jsonError, withErrorHandling } from "../../../../../../lib/server/http";
import { requireOrgId } from "../../../../../../lib/server/org";
import { sendProposal } from "../../../../../../lib/server/growth";
import { isUuid } from "../../../../../../lib/server/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/growth/proposals/[id]/send (docs/phase8/CONTRACTS.md §P8-GROWTH2)
 * — mint a `proposal` share token (reusing P8-REPORT's share.ts core) for a
 * 'ready' proposal and flip its status to 'sent'. Org-scoped; unknown id →
 * 404, wrong status (not 'ready') → 409. The raw token is returned ONCE here
 * so the board can offer a copy-link affordance right after sending — it is
 * never re-exposed by any later read.
 */
export const POST = withErrorHandling(async (_req: Request, { params }: Ctx) => {
  const orgId = await requireOrgId();
  const { id } = await params;
  if (!isUuid(id)) return jsonError(404, "proposal_not_found");

  const result = await sendProposal(orgId, id);
  if (!result.ok) {
    if (result.error === "not_found") return jsonError(404, "proposal_not_found");
    if (result.error === "enc_key_missing") return jsonError(503, "share_unavailable");
    return jsonError(409, "invalid_status");
  }

  return NextResponse.json({ proposal: result.proposal, token: result.token });
});
