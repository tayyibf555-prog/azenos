import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { briefs, db } from "@azen/db";
import { withErrorHandling } from "../../../../lib/server/http";
import { requireOrgId } from "../../../../lib/server/org";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/briefs/latest — the most recent agency daily brief for the org, or
 * `{ brief: null }` when none has been generated yet. Powers the inline brief
 * card on the Command Center. Owned by P3-UI (the resend/run routes are
 * P3-BRIEF's).
 */
export const GET = withErrorHandling(async () => {
  const orgId = await requireOrgId();
  const row = await db.query.briefs.findFirst({
    where: and(
      eq(briefs.orgId, orgId),
      eq(briefs.scope, "agency"),
      eq(briefs.period, "daily"),
    ),
    orderBy: (b, { desc }) => [desc(b.periodStart), desc(b.createdAt)],
  });

  if (!row) return NextResponse.json({ brief: null });

  return NextResponse.json({
    brief: {
      id: row.id,
      scope: row.scope,
      period: row.period,
      periodStart: row.periodStart,
      headline: row.headline,
      bodyMd: row.bodyMd,
      bodyWhatsapp: row.bodyWhatsapp,
      dataSnapshot: row.dataSnapshot,
      model: row.model,
      tokensIn: row.tokensIn,
      tokensOut: row.tokensOut,
      status: row.status,
      sentEmailAt: row.sentEmailAt,
      sentWhatsappAt: row.sentWhatsappAt,
      createdAt: row.createdAt,
    },
  });
});
