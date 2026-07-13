import { NextResponse } from "next/server";
import { jsonError, withErrorHandling } from "../../../../lib/server/http";
import {
  createExpense,
  expenseCreateSchema,
  listExpenses,
} from "../../../../lib/server/money";
import { requireOrgId } from "../../../../lib/server/org";
import {
  monthQuerySchema,
  readJsonBody,
  searchParamsObject,
  zodSummary,
} from "../../../../lib/server/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withErrorHandling(async (req: Request) => {
  const orgId = await requireOrgId();
  const parsed = monthQuerySchema.safeParse(searchParamsObject(req));
  if (!parsed.success) return jsonError(400, zodSummary(parsed.error));
  return NextResponse.json({
    expenses: await listExpenses(orgId, { month: parsed.data.month }),
  });
});

export const POST = withErrorHandling(async (req: Request) => {
  const orgId = await requireOrgId();
  const parsed = expenseCreateSchema.safeParse(await readJsonBody(req));
  if (!parsed.success) return jsonError(400, zodSummary(parsed.error));
  const result = await createExpense(orgId, parsed.data);
  if (!result.ok) return jsonError(404, result.error);
  return NextResponse.json({ expense: result.expense }, { status: 201 });
});
