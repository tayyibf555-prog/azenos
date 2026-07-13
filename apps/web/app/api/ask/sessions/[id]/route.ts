import { and, asc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { chatMessages, chatSessions, db } from "@azen/db";
import { jsonError, withErrorHandling } from "../../../../../lib/server/http";
import { requireOrgId } from "../../../../../lib/server/org";
import { isUuid } from "../../../../../lib/server/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/ask/sessions/[id] — one session and its full message thread, in
 * order, including the tool-call trace on each assistant message (the "how I
 * got this" data). Org-checked: a session from another org 404s (no leak).
 */
export const GET = withErrorHandling(async (_req: Request, { params }: Ctx) => {
  const orgId = await requireOrgId();
  const { id } = await params;
  if (!isUuid(id)) return jsonError(404, "session_not_found");

  const session = await db.query.chatSessions.findFirst({
    where: and(eq(chatSessions.id, id), eq(chatSessions.orgId, orgId)),
    columns: { id: true, title: true, context: true, createdAt: true },
  });
  if (!session) return jsonError(404, "session_not_found");

  const messages = await db.query.chatMessages.findMany({
    where: eq(chatMessages.sessionId, session.id),
    orderBy: [asc(chatMessages.createdAt)],
    columns: {
      id: true,
      role: true,
      contentMd: true,
      toolCalls: true,
      model: true,
      tokensIn: true,
      tokensOut: true,
      costEstimatePence: true,
      createdAt: true,
    },
  });

  return NextResponse.json({ session, messages });
});
