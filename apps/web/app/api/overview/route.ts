import { NextResponse } from "next/server";
import { withErrorHandling } from "../../../lib/server/http";
import { requireOrgId } from "../../../lib/server/org";
import { getOverview, getOverviewExtras } from "../../../lib/server/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withErrorHandling(async () => {
  const orgId = await requireOrgId();
  // M2 (wave 2) extends the Phase 1 overview with health + open-anomaly counts.
  const [overview, extras] = await Promise.all([
    getOverview(orgId),
    getOverviewExtras(orgId),
  ]);
  return NextResponse.json({ ...overview, ...extras });
});
