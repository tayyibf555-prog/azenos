/**
 * Upsell Engine agent (spec §9.5; docs/phase6/CONTRACTS.md §P6-GROWTH).
 *
 * runUpsellEngine converts a client's REVIEWED / HIGH-CONFIDENCE opportunity
 * insights (kind automation_opportunity | upsell) into ONE client-ready
 * `upsell_proposals` row. It builds a DETERMINISTIC pack — the source insights
 * plus the real events they cite (id, type, occurredAt), scoped to the org — and
 * passes it through the fleet chassis (runAgent, agent 'upsell_engine') with a
 * versioned prompt + the UpsellOutput zod schema. The single structured output
 * becomes a proposal row (status 'draft', insightIds = the source insights) whose
 * every claim traces back to evidence: the proposal's evidence jsonb records the
 * (hallucination-filtered) cited event ids, the source insight ids, and the
 * aggregates the agent was shown. Source insights are then marked
 * 'converted_to_upsell' so they leave the growth pipeline.
 *
 * Two entry points (§9.5): on-demand for ONE insight (the Growth "convert to
 * proposal" button → insightId), and client-wide for the Monthly Strategist
 * (clientId → every eligible insight across the client's projects).
 *
 * Graceful degradation (spec §13): with no ANTHROPIC_API_KEY the runAgent call
 * returns a typed error and NO proposal is written (never a crash). No eligible
 * source insights → ok:true with proposalId null and no model call.
 *
 * @azen/agents has no drizzle-orm dependency, so conditional reads/updates go
 * through the postgres-js client (db.$client); the insert uses db.insert(...)
 * .values, matching the Daily Brief + Scout + convo-cluster agents.
 */

import { type Db, db as defaultDb, upsellProposals } from "@azen/db";
import { z } from "zod";
import { upsellSystemPrompt } from "../prompts/upsell";
import { type AgentErrorCode, runAgent } from "../runner";

// ── output contract (docs/phase6/CONTRACTS.md §P6-GROWTH exact) ───────────────
export const upsellOutputSchema = z.object({
  title: z.string(),
  problem_md: z.string(),
  proposal_md: z.string(),
  evidence_event_ids: z.array(z.string()),
  suggested_price_pence: z.number(),
  expected_roi_note: z.string(),
});

export type UpsellOutput = z.infer<typeof upsellOutputSchema>;

// ── deterministic data pack ───────────────────────────────────────────────────

export interface UpsellEvidenceEvent {
  id: string;
  type: string;
  occurredAt: string;
}

export interface UpsellSourceInsight {
  id: string;
  projectId: string;
  kind: string;
  title: string;
  detected_md: string;
  confidence: "low" | "med" | "high";
  estimated_hours_saved_monthly: number;
  estimated_value_pence: number;
  suggested_price_band_pence: [number, number];
  evidence: UpsellEvidenceEvent[];
}

export interface UpsellPack {
  clientId: string;
  clientName: string;
  projectId: string | null;
  projectName: string | null;
  insights: UpsellSourceInsight[];
  generatedAt: string;
}

/** Cap the source opportunities folded into one proposal (prompt-size guard). */
const MAX_SOURCE_INSIGHTS = 8;
/** default max tokens for the single proposal document */
const UPSELL_MAX_TOKENS = 4000;

const num = (v: unknown): number => Number(v ?? 0);

const strArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

export interface RunUpsellEngineOptions {
  orgId: string;
  /** Convert every eligible insight across this client's projects (Strategist). */
  clientId?: string;
  /** Convert this single insight (the Growth "convert to proposal" button). */
  insightId?: string;
}

export type RunUpsellEngineResult =
  | {
      ok: true;
      /** null when no eligible source insights were found (no model call). */
      proposalId: string | null;
      /** the source insight ids folded into the proposal (and converted). */
      insightIds: string[];
      clientId: string | null;
      tokensIn: number;
      tokensOut: number;
    }
  | { ok: false; error: AgentErrorCode };

// ── source resolution ─────────────────────────────────────────────────────────

interface InsightRow {
  id: string;
  project_id: string;
  project_name: string;
  client_id: string;
  client_name: string;
  kind: string;
  title: string;
  body_md: string;
  confidence: "low" | "med" | "high";
  estimated_value_pence: number | null;
  estimated_hours_saved_monthly: number | null;
  evidence: Record<string, unknown> | null;
}

/**
 * Resolve the source insights for a run. Both entry points share the same base
 * predicate — an automation_opportunity/upsell insight, scoped to the org, that
 * has NOT already been dismissed or converted_to_upsell (so a re-run is
 * idempotent: once the first run marks the insight converted it can no longer be
 * re-loaded, and no duplicate proposal is written). The client-wide path adds the
 * §9.5 "reviewed / high-confidence" gate (owner-reviewed OR high confidence) so
 * the Strategist only folds in vetted opportunities; the single-insight path
 * omits that gate because it is an explicit, deliberate human action (the Growth
 * "convert to proposal" button) on one hand-picked opportunity.
 */
async function loadSourceInsights(
  db: Db,
  orgId: string,
  opts: { clientId?: string; insightId?: string },
): Promise<InsightRow[]> {
  const client = db.$client;
  if (opts.insightId) {
    return (await client`
      select i.id::text as id, i.project_id::text as project_id, p.name as project_name,
        c.id::text as client_id, c.name as client_name, i.kind::text as kind,
        i.title, i.body_md, i.confidence::text as confidence,
        i.estimated_value_pence, i.estimated_hours_saved_monthly, i.evidence
      from insights i
      join projects p on p.id = i.project_id
      join clients c on c.id = p.client_id
      where i.org_id = ${orgId}::uuid and i.id = ${opts.insightId}::uuid
        and i.kind in ('automation_opportunity', 'upsell')
        and i.status not in ('dismissed', 'converted_to_upsell')
      limit 1
    `) as unknown as InsightRow[];
  }
  if (opts.clientId) {
    return (await client`
      select i.id::text as id, i.project_id::text as project_id, p.name as project_name,
        c.id::text as client_id, c.name as client_name, i.kind::text as kind,
        i.title, i.body_md, i.confidence::text as confidence,
        i.estimated_value_pence, i.estimated_hours_saved_monthly, i.evidence
      from insights i
      join projects p on p.id = i.project_id
      join clients c on c.id = p.client_id
      where i.org_id = ${orgId}::uuid and c.id = ${opts.clientId}::uuid
        and i.kind in ('automation_opportunity', 'upsell')
        and i.status not in ('dismissed', 'converted_to_upsell')
        and (i.status = 'reviewed' or i.confidence = 'high')
      order by i.estimated_value_pence desc nulls last, i.created_at desc
      limit ${MAX_SOURCE_INSIGHTS}
    `) as unknown as InsightRow[];
  }
  return [];
}

interface EventRow {
  id: string;
  type: string;
  occurred_at: string;
}

/**
 * Hydrate the events cited across the source insights' evidence.event_ids into
 * lightweight rows (id, type, occurredAt), scoped to the org — so the proposal's
 * problem statement can trace to real events and hallucinated ids are dropped.
 */
async function hydrateEvidence(
  db: Db,
  orgId: string,
  ids: string[],
): Promise<Map<string, UpsellEvidenceEvent>> {
  const byId = new Map<string, UpsellEvidenceEvent>();
  if (ids.length === 0) return byId;
  const rows = (await db.$client`
    select id::text as id, type,
      to_char(occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as occurred_at
    from events
    where org_id = ${orgId}::uuid and id::text = any(${ids})
  `) as unknown as EventRow[];
  for (const r of rows) {
    byId.set(r.id, { id: r.id, type: r.type, occurredAt: r.occurred_at });
  }
  return byId;
}

function priceBandFromEvidence(evidence: Record<string, unknown> | null): [number, number] {
  const agg = (evidence?.["aggregates"] as Record<string, unknown> | undefined) ?? {};
  const band = agg["suggested_price_band_pence"];
  if (Array.isArray(band) && band.length === 2) {
    return [Math.max(0, num(band[0])), Math.max(0, num(band[1]))];
  }
  return [0, 0];
}

/**
 * Build the deterministic Upsell pack from the resolved source insights. Returns
 * null when there is nothing eligible to propose (the caller short-circuits).
 */
export async function buildUpsellPack(
  db: Db,
  orgId: string,
  opts: { clientId?: string; insightId?: string },
): Promise<UpsellPack | null> {
  const rows = await loadSourceInsights(db, orgId, opts);
  if (rows.length === 0) return null;

  // All source insights share one client (the query joins through it). The
  // proposal hangs on a single project only when every source shares it.
  const clientId = rows[0]!.client_id;
  const clientName = rows[0]!.client_name;
  const projectIds = new Set(rows.map((r) => r.project_id));
  const singleProject = projectIds.size === 1 ? rows[0]! : null;

  const citedIds = new Set<string>();
  for (const r of rows) {
    for (const id of strArray(r.evidence?.["event_ids"])) citedIds.add(id);
  }
  const byId = await hydrateEvidence(db, orgId, [...citedIds]);

  const insights: UpsellSourceInsight[] = rows.map((r) => {
    const evidence = strArray(r.evidence?.["event_ids"])
      .map((id) => byId.get(id))
      .filter((e): e is UpsellEvidenceEvent => e !== undefined);
    return {
      id: r.id,
      projectId: r.project_id,
      kind: r.kind,
      title: r.title,
      detected_md: r.body_md,
      confidence: r.confidence,
      estimated_hours_saved_monthly: num(r.estimated_hours_saved_monthly),
      estimated_value_pence: num(r.estimated_value_pence),
      suggested_price_band_pence: priceBandFromEvidence(r.evidence),
      evidence,
    };
  });

  const genRows = (await db.$client`
    select to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as iso
  `) as unknown as { iso: string }[];

  return {
    clientId,
    clientName,
    projectId: singleProject?.project_id ?? null,
    projectName: singleProject?.project_name ?? null,
    insights,
    generatedAt: genRows[0]!.iso,
  };
}

// ── run + persist ─────────────────────────────────────────────────────────────

export async function runUpsellEngine(
  db: Db,
  opts: RunUpsellEngineOptions,
): Promise<RunUpsellEngineResult> {
  const pack = await buildUpsellPack(db, opts.orgId, {
    clientId: opts.clientId,
    insightId: opts.insightId,
  });

  // Nothing eligible to propose → skip the model call entirely.
  if (!pack) {
    return {
      ok: true,
      proposalId: null,
      insightIds: [],
      clientId: null,
      tokensIn: 0,
      tokensOut: 0,
    };
  }

  const run = await runAgent<UpsellOutput>({
    agent: "upsell_engine",
    orgId: opts.orgId,
    projectId: pack.projectId,
    clientId: pack.clientId,
    systemPrompt: upsellSystemPrompt(),
    userContent: JSON.stringify(pack),
    schema: upsellOutputSchema,
    dataSnapshot: pack as unknown as Record<string, unknown>,
    maxTokens: UPSELL_MAX_TOKENS,
  });

  if (!run.ok) return { ok: false, error: run.error };

  const proposalId = await writeProposal(db, opts.orgId, pack, run.output);
  await markConverted(db, opts.orgId, pack.insights.map((i) => i.id));

  return {
    ok: true,
    proposalId,
    insightIds: pack.insights.map((i) => i.id),
    clientId: pack.clientId,
    tokensIn: run.tokensIn,
    tokensOut: run.tokensOut,
  };
}

/** Every real event id present anywhere in the pack (for hallucination filtering). */
function collectPackEventIds(pack: UpsellPack): Set<string> {
  const ids = new Set<string>();
  for (const ins of pack.insights) for (const e of ins.evidence) ids.add(e.id);
  return ids;
}

/**
 * Persist the proposal (status 'draft'). Cited event ids are filtered to those
 * actually in the pack (drop hallucinations); the evidence jsonb records the
 * traced event ids, the source insight ids, and the aggregates the agent saw so
 * a reviewer can verify every claim. Price is clamped non-negative integer pence.
 */
async function writeProposal(
  db: Db,
  orgId: string,
  pack: UpsellPack,
  output: UpsellOutput,
): Promise<string> {
  const validIds = collectPackEventIds(pack);
  const eventIds = output.evidence_event_ids.filter((id) => validIds.has(id));
  const insightIds = pack.insights.map((i) => i.id);
  const price = Math.max(0, Math.round(output.suggested_price_pence));

  const evidence: Record<string, unknown> = {
    event_ids: eventIds,
    insight_ids: insightIds,
    expected_roi_note: output.expected_roi_note,
    aggregates: {
      estimated_hours_saved_monthly: pack.insights.reduce(
        (s, i) => s + i.estimated_hours_saved_monthly,
        0,
      ),
      estimated_value_pence: pack.insights.reduce(
        (s, i) => s + i.estimated_value_pence,
        0,
      ),
    },
  };

  const [row] = await db
    .insert(upsellProposals)
    .values({
      orgId,
      clientId: pack.clientId,
      projectId: pack.projectId,
      title: output.title,
      problemMd: output.problem_md,
      proposalMd: output.proposal_md,
      evidence,
      suggestedPricePence: price,
      status: "draft",
      insightIds,
    })
    .returning({ id: upsellProposals.id });

  return row!.id;
}

/**
 * Mark the source insights 'converted_to_upsell' so they leave the growth
 * pipeline once a proposal has been drafted from them. Idempotent — a re-run over
 * already-converted insights is a no-op (the eligibility filter excludes them).
 */
async function markConverted(db: Db, orgId: string, insightIds: string[]): Promise<void> {
  if (insightIds.length === 0) return;
  await db.$client`
    update insights set status = 'converted_to_upsell'
    where org_id = ${orgId}::uuid and id::text = any(${insightIds})
  `;
}

/** Convenience for the CLI / cron: run against the default pooled db. */
export function runUpsellEngineDefault(
  opts: RunUpsellEngineOptions,
): Promise<RunUpsellEngineResult> {
  return runUpsellEngine(defaultDb, opts);
}
