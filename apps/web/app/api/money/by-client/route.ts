import { NextResponse } from "next/server";
import { withErrorHandling } from "../../../../lib/server/http";
import { getRevenueByClient } from "../../../../lib/server/money";
import { requireOrgId } from "../../../../lib/server/org";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withErrorHandling(async () => {
  const orgId = await requireOrgId();
  return NextResponse.json(await getRevenueByClient(orgId));
});
