import { NextResponse } from "next/server";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db, events } from "@azen/db";
import { jsonError, withErrorHandling } from "../../../../../lib/server/http";
import { requireOrgId } from "../../../../../lib/server/org";
import {
  listProjectInsights,
  projectExists,
} from "../../../../../lib/server/queries";
import {
  insightsQuerySchema,
  isUuid,
  searchParamsObject,
  zodSummary,
} from "../../../../../lib/server/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ projectId: string }> };

/**
 * Evidence drill-down (§P6-SCOUT): resolve the bare event ids an insight cites in
 * evidence.event_ids into lightweight, org/project-scoped event rows so the
 * Insights tab can expand an opportunity to the events that justify it — without
 * an N+1 from the client and without leaking end-customer payload (only id, type,
 * occurredAt are exposed). A single batched inArray query hydrates every insight.
 */
interface EvidenceEvent {
  id: string;
  type: string;
  occurredAt: string;
}

function collectEventIds(list: { evidence: Record<string, unknown> }[]): string[] {
  const ids = new Set<string>();
  for (const ins of list) {
    const raw = ins.evidence?.["event_ids"];
    if (Array.isArray(raw)) {
      for (const id of raw) {
        if (typeof id === "string" && isUuid(id)) ids.add(id);
      }
    }
  }
  return [...ids];
}

async function hydrateEvidence(
  orgId: string,
  projectId: string,
  ids: string[],
): Promise<Map<string, EvidenceEvent>> {
  const byId = new Map<string, EvidenceEvent>();
  if (ids.length === 0) return byId;
  const rows = await db
    .select({
      id: events.id,
      type: events.type,
      occurredAt: events.occurredAt,
    })
    .from(events)
    .where(
      and(
        eq(events.orgId, orgId),
        eq(events.projectId, projectId),
        inArray(events.id, ids),
      ),
    )
    .orderBy(desc(events.occurredAt));
  for (const r of rows) {
    byId.set(r.id, {
      id: r.id,
      type: r.type,
      occurredAt: r.occurredAt.toISOString(),
    });
  }
  return byId;
}

export const GET = withErrorHandling(async (req: Request, { params }: Ctx) => {
  const orgId = await requireOrgId();
  const { projectId } = await params;
  if (!isUuid(projectId)) return jsonError(404, "project_not_found");
  if (!(await projectExists(orgId, projectId)))
    return jsonError(404, "project_not_found");

  const parsed = insightsQuerySchema.safeParse(searchParamsObject(req));
  if (!parsed.success) return jsonError(400, zodSummary(parsed.error));

  const list = await listProjectInsights(orgId, projectId, {
    status: parsed.data.status,
    limit: parsed.data.limit,
  });

  // Attach resolved evidence events for the drill-down (the ids → the events).
  // Only insights that actually cite event_ids gain the `evidenceEvents` key, so
  // metric-only insights (anomaly/risk with a metric_key) keep their prior shape.
  const eventIds = collectEventIds(list);
  const byId = await hydrateEvidence(orgId, projectId, eventIds);
  const insightsOut = list.map((ins) => {
    const raw = ins.evidence?.["event_ids"];
    if (!Array.isArray(raw) || raw.length === 0) return ins;
    const evidenceEvents = raw
      .map((id) => (typeof id === "string" ? byId.get(id) : undefined))
      .filter((e): e is EvidenceEvent => e !== undefined);
    return { ...ins, evidenceEvents };
  });

  return NextResponse.json({ insights: insightsOut });
});
