import { NextResponse } from "next/server";
import { getClientDetail } from "../../../../lib/server/bookings";
import { jsonError, withErrorHandling } from "../../../../lib/server/http";
import { requireOrgId } from "../../../../lib/server/org";
import { isUuid } from "../../../../lib/server/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ clientId: string }> };

export const GET = withErrorHandling(async (_req: Request, { params }: Ctx) => {
  const orgId = await requireOrgId();
  const { clientId } = await params;
  if (!isUuid(clientId)) return jsonError(404, "client_not_found");

  const detail = await getClientDetail(orgId, clientId);
  if (detail === null) return jsonError(404, "client_not_found");
  return NextResponse.json(detail);
});
