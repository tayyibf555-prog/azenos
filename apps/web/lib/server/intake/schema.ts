import { z } from "zod";
import { projectStack, projectType } from "@azen/db";
import { getTrackingPlan, type TrackingPreset } from "../../tracking-presets";

/**
 * Transcript-intake wire contract (docs/phase2/CONTRACTS.md §Transcript
 * intake). This is the shape shared by the agent, the refine loop, and the UI.
 *
 * Server-only module (imports @azen/db for the drizzle enum values). Client
 * components consume the exported TYPES via `import type` only — type-only
 * imports are erased before bundling, so no server code is pulled client-side.
 *
 * zodOutputFormat restriction: DO NOT add min/max/length constraints to the
 * schema handed to the API (the helper already forbids `additionalProperties`
 * and chokes on numeric bounds). Length caps (name ≤200, ≤5 goals, …) are
 * enforced in `finalizeDraft` / route validation instead.
 */

export const projectDraftSchema = z.object({
  name: z.string(), // client-facing project name, ≤200 chars (capped in finalizeDraft)
  client: z.object({
    match: z.enum(["existing", "new"]),
    clientId: z.string().nullable(), // uuid when match=existing, else null
    name: z.string(),
    industrySlug: z.string().nullable(), // kebab-case, e.g. "dental"
  }),
  type: z.enum(projectType.enumValues),
  stack: z.enum(projectStack.enumValues),
  description: z.string(), // 1-2 sentences, client-facing
  retainerPenceMonthly: z.number().int().nullable(),
  buildFeePence: z.number().int().nullable(),
  hourlyRatePence: z.number().int().nullable(),
  goals: z.array(
    z.object({
      metric: z.string(), // a §8.1 metric key (see GOAL_METRICS)
      target: z.number(),
      period: z.enum(["day", "week", "month"]),
    }),
  ), // ≤5 (capped in finalizeDraft)
  suggestedEventTypes: z.array(z.string()), // from the 41-type taxonomy
  assumptions: z.array(z.string()), // every value the agent inferred / is unsure of
});

export type ProjectDraft = z.infer<typeof projectDraftSchema>;

/**
 * Refine wraps the draft with a one-sentence change note (second zod field per
 * contract). The agent returns the FULL updated draft, never a diff.
 */
export const refineOutputSchema = z.object({
  draft: projectDraftSchema,
  note: z.string(),
});

export type RefineOutput = z.infer<typeof refineOutputSchema>;

// ── HTTP response shapes (client-safe types) ────────────────────────────────

export interface IntakeResponse {
  draft: ProjectDraft;
  runId: string;
  /** The baseline tracking plan for `draft.type` (task T1) — attached so the
   * review UI can show "we'll track these N events" without a second call. */
  trackingPlan: TrackingPreset;
}

export interface RefineResponse {
  draft: ProjectDraft;
  note: string;
  runId: string;
  trackingPlan: TrackingPreset;
}

/** Shared by both intake routes: attach the preset for the drafted type. */
export function trackingPlanForDraft(draft: ProjectDraft): TrackingPreset {
  return getTrackingPlan(draft.type);
}

// ── §8.1 goal metric keys the agent may target ──────────────────────────────
// Mirrors the seeded metric_definitions globals + M1's additions. The intake
// agent is instructed to pick goal.metric from these keys only.

export const GOAL_METRICS: ReadonlyArray<{ key: string; label: string }> = [
  { key: "events_total", label: "Events per day" },
  { key: "conversations", label: "Conversations per day" },
  { key: "bookings_created", label: "Bookings created" },
  { key: "leads_created", label: "Leads created" },
  { key: "forms_submitted", label: "Forms submitted" },
  { key: "calls_handled", label: "Calls handled" },
  { key: "quotes_sent", label: "Quotes sent" },
  { key: "revenue_attributed", label: "Revenue attributed (pence)" },
  { key: "payments_captured", label: "Payments captured" },
  { key: "avg_transaction_pence", label: "Average transaction value (pence)" },
  { key: "minutes_saved", label: "Minutes saved" },
  { key: "agent_runs", label: "Agent runs" },
  { key: "agent_runs_succeeded", label: "Agent runs succeeded" },
  { key: "escalations", label: "Escalations to a human" },
  { key: "tokens_cost_pence", label: "AI token cost (pence)" },
  { key: "reviews_avg_rating", label: "Average review rating" },
  { key: "errors", label: "System errors" },
] as const;

// ── normalization + server-side guards ──────────────────────────────────────

export interface ClientRef {
  id: string;
  name: string;
  industrySlug: string | null;
}

/**
 * Server-side client-match guard (contract): a `clientId` the model invented,
 * or one not in this org's client list, is untrustworthy — fall back to a new
 * client. A `new` match never carries a clientId.
 */
export function coerceClientMatch(
  draft: ProjectDraft,
  knownClients: ReadonlyArray<{ id: string }>,
): ProjectDraft {
  const known = new Set(knownClients.map((c) => c.id));
  const c = draft.client;
  if (c.match === "existing" && (c.clientId === null || !known.has(c.clientId))) {
    return { ...draft, client: { ...c, match: "new", clientId: null } };
  }
  if (c.match === "new" && c.clientId !== null) {
    return { ...draft, client: { ...c, clientId: null } };
  }
  return draft;
}

/** Enforce the length caps the API schema can't carry, then apply the guard. */
export function finalizeDraft(
  draft: ProjectDraft,
  knownClients: ReadonlyArray<{ id: string }>,
): ProjectDraft {
  const capped: ProjectDraft = {
    ...draft,
    name: draft.name.slice(0, 200),
    client: { ...draft.client, name: draft.client.name.slice(0, 200) },
    description: draft.description.slice(0, 2000),
    goals: draft.goals.slice(0, 5),
    suggestedEventTypes: [...new Set(draft.suggestedEventTypes)].slice(0, 41),
    assumptions: draft.assumptions.slice(0, 20),
  };
  return coerceClientMatch(capped, knownClients);
}
