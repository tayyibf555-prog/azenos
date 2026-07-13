import { NextResponse } from "next/server";
import { jsonError, withErrorHandling } from "../../../../lib/server/http";
import { requireOrgId } from "../../../../lib/server/org";
import { getSparklines } from "../../../../lib/server/queries";
import {
  searchParamsObject,
  sparklinesQuerySchema,
  zodSummary,
} from "../../../../lib/server/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withErrorHandling(async (req: Request) => {
  const orgId = await requireOrgId();
  const parsed = sparklinesQuerySchema.safeParse(searchParamsObject(req));
  if (!parsed.success) return jsonError(400, zodSummary(parsed.error));
  return NextResponse.json(await getSparklines(orgId, parsed.data.days));
});
