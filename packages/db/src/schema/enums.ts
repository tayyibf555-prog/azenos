import { pgEnum } from "drizzle-orm/pg-core";

export const clientStatus = pgEnum("client_status", [
  "lead",
  "discovery",
  "proposal",
  "active",
  "paused",
  "churned",
]);

export const projectType = pgEnum("project_type", [
  "ai_agent",
  "automation",
  "website",
  "chatbot",
  "voice_agent",
  "crm_setup",
  "custom",
]);

export const projectStack = pgEnum("project_stack", [
  "custom_code",
  "n8n",
  "mixed",
]);

export const projectStatus = pgEnum("project_status", [
  "scoping",
  "building",
  "testing",
  "live",
  "paused",
  "completed",
  "cancelled",
]);

export const projectHealth = pgEnum("project_health", [
  "green",
  "amber",
  "red",
]);

export const keyAuthMode = pgEnum("key_auth_mode", ["hmac", "token"]);

// Phase 7: least-privilege key kinds. 'ingest' keys drive §6 event ingest
// (HMAC/token); 'feedback' keys are PUBLIC, browser-embeddable, and can ONLY
// create feedback.submitted events via /api/feedback/[publicKey].
export const keyKind = pgEnum("key_kind", ["ingest", "feedback"]);

export const integrationProvider = pgEnum("integration_provider", [
  "stripe",
  "calendly",
  "twilio",
  "custom",
]);

export const eventSource = pgEnum("event_source", [
  "sdk",
  "stripe",
  "calendly",
  "manual",
  "import",
  // Phase 7: the public feedback webhook (docs/phase7/PLAN.md §B)
  "feedback",
]);

export const metricUnit = pgEnum("metric_unit", [
  "count",
  "pence",
  "minutes",
  "percent",
  "ms",
]);

export const metricAggregation = pgEnum("metric_aggregation", [
  "sum",
  "count",
  "avg",
  "p95",
  "last",
  "rate",
]);

export const goodDirection = pgEnum("good_direction", ["up", "down"]);

export const rollupPeriod = pgEnum("rollup_period", [
  "hour",
  "day",
  "week",
  "month",
]);

export const paymentSource = pgEnum("payment_source", [
  "stripe",
  "bank_transfer",
  "other",
]);

export const paymentKind = pgEnum("payment_kind", [
  "build_fee",
  "retainer",
  "deposit",
  "other",
]);

export const paymentStatus = pgEnum("payment_status", [
  "pending",
  "paid",
  "failed",
  "refunded",
]);

export const subscriptionStatus = pgEnum("subscription_status", [
  "active",
  "past_due",
  "paused",
  "cancelled",
]);

export const expenseCategory = pgEnum("expense_category", [
  "hosting",
  "api",
  "tools",
  "contractor",
  "other",
]);

export const bookingSource = pgEnum("booking_source", [
  "calendly",
  "client_system",
  "manual",
]);

export const bookingKind = pgEnum("booking_kind", [
  "discovery",
  "kickoff",
  "review",
  "client_end_customer",
]);

export const bookingStatus = pgEnum("booking_status", [
  "scheduled",
  "completed",
  "cancelled",
  "no_show",
]);

export const briefScope = pgEnum("brief_scope", ["agency", "project"]);

export const briefPeriod = pgEnum("brief_period", [
  "daily",
  "weekly",
  "monthly",
]);

export const briefStatus = pgEnum("brief_status", [
  "generated",
  "sent",
  "failed",
]);

export const insightKind = pgEnum("insight_kind", [
  "automation_opportunity",
  "upsell",
  "risk",
  "win",
  "anomaly",
  "faq_cluster",
]);

export const insightConfidence = pgEnum("insight_confidence", [
  "low",
  "med",
  "high",
]);

export const insightStatus = pgEnum("insight_status", [
  "new",
  "reviewed",
  "actioned",
  "dismissed",
  "converted_to_upsell",
]);

export const createdByKind = pgEnum("created_by_kind", ["agent", "user"]);

export const proposalStatus = pgEnum("proposal_status", [
  "draft",
  "ready",
  "sent",
  "won",
  "lost",
]);

export const knowledgeKind = pgEnum("knowledge_kind", [
  "industry_primer",
  "weekly_digest",
  "pattern",
  "playbook",
]);

export const osAgentKind = pgEnum("os_agent_kind", [
  "daily_brief",
  "weekly_synth",
  "monthly_strategist",
  "opportunity_scout",
  "industry_learner",
  "upsell_engine",
  // transcript → project intake co-pilot (owner scope addition, Phase 2)
  "project_intake",
]);

export const agentRunStatus = pgEnum("agent_run_status", [
  "running",
  "succeeded",
  "failed",
]);

export const chatRole = pgEnum("chat_role", ["user", "assistant", "tool"]);

export const deliveryStatus = pgEnum("delivery_status", [
  "accepted",
  "duplicate",
  "rejected",
  "failed",
]);

export const alertKind = pgEnum("alert_kind", [
  "error_streak",
  "event_silence",
  "payment_overdue",
  "anomaly",
  "custom",
  // Phase 9 §P9-COST: client API-spend spike (7d > 1.4× prior 7d AND > £5)
  "cost_spike",
]);

export const alertChannel = pgEnum("alert_channel", [
  "whatsapp",
  "email",
  "both",
]);

// ── Phase 7 (docs/phase7/PLAN.md) ────────────────────────────────────────────

// §B — feedback.submitted intake (bugs / feature requests from client staff).
export const feedbackKind = pgEnum("feedback_kind", [
  "bug",
  "feature",
  "question",
  "praise",
  "other",
]);

export const feedbackStatus = pgEnum("feedback_status", [
  "new",
  "seen",
  "planned",
  "done",
]);

// §C — per-project Connections vault (owner-entered, AES-256-GCM at rest).
// Matches the owner's actual client stack; 'custom' covers everything else.
export const credentialProvider = pgEnum("credential_provider", [
  "anthropic",
  "openai",
  "twilio",
  "higgsfield",
  "custom",
]);

// ── Phase 8 (docs/phase8/CONTRACTS.md) ───────────────────────────────────────

// Public share links: white-label monthly client reports + sent proposals.
export const shareKind = pgEnum("share_kind", ["monthly_report", "proposal"]);

// Health Center alert instances (rules live in alert_rules; instances are the
// firings the grid acks/resolves).
export const alertSeverity = pgEnum("alert_severity", [
  "info",
  "warn",
  "critical",
]);
