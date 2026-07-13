import { db } from "@azen/db";
import { runDailyBrief } from "@azen/agents";
import { NextResponse } from "next/server";
import { z } from "zod";
import { jsonError, withErrorHandling } from "../../../../lib/server/http";
import { requireOrgId } from "../../../../lib/server/org";
import { readJsonBody, zodSummary } from "../../../../lib/server/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// On-demand generation from the Briefs screen (docs/phase3/CONTRACTS.md
// §P3-BRIEF). Defaults to a DRY-RUN send in the demo (exact payloads, no
// network); pass dryRun:false to attempt a real send when keys are present.
const runBodySchema = z
  .object({
    forDay: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    deliver: z.boolean().optional(),
    dryRun: z.boolean().optional(),
  })
  .catch({});

export const POST = withErrorHandling(async (req: Request) => {
  const orgId = await requireOrgId();

  const parsed = runBodySchema.safeParse((await readJsonBody(req)) ?? {});
  if (!parsed.success) return jsonError(400, zodSummary(parsed.error));
  const { forDay, deliver, dryRun } = parsed.data;

  const res = await runDailyBrief(db, {
    orgId,
    forDay,
    deliver: deliver ?? true,
    dryRun: dryRun ?? true,
  });

  if (!res.ok) {
    // The daily brief is critical, so a failure here is a real generation error
    // (missing ANTHROPIC_API_KEY surfaces as anthropic_auth — the UI banner).
    const status = res.error === "budget_exceeded" ? 402 : 502;
    return jsonError(status, res.error);
  }

  return NextResponse.json({
    briefId: res.briefId,
    delivered: res.delivered,
    tokensIn: res.tokensIn,
    tokensOut: res.tokensOut,
  });
});
