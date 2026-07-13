import { desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { chatSessions, db } from "@azen/db";
import { withErrorHandling } from "../../../../lib/server/http";
import { requireOrgId } from "../../../../lib/server/org";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/ask/sessions — the org's Ask Azen sessions, newest first, for the
 * history sidebar (docs/phase3b/CONTRACTS.md §P3B-CHAT). Org-scoped; metadata
 * only (messages are fetched per-session by the [id] route).
 */
export const GET = withErrorHandling(async () => {
  const orgId = await requireOrgId();
  const rows = await db.query.chatSessions.findMany({
    where: eq(chatSessions.orgId, orgId),
    orderBy: [desc(chatSessions.createdAt)],
    columns: { id: true, title: true, context: true, createdAt: true },
    limit: 100,
  });
  return NextResponse.json({ sessions: rows });
});
