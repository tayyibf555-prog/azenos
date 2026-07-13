import { NextResponse } from "next/server";
import { jsonError, withErrorHandling } from "../../../../../lib/server/http";
import { requireOrgId } from "../../../../../lib/server/org";
import {
  listProjectEvents,
  projectExists,
} from "../../../../../lib/server/queries";
import {
  decodeEventsCursor,
  isUuid,
  projectEventsQuerySchema,
  searchParamsObject,
  zodSummary,
  type EventsCursor,
} from "../../../../../lib/server/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ projectId: string }> };

export const GET = withErrorHandling(async (req: Request, { params }: Ctx) => {
  const orgId = await requireOrgId();
  const { projectId } = await params;
  if (!isUuid(projectId)) return jsonError(404, "project_not_found");
  if (!(await projectExists(orgId, projectId))) {
    return jsonError(404, "project_not_found");
  }
  const parsed = projectEventsQuerySchema.safeParse(searchParamsObject(req));
  if (!parsed.success) return jsonError(400, zodSummary(parsed.error));
  const { cursor: rawCursor, ...filters } = parsed.data;
  let cursor: EventsCursor | undefined;
  if (rawCursor !== undefined) {
    const decoded = decodeEventsCursor(rawCursor);
    if (!decoded) return jsonError(400, "cursor: malformed");
    cursor = decoded;
  }
  const result = await listProjectEvents(orgId, projectId, {
    ...filters,
    cursor,
  });
  return NextResponse.json(result);
});
