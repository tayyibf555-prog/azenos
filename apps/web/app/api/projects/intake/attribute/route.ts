import { NextResponse } from "next/server";
import { z } from "zod";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { agentRuns, db, projects } from "@azen/db";
import { jsonError, withErrorHandling } from "../../../../../lib/server/http";
import { requireOrgId } from "../../../../../lib/server/org";
import {
  readJsonBody,
  uuidSchema,
  zodSummary,
} from "../../../../../lib/server/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Cost-attribution backfill (phase2 CONTRACTS addendum §B). Intake/refine runs
 * are logged before the project exists; once the project is created the client
 * fires this with every runId it collected. Strictly scoped: only rows with
 * agent='project_intake', the caller's org, and a still-null project_id are
 * touched — already-attributed, cross-org, or other-agent rows never move.
 */

const attributeBodySchema = z.object({
  runIds: z.array(uuidSchema).min(1).max(100),
  projectId: uuidSchema,
});

export const POST = withErrorHandling(async (req: Request) => {
  const orgId = await requireOrgId();
  const parsed = attributeBodySchema.safeParse(await readJsonBody(req));
  if (!parsed.success) return jsonError(400, zodSummary(parsed.error));

  const [project] = await db
    .select({ id: projects.id, clientId: projects.clientId })
    .from(projects)
    .where(and(eq(projects.orgId, orgId), eq(projects.id, parsed.data.projectId)))
    .limit(1);
  if (!project) return jsonError(404, "project_not_found");

  const updated = await db
    .update(agentRuns)
    .set({ projectId: project.id, clientId: project.clientId })
    .where(
      and(
        eq(agentRuns.orgId, orgId),
        eq(agentRuns.agent, "project_intake"),
        isNull(agentRuns.projectId),
        inArray(agentRuns.id, parsed.data.runIds),
      ),
    )
    .returning({ id: agentRuns.id });

  return NextResponse.json({ updated: updated.length });
});
