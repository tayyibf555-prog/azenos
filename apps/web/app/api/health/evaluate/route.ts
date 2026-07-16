import { NextResponse } from "next/server";
import { jsonError, withErrorHandling } from "../../../../lib/server/http";
import { requireOrgId } from "../../../../lib/server/org";
import { readJsonBody } from "../../../../lib/server/schemas";
import { evaluateHealth } from "../../../../lib/server/health/evaluate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/health/evaluate — run one health evaluation pass for the org
 * (docs/phase8/CONTRACTS.md — P8-HEALTH). Internal: the Health screen's
 * "Re-evaluate now" button and the scripts/health-run.ts cron both hit this.
 * Deterministic; safe to call repeatedly (breaches fire once, recovery
 * auto-resolves). Body: optional { escalate?: boolean }.
 */
export const POST = withErrorHandling(async (req: Request) => {
  const orgId = await requireOrgId();
  const body = (await readJsonBody(req)) as { escalate?: unknown } | null;
  const escalate = typeof body?.escalate === "boolean" ? body.escalate : undefined;

  const result = await evaluateHealth(orgId, { escalate });

  if (result.escalations.attempted > 0 && !result.escalations.twilioConfigured) {
    // Not an error — surfaced so the caller/banner can prompt for TWILIO_* keys.
    return NextResponse.json({ ...result, warning: "escalation_needs_twilio" });
  }
  if (result.escalations.attempted > 0 && !result.escalations.recipientConfigured) {
    // Twilio is configured but the escalation had nowhere to go — surface it so
    // the owner sets a WhatsApp number instead of the alert dropping silently.
    return NextResponse.json({ ...result, warning: "escalation_needs_recipient" });
  }
  return NextResponse.json(result);
});

// Guard against accidental GETs revealing anything — this is a mutation route.
export const GET = withErrorHandling(async () => jsonError(405, "method_not_allowed"));
