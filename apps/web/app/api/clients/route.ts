import { NextResponse } from "next/server";
import { jsonError, withErrorHandling } from "../../../lib/server/http";
import { requireOrgId } from "../../../lib/server/org";
import { createClient, listClients } from "../../../lib/server/queries";
import {
  clientCreateSchema,
  readJsonBody,
  zodSummary,
} from "../../../lib/server/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withErrorHandling(async () => {
  const orgId = await requireOrgId();
  return NextResponse.json({ clients: await listClients(orgId) });
});

export const POST = withErrorHandling(async (req: Request) => {
  const orgId = await requireOrgId();
  const parsed = clientCreateSchema.safeParse(await readJsonBody(req));
  if (!parsed.success) return jsonError(400, zodSummary(parsed.error));
  const client = await createClient(orgId, parsed.data);
  return NextResponse.json({ client }, { status: 201 });
});
