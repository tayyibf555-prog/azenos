import { NextResponse } from "next/server";
import { jsonError, withErrorHandling } from "../../../../lib/server/http";
import {
  bankPaymentSchema,
  createBankPayment,
} from "../../../../lib/server/money";
import { requireOrgId } from "../../../../lib/server/org";
import { readJsonBody, zodSummary } from "../../../../lib/server/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withErrorHandling(async (req: Request) => {
  const orgId = await requireOrgId();
  const parsed = bankPaymentSchema.safeParse(await readJsonBody(req));
  if (!parsed.success) return jsonError(400, zodSummary(parsed.error));
  const result = await createBankPayment(orgId, parsed.data);
  if (!result.ok) return jsonError(404, result.error);
  return NextResponse.json({ payment: result.payment }, { status: 201 });
});
