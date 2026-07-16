/**
 * Metric discovery catalog (Phase 9 §P9-W0B — Metric discovery: presets +
 * webhook-driven availability).
 *
 * A static, pure mapping from DATA SIGNALS (event types actually seen for a
 * project, plus whether the envelope's `value_pence` / `minutes_saved`
 * fields are populated) to METRIC TEMPLATES the project could add with one
 * click. No server imports — safe to unit test with hand-built signal maps
 * and safe to import from client components (mirrors lib/tracking-presets.ts).
 *
 * Every template is a ready-to-POST body for the EXISTING
 * `/api/projects/[projectId]/metrics` create endpoint — discovery never
 * introduces a new write path. Where a template's key matches one of the
 * §8.1 default KPI pack keys (packages/db/src/seed/demo-data.ts
 * DEFAULT_METRIC_DEFINITIONS — seeded only for the demo org, NOT for real
 * projects), that's deliberate: it lets a real project "catch up" to the
 * standard pack once its data proves the signal is live, and lets the demo
 * org correctly show that metric as already enabled (dedup by key).
 *
 * A note on percentage-shaped templates (resolution %, escalation %,
 * no-show %, reschedule %, bug share): the generic metric-definitions engine
 * (packages/db/src/rollup/metric-sql.ts) has no built-in ratio support — a
 * single definition row can only COUNT/SUM/AVG/P95/LAST matching rows, never
 * divide one series by another (that's why the three baked-in ratios —
 * agent_success_rate, escalation_rate, no_show_rate — are hand-coded in
 * lib/server/queries.ts DERIVED_METRICS instead of ordinary rows). The
 * "rate" aggregation already exposed in the Add-metric form behaves
 * identically to "count" with the same whereEquals filter applied
 * (aggregateValueSQL's "rate" branch = count(*)). Templates below use it as
 * a lightweight, already-shipped proxy for "how often did X happen" — not a
 * new capability, just a preset applying an existing one.
 */

export type MetricAggregation = "sum" | "count" | "avg" | "p95" | "last" | "rate";
export type MetricUnit = "count" | "pence" | "minutes" | "percent" | "ms";
export type GoodDirection = "up" | "down";

export interface MetricTemplate {
  /** Candidate metric_definitions.key — stable, matches KEY_RE in AddMetricModal. */
  key: string;
  name: string;
  description: string;
  eventType: string;
  aggregation: MetricAggregation;
  unit: MetricUnit;
  valuePath: string | null;
  whereEquals: Record<string, string | number | boolean> | null;
  goodDirection: GoodDirection;
  isKpi: boolean;
}

/** Per-event-type signal from a single scan of this project's events. */
export interface EventTypeSignal {
  type: string;
  /** Row count for this type (drives the "seen N×" evidence string). */
  count: number;
  hasValuePence: boolean;
  hasMinutesSaved: boolean;
}

/**
 * One condition a signal group needs satisfied: at least one of `anyOf`'s
 * event types must be present, and — if set — at least one of the PRESENT
 * `anyOf` types must additionally carry `value_pence` / `minutes_saved`.
 */
export interface SignalRequirement {
  anyOf: readonly string[];
  requireValuePence?: boolean;
  requireMinutesSaved?: boolean;
}

export interface MetricSignalGroup {
  id: string;
  /** All requirements must hold (AND); within one requirement, anyOf is OR. */
  requirements: readonly SignalRequirement[];
  templates: readonly MetricTemplate[];
}

export interface DiscoveredMetric extends MetricTemplate {
  groupId: string;
  /** Human evidence, e.g. "payment.captured seen 214×". */
  why: string;
}

function presentAnyOf(
  req: SignalRequirement,
  signals: ReadonlyMap<string, EventTypeSignal>,
): EventTypeSignal[] {
  const present: EventTypeSignal[] = [];
  for (const type of req.anyOf) {
    const sig = signals.get(type);
    if (sig) present.push(sig);
  }
  return present;
}

/** Does a single requirement hold against the observed signals? */
function requirementHolds(
  req: SignalRequirement,
  signals: ReadonlyMap<string, EventTypeSignal>,
): EventTypeSignal | null {
  const present = presentAnyOf(req, signals);
  if (present.length === 0) return null;
  if (req.requireValuePence) {
    const withField = present.find((s) => s.hasValuePence);
    return withField ?? null;
  }
  if (req.requireMinutesSaved) {
    const withField = present.find((s) => s.hasMinutesSaved);
    return withField ?? null;
  }
  // Anchor evidence on the highest-volume present type.
  return present.reduce((a, b) => (b.count > a.count ? b : a));
}

function requirementEvidence(req: SignalRequirement, sig: EventTypeSignal): string {
  const suffix = req.requireValuePence
    ? " with value_pence set"
    : req.requireMinutesSaved
      ? " with minutes_saved set"
      : "";
  return `${sig.type} seen ${sig.count}×${suffix}`;
}

/**
 * Pure match: null when the group's data condition isn't (yet) met,
 * otherwise the combined evidence string for every requirement that fired.
 */
export function matchGroup(
  group: MetricSignalGroup,
  signals: ReadonlyMap<string, EventTypeSignal>,
): { why: string } | null {
  const evidences: string[] = [];
  for (const req of group.requirements) {
    const hit = requirementHolds(req, signals);
    if (!hit) return null;
    evidences.push(requirementEvidence(req, hit));
  }
  return { why: evidences.join(" · ") };
}

/** Every concrete event type a group cares about (for preset/core resolution). */
function signalTypesOf(group: MetricSignalGroup): string[] {
  const set = new Set<string>();
  for (const req of group.requirements) for (const t of req.anyOf) set.add(t);
  return [...set];
}

// ── catalog ──────────────────────────────────────────────────────────────────

export const METRIC_CATALOG: readonly MetricSignalGroup[] = [
  {
    id: "payment_value",
    requirements: [
      {
        anyOf: ["payment.captured", "payment.refunded", "payment.failed"],
        requireValuePence: true,
      },
    ],
    templates: [
      {
        key: "revenue_attributed",
        name: "Revenue attributed",
        description: "Sum of value_pence across every event this project sends.",
        eventType: "*",
        aggregation: "sum",
        unit: "pence",
        valuePath: "$.value_pence",
        whereEquals: null,
        goodDirection: "up",
        isKpi: true,
      },
      {
        key: "avg_transaction_pence",
        name: "Avg transaction value",
        description: "Average amount_pence per captured payment.",
        eventType: "payment.captured",
        aggregation: "avg",
        unit: "pence",
        valuePath: "$.data.amount_pence",
        whereEquals: null,
        goodDirection: "up",
        isKpi: false,
      },
    ],
  },

  {
    id: "conversations",
    requirements: [{ anyOf: ["llm.conversation"] }],
    templates: [
      {
        key: "conversations",
        name: "Conversations",
        description: "Count of llm.conversation events.",
        eventType: "llm.conversation",
        aggregation: "count",
        unit: "count",
        valuePath: null,
        whereEquals: null,
        goodDirection: "up",
        isKpi: true,
      },
      {
        key: "conversation_resolved_rate",
        name: "Resolved without escalation",
        description: "Conversations whose resolution field is \"resolved\".",
        eventType: "llm.conversation",
        aggregation: "rate",
        unit: "percent",
        valuePath: null,
        whereEquals: { "$.data.resolution": "resolved" },
        goodDirection: "up",
        isKpi: false,
      },
      {
        key: "conversation_escalated_rate",
        name: "Conversations escalated",
        description: "Conversations whose resolution field is \"escalated\".",
        eventType: "llm.conversation",
        aggregation: "rate",
        unit: "percent",
        valuePath: null,
        whereEquals: { "$.data.resolution": "escalated" },
        goodDirection: "down",
        isKpi: false,
      },
      {
        key: "conversation_avg_turns",
        name: "Avg turns per conversation",
        description: "Average of the turns field on llm.conversation events.",
        eventType: "llm.conversation",
        aggregation: "avg",
        unit: "count",
        valuePath: "$.data.turns",
        whereEquals: null,
        goodDirection: "down",
        isKpi: false,
      },
    ],
  },

  {
    id: "bookings",
    requirements: [
      {
        anyOf: [
          "booking.created",
          "booking.rescheduled",
          "booking.cancelled",
          "booking.completed",
          "booking.no_show",
        ],
      },
    ],
    templates: [
      {
        key: "bookings_created",
        name: "Bookings created",
        description: "Count of booking.created events.",
        eventType: "booking.created",
        aggregation: "count",
        unit: "count",
        valuePath: null,
        whereEquals: null,
        goodDirection: "up",
        isKpi: true,
      },
      {
        key: "booking_no_show_count",
        name: "No-shows",
        description: "Count of booking.no_show events.",
        eventType: "booking.no_show",
        aggregation: "rate",
        unit: "percent",
        valuePath: null,
        whereEquals: null,
        goodDirection: "down",
        isKpi: false,
      },
      {
        key: "booking_reschedule_rate",
        name: "Reschedules",
        description: "Count of booking.rescheduled events.",
        eventType: "booking.rescheduled",
        aggregation: "rate",
        unit: "percent",
        valuePath: null,
        whereEquals: null,
        goodDirection: "down",
        isKpi: false,
      },
    ],
  },

  {
    id: "agent_runs",
    requirements: [{ anyOf: ["agent.run.completed"] }],
    templates: [
      {
        key: "agent_runs",
        name: "Agent runs",
        description: "Count of agent.run.completed events.",
        eventType: "agent.run.completed",
        aggregation: "count",
        unit: "count",
        valuePath: null,
        whereEquals: null,
        goodDirection: "up",
        isKpi: false,
      },
      {
        key: "agent_runs_succeeded",
        name: "Agent runs succeeded",
        description: "agent.run.completed events where data.success is true.",
        eventType: "agent.run.completed",
        aggregation: "count",
        unit: "count",
        valuePath: null,
        whereEquals: { "$.data.success": true },
        goodDirection: "up",
        isKpi: false,
      },
      {
        key: "agent_run_p95_ms",
        name: "Run duration (p95)",
        description: "95th-percentile duration_ms across agent runs.",
        eventType: "agent.run.completed",
        aggregation: "p95",
        unit: "ms",
        valuePath: "$.data.duration_ms",
        whereEquals: null,
        goodDirection: "down",
        isKpi: false,
      },
      {
        key: "tokens_cost_pence",
        name: "Tokens cost",
        description: "Sum of data.cost_pence across agent runs (client-emitted).",
        eventType: "agent.run.completed",
        aggregation: "sum",
        unit: "pence",
        valuePath: "$.data.cost_pence",
        whereEquals: null,
        goodDirection: "down",
        isKpi: false,
      },
    ],
  },

  {
    id: "minutes_saved",
    requirements: [
      {
        anyOf: [
          "agent.run.completed",
          "task.completed",
          "workflow.run",
          "llm.conversation",
          "call.completed",
        ],
        requireMinutesSaved: true,
      },
    ],
    templates: [
      {
        key: "minutes_saved",
        name: "Minutes saved",
        description: "Sum of the envelope's minutes_saved field across every event.",
        eventType: "*",
        aggregation: "sum",
        unit: "minutes",
        valuePath: "$.minutes_saved",
        whereEquals: null,
        goodDirection: "up",
        isKpi: true,
      },
    ],
  },

  {
    id: "agent_feedback",
    requirements: [{ anyOf: ["agent.feedback"] }],
    templates: [
      {
        key: "agent_feedback_avg_rating",
        name: "Avg agent feedback rating",
        description: "Average of the 1-5 rating field on agent.feedback events.",
        eventType: "agent.feedback",
        aggregation: "avg",
        unit: "count",
        valuePath: "$.data.rating",
        whereEquals: null,
        goodDirection: "up",
        isKpi: false,
      },
    ],
  },

  {
    id: "feedback_submitted",
    requirements: [{ anyOf: ["feedback.submitted"] }],
    templates: [
      {
        key: "feedback_volume",
        name: "Feedback submitted",
        description: "Count of feedback.submitted events (the public widget).",
        eventType: "feedback.submitted",
        aggregation: "count",
        unit: "count",
        valuePath: null,
        whereEquals: null,
        goodDirection: "up",
        isKpi: false,
      },
      {
        key: "feedback_bug_rate",
        name: "Bug reports",
        description: "feedback.submitted events where kind is \"bug\".",
        eventType: "feedback.submitted",
        aggregation: "rate",
        unit: "percent",
        valuePath: null,
        whereEquals: { "$.data.kind": "bug" },
        goodDirection: "down",
        isKpi: false,
      },
    ],
  },

  {
    id: "leads",
    requirements: [
      {
        anyOf: [
          "lead.created",
          "lead.qualified",
          "lead.stage_changed",
          "lead.converted",
          "lead.lost",
        ],
      },
    ],
    templates: [
      {
        key: "leads_created",
        name: "Leads created",
        description: "Count of lead.created events.",
        eventType: "lead.created",
        aggregation: "count",
        unit: "count",
        valuePath: null,
        whereEquals: null,
        goodDirection: "up",
        isKpi: false,
      },
    ],
  },

  {
    id: "funnel_conversion",
    requirements: [
      {
        anyOf: [
          "lead.created",
          "lead.qualified",
          "lead.stage_changed",
          "lead.converted",
          "lead.lost",
        ],
      },
      { anyOf: ["payment.captured", "payment.refunded", "payment.failed"] },
    ],
    templates: [
      {
        key: "funnel_leads_converted",
        name: "Leads converted (funnel)",
        description: "Count of lead.converted events — the funnel's paying-customer step.",
        eventType: "lead.converted",
        aggregation: "count",
        unit: "count",
        valuePath: null,
        whereEquals: null,
        goodDirection: "up",
        isKpi: false,
      },
    ],
  },

  {
    id: "messages",
    requirements: [{ anyOf: ["message.sent", "message.received"] }],
    templates: [
      {
        key: "messages_sent",
        name: "Messages sent",
        description: "Count of message.sent events.",
        eventType: "message.sent",
        aggregation: "count",
        unit: "count",
        valuePath: null,
        whereEquals: null,
        goodDirection: "up",
        isKpi: false,
      },
      {
        key: "messages_received",
        name: "Messages received",
        description: "Count of message.received events.",
        eventType: "message.received",
        aggregation: "count",
        unit: "count",
        valuePath: null,
        whereEquals: null,
        goodDirection: "up",
        isKpi: false,
      },
    ],
  },
] as const;

/**
 * The metric templates relevant to a project of this type, per its
 * TRACKING_PRESETS entry — a reference list independent of whether the data
 * or the metric_definitions row exists yet (contract: "core: [per
 * TRACKING_PRESETS projectType]"). Callers supply the preset's event types
 * (required ∪ recommended) rather than importing tracking-presets here, to
 * keep this module dependency-free and independently testable.
 */
export function coreTemplatesForPlanTypes(planTypes: ReadonlySet<string>): DiscoveredMetric[] {
  const out: DiscoveredMetric[] = [];
  const seenKeys = new Set<string>();
  for (const group of METRIC_CATALOG) {
    const overlaps = signalTypesOf(group).some((t) => planTypes.has(t));
    if (!overlaps) continue;
    for (const tpl of group.templates) {
      if (seenKeys.has(tpl.key)) continue;
      seenKeys.add(tpl.key);
      out.push({ ...tpl, groupId: group.id, why: "core metric for this project type" });
    }
  }
  return out;
}
