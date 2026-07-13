import {
  clients,
  db,
  events,
  insights,
  projects,
  upsellProposals,
} from "@azen/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

/**
 * Growth screen + Upsell pipeline logic (docs/phase6/CONTRACTS.md §P6-GROWTH).
 *
 * The pipeline is the OPPORTUNITY side: automation_opportunity / upsell insights
 * still in play (status new | reviewed) that a human reviews and then converts to
 * a proposal (the POST /api/growth/proposals runs the Upsell Engine for one
 * insight). The proposals board is the SALES side: upsell_proposals moving
 * draft → ready → sent → won → lost. Won proposals track the revenue attributed
 * to the OS (the sum of their suggested prices).
 *
 * Money is integer pence throughout. postgres-js returns numerics/bigints as
 * strings, so every aggregate is coerced with Number(). Evidence event ids are
 * hydrated to lightweight rows (id, type, occurredAt) so a proposal traces to the
 * real events that justify it — without leaking end-customer payload.
 */

// ── validation (own file — no shared-schema edit) ─────────────────────────────

/** The status transitions a proposal can be PATCHed to (the full lifecycle). */
export const proposalStatusSchema = z.enum(["draft", "ready", "sent", "won", "lost"]);
export type ProposalStatus = z.infer<typeof proposalStatusSchema>;

export const proposalPatchSchema = z.object({ status: proposalStatusSchema });

/** POST body: convert ONE insight, or fold a whole CLIENT's opportunities. */
export const proposalCreateSchema = z
  .object({
    insightId: z.uuid().optional(),
    clientId: z.uuid().optional(),
  })
  .refine((v) => Boolean(v.insightId) || Boolean(v.clientId), {
    message: "insightId or clientId is required",
  });
export type ProposalCreateInput = z.infer<typeof proposalCreateSchema>;

// ── shared shapes (mirrored in components/growth-types.ts) ─────────────────────

export interface EvidenceEvent {
  id: string;
  type: string;
  occurredAt: string;
}

export interface PipelineItem {
  id: string;
  kind: string;
  title: string;
  bodyMd: string;
  confidence: string;
  status: string;
  estimatedValuePence: number | null;
  estimatedHoursSavedMonthly: number | null;
  clientId: string;
  clientName: string;
  projectId: string;
  projectName: string;
  evidenceEventCount: number;
  createdAt: string;
}

export interface ProposalItem {
  id: string;
  clientId: string;
  clientName: string;
  projectId: string | null;
  projectName: string | null;
  title: string;
  problemMd: string;
  proposalMd: string;
  suggestedPricePence: number | null;
  status: string;
  insightIds: string[];
  expectedRoiNote: string | null;
  evidenceEvents: EvidenceEvent[];
  createdAt: string;
}

const num = (v: unknown): number => Number(v ?? 0);

function eventIdsFromEvidence(evidence: Record<string, unknown> | null): string[] {
  const raw = evidence?.["event_ids"];
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is string => typeof x === "string");
}

// ── pipeline (opportunity insights in play) ───────────────────────────────────

/**
 * Opportunities still in the pipeline: automation_opportunity / upsell insights
 * with status new | reviewed, newest-highest-value first, each carrying its
 * client + project and a cited-evidence count. Converted / dismissed insights
 * have left the pipeline and are excluded.
 */
export async function getGrowthPipeline(orgId: string): Promise<PipelineItem[]> {
  const rows = await db
    .select({
      id: insights.id,
      kind: insights.kind,
      title: insights.title,
      bodyMd: insights.bodyMd,
      confidence: insights.confidence,
      status: insights.status,
      estimatedValuePence: insights.estimatedValuePence,
      estimatedHoursSavedMonthly: insights.estimatedHoursSavedMonthly,
      evidence: insights.evidence,
      createdAt: insights.createdAt,
      clientId: clients.id,
      clientName: clients.name,
      projectId: projects.id,
      projectName: projects.name,
    })
    .from(insights)
    .innerJoin(projects, eq(projects.id, insights.projectId))
    .innerJoin(clients, eq(clients.id, projects.clientId))
    .where(
      and(
        eq(insights.orgId, orgId),
        inArray(insights.kind, ["automation_opportunity", "upsell"]),
        inArray(insights.status, ["new", "reviewed"]),
      ),
    )
    .orderBy(
      sql`${insights.estimatedValuePence} desc nulls last`,
      desc(insights.createdAt),
      desc(insights.id),
    );

  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    title: r.title,
    bodyMd: r.bodyMd,
    confidence: r.confidence,
    status: r.status,
    estimatedValuePence:
      r.estimatedValuePence === null ? null : num(r.estimatedValuePence),
    estimatedHoursSavedMonthly: r.estimatedHoursSavedMonthly,
    clientId: r.clientId,
    clientName: r.clientName,
    projectId: r.projectId,
    projectName: r.projectName,
    evidenceEventCount: eventIdsFromEvidence(r.evidence).length,
    createdAt: r.createdAt.toISOString(),
  }));
}

// ── proposals (the sales board) ───────────────────────────────────────────────

async function hydrateEvidence(
  orgId: string,
  ids: string[],
): Promise<Map<string, EvidenceEvent>> {
  const byId = new Map<string, EvidenceEvent>();
  if (ids.length === 0) return byId;
  const rows = await db
    .select({ id: events.id, type: events.type, occurredAt: events.occurredAt })
    .from(events)
    .where(and(eq(events.orgId, orgId), inArray(events.id, ids)))
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

/**
 * Every proposal on the board with its client + project and the events its
 * problem statement cites (a single batched hydrate over all proposals — no
 * N+1). Newest first.
 */
export async function getGrowthProposals(orgId: string): Promise<ProposalItem[]> {
  const rows = await db
    .select({
      id: upsellProposals.id,
      clientId: upsellProposals.clientId,
      clientName: clients.name,
      projectId: upsellProposals.projectId,
      projectName: projects.name,
      title: upsellProposals.title,
      problemMd: upsellProposals.problemMd,
      proposalMd: upsellProposals.proposalMd,
      evidence: upsellProposals.evidence,
      suggestedPricePence: upsellProposals.suggestedPricePence,
      status: upsellProposals.status,
      insightIds: upsellProposals.insightIds,
      createdAt: upsellProposals.createdAt,
    })
    .from(upsellProposals)
    .innerJoin(clients, eq(clients.id, upsellProposals.clientId))
    .leftJoin(projects, eq(projects.id, upsellProposals.projectId))
    .where(eq(upsellProposals.orgId, orgId))
    .orderBy(desc(upsellProposals.createdAt), desc(upsellProposals.id));

  const allIds = new Set<string>();
  for (const r of rows) for (const id of eventIdsFromEvidence(r.evidence)) allIds.add(id);
  const byId = await hydrateEvidence(orgId, [...allIds]);

  return rows.map((r) => {
    const roi = r.evidence?.["expected_roi_note"];
    const evidenceEvents = eventIdsFromEvidence(r.evidence)
      .map((id) => byId.get(id))
      .filter((e): e is EvidenceEvent => e !== undefined);
    return {
      id: r.id,
      clientId: r.clientId,
      clientName: r.clientName,
      projectId: r.projectId,
      projectName: r.projectName,
      title: r.title,
      problemMd: r.problemMd,
      proposalMd: r.proposalMd,
      suggestedPricePence:
        r.suggestedPricePence === null ? null : num(r.suggestedPricePence),
      status: r.status,
      insightIds: r.insightIds,
      expectedRoiNote: typeof roi === "string" ? roi : null,
      evidenceEvents,
      createdAt: r.createdAt.toISOString(),
    };
  });
}

/** Transition a proposal's status (draft → ready → sent → won → lost). */
export async function updateProposalStatus(
  orgId: string,
  proposalId: string,
  status: ProposalStatus,
): Promise<{ id: string; status: string } | undefined> {
  const [row] = await db
    .update(upsellProposals)
    .set({ status })
    .where(and(eq(upsellProposals.orgId, orgId), eq(upsellProposals.id, proposalId)))
    .returning({ id: upsellProposals.id, status: upsellProposals.status });
  return row;
}

// ── growth summary (OS-attributed won revenue + funnel counts) ────────────────

export interface GrowthSummary {
  /** revenue attributed to the OS: sum of WON proposals' suggested prices. */
  wonRevenuePence: number;
  wonCount: number;
  openProposals: number;
  openOpportunities: number;
}

/**
 * Headline growth numbers. Won revenue is the sum of suggested prices on proposals
 * marked 'won' — the revenue the OS's opportunity engine directly generated.
 */
export async function getGrowthSummary(orgId: string): Promise<GrowthSummary> {
  const [prop] = await db
    .select({
      wonRevenue: sql<string>`coalesce(sum(${upsellProposals.suggestedPricePence}) filter (where ${upsellProposals.status} = 'won'), 0)`,
      wonCount: sql<string>`count(*) filter (where ${upsellProposals.status} = 'won')`,
      openCount: sql<string>`count(*) filter (where ${upsellProposals.status} in ('draft', 'ready', 'sent'))`,
    })
    .from(upsellProposals)
    .where(eq(upsellProposals.orgId, orgId));

  const [opp] = await db
    .select({
      openCount: sql<string>`count(*) filter (where ${insights.status} in ('new', 'reviewed'))`,
    })
    .from(insights)
    .where(
      and(
        eq(insights.orgId, orgId),
        inArray(insights.kind, ["automation_opportunity", "upsell"]),
      ),
    );

  return {
    wonRevenuePence: num(prop?.wonRevenue),
    wonCount: num(prop?.wonCount),
    openProposals: num(prop?.openCount),
    openOpportunities: num(opp?.openCount),
  };
}
