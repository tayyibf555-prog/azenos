import { NextResponse } from "next/server";
import { z } from "zod";
import { jsonError, withErrorHandling } from "../../../../lib/server/http";
import { requireOrgId } from "../../../../lib/server/org";
import { listClients } from "../../../../lib/server/queries";
import { readJsonBody, zodSummary } from "../../../../lib/server/schemas";
import { buildIntakeSystemPrompt } from "../../../../lib/server/intake/prompt";
import { runIntakeAgent } from "../../../../lib/server/intake/run";
import {
  finalizeDraft,
  projectDraftSchema,
  trackingPlanForDraft,
  type ClientRef,
} from "../../../../lib/server/intake/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Length caps live here (route validation), not in the API output schema.
const intakeBodySchema = z.object({
  transcript: z.string().min(100).max(100_000),
});

export const POST = withErrorHandling(async (req: Request) => {
  const orgId = await requireOrgId();
  const parsed = intakeBodySchema.safeParse(await readJsonBody(req));
  if (!parsed.success) return jsonError(400, zodSummary(parsed.error));

  // Reuse the dashboard client query; project to the id/name/industry the
  // agent needs to propose match="existing" with a real clientId.
  const clients: ClientRef[] = (await listClients(orgId)).map((c) => ({
    id: c.id,
    name: c.name,
    industrySlug: c.industrySlug,
  }));

  const result = await runIntakeAgent({
    orgId,
    system: buildIntakeSystemPrompt({ clients }),
    userContent: parsed.data.transcript,
    schema: projectDraftSchema,
    mode: "intake",
  });
  if (!result.ok) return jsonError(result.status, result.error);

  const draft = finalizeDraft(result.parsed, clients);
  return NextResponse.json({
    draft,
    runId: result.runId,
    trackingPlan: trackingPlanForDraft(draft),
  });
});
