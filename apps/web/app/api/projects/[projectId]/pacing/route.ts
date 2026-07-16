import { NextResponse } from "next/server";
import { jsonError, withErrorHandling } from "../../../../../lib/server/http";
import { requireOrgId } from "../../../../../lib/server/org";
import { isUuid } from "../../../../../lib/server/schemas";
import { getProjectForAnalytics } from "../../../../../lib/server/analytics/base";
import {
  computeProjectGoalPacing,
  type GoalPacingResult,
} from "../../../../../lib/server/pacing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ projectId: string }> };

export interface PacingApiResponse {
  goals: GoalPacingResult[];
}

/**
 * P9-PACK1 — goal pacing read for the project Overview card
 * (docs/phase9/CONTRACTS.md §P9-PACK1). Read-only; org+project scoped.
 * Empty `goals` when the project has none declared (graceful empty state).
 */
export const GET = withErrorHandling(async (_req: Request, { params }: Ctx) => {
  const orgId = await requireOrgId();
  const { projectId } = await params;
  if (!isUuid(projectId)) return jsonError(404, "project_not_found");

  const project = await getProjectForAnalytics(orgId, projectId);
  if (!project) return jsonError(404, "project_not_found");

  const goals =
    project.goals.length > 0
      ? await computeProjectGoalPacing(orgId, projectId, project.goals)
      : [];

  const body: PacingApiResponse = { goals };
  return NextResponse.json(body);
});
