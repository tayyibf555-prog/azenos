import { NextResponse } from "next/server";
import { runUpsellEngine } from "@azen/agents";
import { db } from "@azen/db";
import { jsonError, withErrorHandling } from "../../../../lib/server/http";
import { requireOrgId } from "../../../../lib/server/org";
import {
  getGrowthProposals,
  proposalCreateSchema,
} from "../../../../lib/server/growth";
import { readJsonBody, zodSummary } from "../../../../lib/server/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/growth/proposals — every proposal on the board with cited evidence. */
export const GET = withErrorHandling(async () => {
  const orgId = await requireOrgId();
  const proposals = await getGrowthProposals(orgId);
  return NextResponse.json({ proposals });
});

/**
 * POST /api/growth/proposals — run the Upsell Engine for one insight (the Growth
 * "convert to proposal" button) or a whole client, drafting a client-ready
 * proposal that traces to evidence. A missing/invalid ANTHROPIC_API_KEY surfaces
 * as a typed 502 (never a crash); no eligible opportunity → 404.
 */
export const POST = withErrorHandling(async (req: Request) => {
  const orgId = await requireOrgId();
  const parsed = proposalCreateSchema.safeParse(await readJsonBody(req));
  if (!parsed.success) return jsonError(400, zodSummary(parsed.error));

  const res = await runUpsellEngine(db, {
    orgId,
    insightId: parsed.data.insightId,
    clientId: parsed.data.clientId,
  });

  if (!res.ok) {
    const status = res.error === "budget_exceeded" ? 402 : 502;
    return jsonError(status, res.error);
  }
  if (res.proposalId === null) {
    return jsonError(404, "no_eligible_opportunity");
  }

  return NextResponse.json({
    proposalId: res.proposalId,
    insightIds: res.insightIds,
  });
});
