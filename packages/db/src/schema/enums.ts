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
  "ghl",
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

export const integrationProvider = pgEnum("integration_provider", [
  "stripe",
  "calendly",
  "ghl",
  "twilio",
  "custom",
]);

export const eventSource = pgEnum("event_source", [
  "sdk",
  "ghl",
  "stripe",
  "calendly",
  "manual",
  "import",
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
]);

export const alertChannel = pgEnum("alert_channel", [
  "whatsapp",
  "email",
  "both",
]);
