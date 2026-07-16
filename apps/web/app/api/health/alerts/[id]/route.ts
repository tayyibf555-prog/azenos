import { NextResponse } from "next/server";
import { jsonError, withErrorHandling } from "../../../../../lib/server/http";
import { requireOrgId } from "../../../../../lib/server/org";
import { isUuid, readJsonBody } from "../../../../../lib/server/schemas";
import { mutateAlert } from "../../../../../lib/server/health/alerts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * PATCH /api/health/alerts/[id] — ack or resolve an open alert instance
 * (docs/phase8/CONTRACTS.md — P8-HEALTH). Body: { action: 'ack' | 'resolve' }.
 * Org-scoped; unknown/cross-org id → 404.
 */
export const PATCH = withErrorHandling(async (req: Request, { params }: Ctx) => {
  const orgId = await requireOrgId();
  const { id } = await params;
  if (!isUuid(id)) return jsonError(404, "alert_not_found");

  const body = (await readJsonBody(req)) as { action?: unknown } | null;
  const action = body?.action;
  if (action !== "ack" && action !== "resolve") {
    return jsonError(400, "action must be 'ack' or 'resolve'");
  }

  const row = await mutateAlert(orgId, id, action);
  if (!row) return jsonError(404, "alert_not_found");
  return NextResponse.json({ alert: row });
});
