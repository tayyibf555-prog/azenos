import { NextResponse } from "next/server";
import { z } from "zod";
import { jsonError, withErrorHandling } from "../../../../../lib/server/http";
import {
  commitPaymentsImport,
  previewPaymentsImport,
} from "../../../../../lib/server/money";
import { requireOrgId } from "../../../../../lib/server/org";
import { readJsonBody, zodSummary } from "../../../../../lib/server/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  csv: z.string().min(1).max(1_000_000),
  commit: z.boolean().optional(),
});

/**
 * Two-phase CSV import: `commit:false` (default) returns a preview with
 * per-row validation; `commit:true` inserts the valid rows as bank_transfer
 * payments and reports what was skipped.
 */
export const POST = withErrorHandling(async (req: Request) => {
  const orgId = await requireOrgId();
  const parsed = bodySchema.safeParse(await readJsonBody(req));
  if (!parsed.success) return jsonError(400, zodSummary(parsed.error));

  if (parsed.data.commit) {
    return NextResponse.json({
      mode: "commit",
      ...(await commitPaymentsImport(orgId, parsed.data.csv)),
    });
  }
  return NextResponse.json({
    mode: "preview",
    ...(await previewPaymentsImport(orgId, parsed.data.csv)),
  });
});
