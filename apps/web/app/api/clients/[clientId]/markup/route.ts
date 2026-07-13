import { NextResponse } from "next/server";
import { jsonError, withErrorHandling } from "../../../../../lib/server/http";
import { markupSchema, setClientMarkup } from "../../../../../lib/server/money";
import { requireOrgId } from "../../../../../lib/server/org";
import { isUuid, readJsonBody, zodSummary } from "../../../../../lib/server/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** PATCH /api/clients/[clientId]/markup { pct } — the invoicing markup editor. */
export const PATCH = withErrorHandling(
  async (req: Request, ctx: { params: Promise<{ clientId: string }> }) => {
    const orgId = await requireOrgId();
    const { clientId } = await ctx.params;
    if (!isUuid(clientId)) return jsonError(400, "invalid client id");
    const parsed = markupSchema.safeParse(await readJsonBody(req));
    if (!parsed.success) return jsonError(400, zodSummary(parsed.error));
    const result = await setClientMarkup(orgId, clientId, parsed.data.pct);
    if (!result) return jsonError(404, "client_not_found");
    return NextResponse.json(result);
  },
);
