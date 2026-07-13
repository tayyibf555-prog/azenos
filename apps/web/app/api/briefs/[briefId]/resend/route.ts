import { db } from "@azen/db";
import { resendBrief } from "@azen/agents";
import { NextResponse } from "next/server";
import { z } from "zod";
import { jsonError, withErrorHandling } from "../../../../../lib/server/http";
import { requireOrgId } from "../../../../../lib/server/org";
import { isUuid, readJsonBody, zodSummary } from "../../../../../lib/server/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ briefId: string }> };

// Re-deliver a stored brief (docs/phase3/CONTRACTS.md §P3-BRIEF). Org-checked;
// defaults to a DRY-RUN in the demo (pass dryRun:false for a live re-send).
const resendBodySchema = z.object({ dryRun: z.boolean().optional() }).catch({});

export const POST = withErrorHandling(async (req: Request, { params }: Ctx) => {
  const orgId = await requireOrgId();
  const { briefId } = await params;
  if (!isUuid(briefId)) return jsonError(404, "brief_not_found");

  const parsed = resendBodySchema.safeParse((await readJsonBody(req)) ?? {});
  if (!parsed.success) return jsonError(400, zodSummary(parsed.error));

  const res = await resendBrief(db, {
    orgId,
    briefId,
    dryRun: parsed.data.dryRun ?? true,
  });
  if (!res.ok) return jsonError(404, res.error);

  return NextResponse.json({ delivered: res.delivered });
});
