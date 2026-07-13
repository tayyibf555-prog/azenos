import { NextResponse } from "next/server";
import { getClientEndBookings } from "../../../../lib/server/bookings";
import { jsonError, withErrorHandling } from "../../../../lib/server/http";
import { requireOrgId } from "../../../../lib/server/org";
import {
  monthQuerySchema,
  searchParamsObject,
  zodSummary,
} from "../../../../lib/server/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withErrorHandling(async (req: Request) => {
  const orgId = await requireOrgId();
  const parsed = monthQuerySchema.safeParse(searchParamsObject(req));
  if (!parsed.success) return jsonError(400, zodSummary(parsed.error));
  return NextResponse.json(
    await getClientEndBookings(orgId, parsed.data.month),
  );
});
