import { NextResponse } from "next/server";
import { z } from "zod";
import { jsonError, withErrorHandling } from "../../../../../lib/server/http";
import { requireOrgId } from "../../../../../lib/server/org";
import { listClients } from "../../../../../lib/server/queries";
import { readJsonBody, zodSummary } from "../../../../../lib/server/schemas";
import { buildRefineSystemPrompt } from "../../../../../lib/server/intake/prompt";
import { runIntakeAgent } from "../../../../../lib/server/intake/run";
import {
  finalizeDraft,
  projectDraftSchema,
  refineOutputSchema,
  trackingPlanForDraft,
  type ClientRef,
} from "../../../../../lib/server/intake/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Stateless round-trip: the full current draft rides in every request.
const refineBodySchema = z.object({
  draft: projectDraftSchema,
  instruction: z.string().min(1).max(2000),
  transcript: z.string().max(100_000).optional(),
});

export const POST = withErrorHandling(async (req: Request) => {
  const orgId = await requireOrgId();
  const parsed = refineBodySchema.safeParse(await readJsonBody(req));
  if (!parsed.success) return jsonError(400, zodSummary(parsed.error));

  const clients: ClientRef[] = (await listClients(orgId)).map((c) => ({
    id: c.id,
    name: c.name,
    industrySlug: c.industrySlug,
  }));

  const result = await runIntakeAgent({
    orgId,
    system: buildRefineSystemPrompt({
      clients,
      draft: parsed.data.draft,
      transcript: parsed.data.transcript,
    }),
    userContent: parsed.data.instruction,
    schema: refineOutputSchema,
    mode: "refine",
  });
  if (!result.ok) return jsonError(result.status, result.error);

  const draft = finalizeDraft(result.parsed.draft, clients);
  return NextResponse.json({
    draft,
    note: result.parsed.note,
    runId: result.runId,
    trackingPlan: trackingPlanForDraft(draft),
  });
});
