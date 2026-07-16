import { EVENT_TYPES, type KnownEventType } from "@azen/events";

/**
 * Tracking plan presets (Phase 7 task T1 — this file is the binding spec;
 * docs/phase7/PLAN.md predates it and has no tracking-plan section).
 *
 * Owner decision: presets are the baseline; the intake co-pilot tailors them
 * per project (see lib/server/intake); the Scout polices drift over time.
 * This module stays pure and deterministic — no server imports, safe to use
 * from both server code (Setup tab) and client components (intake review UI).
 *
 * Every event name below is a REAL key of eventDataSchemas (packages/events'
 * taxonomy) — enforced at build time by the `KnownEventType` typing and
 * pinned forever by test/tracking-plan/presets.test.ts, which asserts every
 * preset type is a member of EVENT_TYPES.
 */

export type ProjectTypeKey =
  | "voice_agent"
  | "chatbot"
  | "automation"
  | "ai_agent"
  | "crm_setup"
  | "website"
  | "custom";

export interface TrackingPreset {
  /** Types the project SHOULD send if it's doing its job — drives the "N/M required" chip. */
  required: readonly KnownEventType[];
  /** Nice-to-have types that unlock extra metrics/insights but aren't load-bearing. */
  recommended: readonly KnownEventType[];
}

// Universal core: every project — no matter how bespoke — benefits from these.
const UNIVERSAL_RECOMMENDED: readonly KnownEventType[] = [
  "system.error",
  "agent.heartbeat",
  "feedback.submitted",
];

/**
 * Cost telemetry guidance (P9-COST). When a client's OWN system runs AI/API
 * work, it SHOULD send `agent.run.completed` events carrying:
 *   - `data.provider`   — 'anthropic' | 'openai' | 'twilio' | 'higgsfield' | …
 *   - `data.cost_pence` — integer pence spent on that run
 *   - `data.tokens_in` / `data.tokens_out` — token counts (optional)
 * These power the API Cost & Usage analytics section's client-emitted stream,
 * the per-provider cost-statement line items, and the cost-spike health rule.
 * Without them a client's own key spend is invisible to the OS (OS agent_runs
 * are still tracked automatically). Advisory only — never load-bearing.
 */
export const COST_TELEMETRY_GUIDANCE = {
  eventType: "agent.run.completed" as KnownEventType,
  recommendedFields: ["provider", "cost_pence", "tokens_in", "tokens_out"] as const,
} as const;

export const TRACKING_PRESETS: Record<ProjectTypeKey, TrackingPreset> = {
  voice_agent: {
    required: [
      "llm.conversation",
      "call.completed",
      "agent.escalated_to_human",
      "booking.created",
    ],
    recommended: [
      "booking.completed",
      "booking.no_show",
      "message.sent",
      ...UNIVERSAL_RECOMMENDED,
    ],
  },

  chatbot: {
    required: [
      "llm.conversation",
      "message.received",
      "message.sent",
      "lead.created",
      "agent.escalated_to_human",
    ],
    recommended: ["form.submitted", ...UNIVERSAL_RECOMMENDED],
  },

  automation: {
    required: ["workflow.run", "task.completed", "system.error"],
    recommended: [
      "document.generated",
      "agent.run.completed",
      "agent.heartbeat",
      "feedback.submitted",
    ],
  },

  ai_agent: {
    required: [
      "agent.run.started",
      "agent.run.completed",
      "agent.heartbeat",
      "llm.conversation",
    ],
    recommended: [
      "agent.run.failed",
      "agent.escalated_to_human",
      "agent.feedback",
      "task.completed",
      "system.error",
      "feedback.submitted",
    ],
  },

  crm_setup: {
    required: [
      "lead.created",
      "lead.stage_changed",
      "lead.converted",
      "form.submitted",
    ],
    recommended: [
      "lead.qualified",
      "lead.lost",
      "email.sent",
      "email.opened",
      "quote.sent",
      "quote.accepted",
      "feedback.submitted",
    ],
  },

  website: {
    required: ["form.submitted", "lead.created"],
    recommended: [
      "order.created",
      "order.fulfilled",
      "payment.captured",
      "email.sent",
      "feedback.submitted",
    ],
  },

  // Bespoke builds: nothing is REQUIRED (we don't know the shape of the
  // integration up front) — only the universal core is recommended.
  custom: {
    required: [],
    recommended: [...UNIVERSAL_RECOMMENDED],
  },
} as const;

function isProjectTypeKey(type: string): type is ProjectTypeKey {
  return Object.prototype.hasOwnProperty.call(TRACKING_PRESETS, type);
}

/** Resolve a project's preset; unrecognised types fall back to `custom`. */
export function getTrackingPlan(projectType: string): TrackingPreset {
  return isProjectTypeKey(projectType)
    ? TRACKING_PRESETS[projectType]
    : TRACKING_PRESETS.custom;
}

// ── coverage ─────────────────────────────────────────────────────────────────

export interface CoverageItem {
  type: string;
  required: boolean;
  present: boolean;
}

export interface CoverageResult {
  /** required types first (plan order), then recommended — de-duplicated. */
  items: CoverageItem[];
  requiredTotal: number;
  requiredPresent: number;
}

/**
 * Pure: given a tracking plan and the set of event types actually present
 * for a project (e.g. `select distinct type from events where project_id=…`),
 * compute per-type coverage plus the "N/M required" summary. No I/O — safe
 * to unit test with hand-built inputs and reuse from the Setup tab card.
 */
export function coveragePlan(
  plan: TrackingPreset,
  presentTypes: ReadonlySet<string> | readonly string[],
): CoverageResult {
  const present =
    presentTypes instanceof Set ? presentTypes : new Set(presentTypes);
  const seen = new Set<string>();
  const items: CoverageItem[] = [];

  for (const type of plan.required) {
    if (seen.has(type)) continue;
    seen.add(type);
    items.push({ type, required: true, present: present.has(type) });
  }
  for (const type of plan.recommended) {
    if (seen.has(type)) continue;
    seen.add(type);
    items.push({ type, required: false, present: present.has(type) });
  }

  const requiredTypes = new Set(plan.required);
  const requiredTotal = requiredTypes.size;
  let requiredPresent = 0;
  for (const type of requiredTypes) {
    if (present.has(type)) requiredPresent += 1;
  }

  return { items, requiredTotal, requiredPresent };
}

// Re-export so callers pinning against reality don't need a second import.
export { EVENT_TYPES };
export type { KnownEventType };
