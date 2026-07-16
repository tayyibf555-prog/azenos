import {
  clients,
  db,
  events,
  insights,
  organizations,
  projects,
  shareTokens,
  upsellProposals,
} from "@azen/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { createShareToken, type ResolvedShare } from "./share";

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
  /** Phase 8 §P8-GROWTH2 — the latest `proposal` share token's stats, if the
   * proposal has ever been sent (0 / null when it hasn't). */
  viewCount: number;
  lastViewedAt: string | null;
  /** Latest `proposal` share token id (null if never sent) — lets the owner
   * re-display the link via the org-scoped decrypt endpoint. NEVER the token. */
  shareTokenId: string | null;
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

interface ShareStat {
  tokenId: string;
  viewCount: number;
  lastViewedAt: string | null;
}

/**
 * The latest `proposal` share token's view stats per proposal id, batched (no
 * N+1) — powers the board's "viewed Nx · last seen" chip (P8-GROWTH2). A
 * proposal normally has at most one send/token, but if it were ever re-sent
 * only the newest token's stats surface.
 */
async function latestProposalShareStats(
  orgId: string,
  proposalIds: string[],
): Promise<Map<string, ShareStat>> {
  const byId = new Map<string, ShareStat>();
  if (proposalIds.length === 0) return byId;
  const rows = await db
    .select({
      id: shareTokens.id,
      proposalId: shareTokens.proposalId,
      viewCount: shareTokens.viewCount,
      lastViewedAt: shareTokens.lastViewedAt,
    })
    .from(shareTokens)
    .where(
      and(
        eq(shareTokens.orgId, orgId),
        eq(shareTokens.kind, "proposal"),
        inArray(shareTokens.proposalId, proposalIds),
      ),
    )
    .orderBy(desc(shareTokens.createdAt));
  for (const r of rows) {
    if (!r.proposalId || byId.has(r.proposalId)) continue; // newest-first: first wins
    byId.set(r.proposalId, {
      tokenId: r.id,
      viewCount: r.viewCount,
      lastViewedAt: r.lastViewedAt ? r.lastViewedAt.toISOString() : null,
    });
  }
  return byId;
}

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
  const shareStats = await latestProposalShareStats(orgId, rows.map((r) => r.id));

  return rows.map((r) => {
    const roi = r.evidence?.["expected_roi_note"];
    const evidenceEvents = eventIdsFromEvidence(r.evidence)
      .map((id) => byId.get(id))
      .filter((e): e is EvidenceEvent => e !== undefined);
    const stat = shareStats.get(r.id);
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
      viewCount: stat?.viewCount ?? 0,
      lastViewedAt: stat?.lastViewedAt ?? null,
      shareTokenId: stat?.tokenId ?? null,
    };
  });
}

/**
 * "Send" a ready proposal (P8-GROWTH2): mints a `proposal` share token —
 * reusing P8-REPORT's `createShareToken` core (never re-implemented here,
 * per the file-ownership contract) — then flips the proposal to 'sent'. Only
 * a currently-'ready' proposal may be sent; a bare status PATCH to 'sent'
 * without minting a link would leave the client with nothing to open, so
 * this is the ONE path the board offers into 'sent'.
 */
export type SendProposalResult =
  | { ok: true; token: string; proposal: { id: string; status: "sent" } }
  | { ok: false; error: "not_found" | "invalid_status" | "enc_key_missing" };

export async function sendProposal(
  orgId: string,
  proposalId: string,
): Promise<SendProposalResult> {
  // Atomically CLAIM the proposal: the status guard lives in the UPDATE's WHERE
  // (not a prior read), so the ready→sent flip is the single point of decision.
  // Postgres row-locks the row for the duration of the UPDATE, serialising two
  // concurrent sends — exactly one matches `status = 'ready'` and flips it; the
  // loser re-evaluates against the now-'sent' row and matches zero. That closes
  // the read-then-write TOCTOU that let both sends mint a token (there is no
  // unique constraint on share_tokens.proposal_id) and both advance status.
  const [claimed] = await db
    .update(upsellProposals)
    .set({ status: "sent" })
    .where(
      and(
        eq(upsellProposals.orgId, orgId),
        eq(upsellProposals.id, proposalId),
        eq(upsellProposals.status, "ready"),
      ),
    )
    .returning({ id: upsellProposals.id });

  // Zero rows flipped: either the proposal isn't ours / no longer exists, or it
  // wasn't 'ready' (already sent, a concurrent send won the race, or draft/won/
  // lost). Distinguish the two so the route maps them to 404 vs 409 correctly.
  if (!claimed) {
    const exists = await db.query.upsellProposals.findFirst({
      where: and(eq(upsellProposals.orgId, orgId), eq(upsellProposals.id, proposalId)),
      columns: { id: true },
    });
    return { ok: false, error: exists ? "invalid_status" : "not_found" };
  }

  const shared = await createShareToken(orgId, { kind: "proposal", proposalId });
  if (!shared.ok) {
    // We already flipped ready→sent but couldn't mint the link — a 'sent'
    // proposal with nothing to open is worse than not sending, so undo the flip
    // (only if it's still the 'sent' we set) and report the mint failure. A
    // missing encryption key surfaces distinctly so the route can 503 (config),
    // not 404 (a genuinely absent proposal).
    await db
      .update(upsellProposals)
      .set({ status: "ready" })
      .where(
        and(
          eq(upsellProposals.orgId, orgId),
          eq(upsellProposals.id, proposalId),
          eq(upsellProposals.status, "sent"),
        ),
      );
    return {
      ok: false,
      error: shared.error === "enc_key_missing" ? "enc_key_missing" : "not_found",
    };
  }

  return {
    ok: true,
    token: shared.token,
    proposal: { id: proposalId, status: "sent" },
  };
}

// ── public artifact view model for the shared proposal doc ────────────────────
// (P8-GROWTH2 reuses P8-REPORT's ShareShell + resolveShareToken; this is the
// ONE additional load* needed for kind='proposal', kept here rather than in
// share.ts to respect the file-ownership boundary — ResolvedShare is a
// type-only import, no runtime edit to share.ts.)

export interface SharedProposalDoc {
  agencyName: string;
  clientName: string;
  title: string;
  problemMd: string;
  proposalMd: string;
  suggestedPricePence: number | null;
  status: string;
  createdAt: string;
}

/**
 * Load the white-label view model for a resolved `proposal` share token.
 * White-label-safe: only the agency/client NAMES and the proposal's own
 * client-ready copy + price escape — no org ids, no insight ids, no evidence
 * event payload.
 */
export async function loadSharedProposal(
  resolved: ResolvedShare,
): Promise<SharedProposalDoc | null> {
  if (resolved.kind !== "proposal" || !resolved.proposalId) return null;

  const [org, proposal] = await Promise.all([
    db.query.organizations.findFirst({
      where: eq(organizations.id, resolved.orgId),
      columns: { name: true },
    }),
    db
      .select({
        title: upsellProposals.title,
        problemMd: upsellProposals.problemMd,
        proposalMd: upsellProposals.proposalMd,
        suggestedPricePence: upsellProposals.suggestedPricePence,
        status: upsellProposals.status,
        createdAt: upsellProposals.createdAt,
        clientName: clients.name,
      })
      .from(upsellProposals)
      .innerJoin(clients, eq(clients.id, upsellProposals.clientId))
      .where(
        and(
          eq(upsellProposals.id, resolved.proposalId),
          eq(upsellProposals.orgId, resolved.orgId),
        ),
      )
      .limit(1)
      .then((r) => r[0]),
  ]);

  if (!proposal) return null;

  return {
    agencyName: org?.name ?? "Your Agency",
    clientName: proposal.clientName,
    title: proposal.title,
    problemMd: proposal.problemMd,
    proposalMd: proposal.proposalMd,
    suggestedPricePence:
      proposal.suggestedPricePence === null ? null : num(proposal.suggestedPricePence),
    status: proposal.status,
    createdAt: proposal.createdAt.toISOString(),
  };
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
