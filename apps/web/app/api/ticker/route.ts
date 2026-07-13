import { NextResponse } from "next/server";
import { jsonError, withErrorHandling } from "../../../lib/server/http";
import { requireOrgId } from "../../../lib/server/org";
import { getTickerEvents } from "../../../lib/server/queries";
import {
  searchParamsObject,
  tickerQuerySchema,
  zodSummary,
} from "../../../lib/server/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withErrorHandling(async (req: Request) => {
  const orgId = await requireOrgId();
  const parsed = tickerQuerySchema.safeParse(searchParamsObject(req));
  if (!parsed.success) return jsonError(400, zodSummary(parsed.error));
  const events = await getTickerEvents(orgId, parsed.data);
  return NextResponse.json({ events });
});
