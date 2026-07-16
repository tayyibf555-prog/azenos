import { NextResponse } from "next/server";
import { jsonError, withErrorHandling } from "../../../../lib/server/http";
import { getCostStatements } from "../../../../lib/server/money";
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
  // Billing v2 (LEAD RULING 2026-07-16): BOTH streams (OS + client-system AI)
  // are billed with markup by default; include_client_emitted=false excludes the
  // client-system AI stream (display-only) for clients who bring their own keys.
  const includeClientEmitted =
    new URL(req.url).searchParams.get("include_client_emitted") !== "false";
  return NextResponse.json(
    await getCostStatements(orgId, parsed.data.month, { includeClientEmitted }),
  );
});
