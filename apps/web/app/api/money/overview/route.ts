import { NextResponse } from "next/server";
import { z } from "zod";
import { jsonError, withErrorHandling } from "../../../../lib/server/http";
import { getMoneyOverview } from "../../../../lib/server/money";
import { requireOrgId } from "../../../../lib/server/org";
import {
  searchParamsObject,
  zodSummary,
} from "../../../../lib/server/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const querySchema = z.object({
  months: z.preprocess(
    (v) => (v === undefined || v === null || v === "" ? "6" : v),
    z.coerce
      .number()
      .int()
      .positive()
      .transform((n) => Math.min(n, 24)),
  ),
});

export const GET = withErrorHandling(async (req: Request) => {
  const orgId = await requireOrgId();
  const parsed = querySchema.safeParse(searchParamsObject(req));
  if (!parsed.success) return jsonError(400, zodSummary(parsed.error));
  return NextResponse.json(await getMoneyOverview(orgId, parsed.data.months));
});
