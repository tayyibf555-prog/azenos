CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TYPE "public"."agent_run_status" AS ENUM('running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."alert_channel" AS ENUM('whatsapp', 'email', 'both');--> statement-breakpoint
CREATE TYPE "public"."alert_kind" AS ENUM('error_streak', 'event_silence', 'payment_overdue', 'anomaly', 'custom');--> statement-breakpoint
CREATE TYPE "public"."booking_kind" AS ENUM('discovery', 'kickoff', 'review', 'client_end_customer');--> statement-breakpoint
CREATE TYPE "public"."booking_source" AS ENUM('calendly', 'client_system', 'manual');--> statement-breakpoint
CREATE TYPE "public"."booking_status" AS ENUM('scheduled', 'completed', 'cancelled', 'no_show');--> statement-breakpoint
CREATE TYPE "public"."brief_period" AS ENUM('daily', 'weekly', 'monthly');--> statement-breakpoint
CREATE TYPE "public"."brief_scope" AS ENUM('agency', 'project');--> statement-breakpoint
CREATE TYPE "public"."brief_status" AS ENUM('generated', 'sent', 'failed');--> statement-breakpoint
CREATE TYPE "public"."chat_role" AS ENUM('user', 'assistant', 'tool');--> statement-breakpoint
CREATE TYPE "public"."client_status" AS ENUM('lead', 'discovery', 'proposal', 'active', 'paused', 'churned');--> statement-breakpoint
CREATE TYPE "public"."created_by_kind" AS ENUM('agent', 'user');--> statement-breakpoint
CREATE TYPE "public"."delivery_status" AS ENUM('accepted', 'duplicate', 'rejected', 'failed');--> statement-breakpoint
CREATE TYPE "public"."event_source" AS ENUM('sdk', 'ghl', 'stripe', 'calendly', 'manual', 'import');--> statement-breakpoint
CREATE TYPE "public"."expense_category" AS ENUM('hosting', 'api', 'tools', 'contractor', 'other');--> statement-breakpoint
CREATE TYPE "public"."good_direction" AS ENUM('up', 'down');--> statement-breakpoint
CREATE TYPE "public"."insight_confidence" AS ENUM('low', 'med', 'high');--> statement-breakpoint
CREATE TYPE "public"."insight_kind" AS ENUM('automation_opportunity', 'upsell', 'risk', 'win', 'anomaly', 'faq_cluster');--> statement-breakpoint
CREATE TYPE "public"."insight_status" AS ENUM('new', 'reviewed', 'actioned', 'dismissed', 'converted_to_upsell');--> statement-breakpoint
CREATE TYPE "public"."integration_provider" AS ENUM('stripe', 'calendly', 'ghl', 'twilio', 'custom');--> statement-breakpoint
CREATE TYPE "public"."key_auth_mode" AS ENUM('hmac', 'token');--> statement-breakpoint
CREATE TYPE "public"."knowledge_kind" AS ENUM('industry_primer', 'weekly_digest', 'pattern', 'playbook');--> statement-breakpoint
CREATE TYPE "public"."metric_aggregation" AS ENUM('sum', 'count', 'avg', 'p95', 'last', 'rate');--> statement-breakpoint
CREATE TYPE "public"."metric_unit" AS ENUM('count', 'pence', 'minutes', 'percent', 'ms');--> statement-breakpoint
CREATE TYPE "public"."os_agent_kind" AS ENUM('daily_brief', 'weekly_synth', 'monthly_strategist', 'opportunity_scout', 'industry_learner', 'upsell_engine');--> statement-breakpoint
CREATE TYPE "public"."payment_kind" AS ENUM('build_fee', 'retainer', 'deposit', 'other');--> statement-breakpoint
CREATE TYPE "public"."payment_source" AS ENUM('stripe', 'bank_transfer', 'other');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('pending', 'paid', 'failed', 'refunded');--> statement-breakpoint
CREATE TYPE "public"."project_health" AS ENUM('green', 'amber', 'red');--> statement-breakpoint
CREATE TYPE "public"."project_stack" AS ENUM('custom_code', 'ghl', 'n8n', 'mixed');--> statement-breakpoint
CREATE TYPE "public"."project_status" AS ENUM('scoping', 'building', 'testing', 'live', 'paused', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."project_type" AS ENUM('ai_agent', 'automation', 'website', 'chatbot', 'voice_agent', 'crm_setup', 'custom');--> statement-breakpoint
CREATE TYPE "public"."proposal_status" AS ENUM('draft', 'ready', 'sent', 'won', 'lost');--> statement-breakpoint
CREATE TYPE "public"."rollup_period" AS ENUM('hour', 'day', 'week', 'month');--> statement-breakpoint
CREATE TYPE "public"."subscription_status" AS ENUM('active', 'past_due', 'paused', 'cancelled');--> statement-breakpoint
CREATE TABLE "clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"company" text,
	"industry_id" uuid,
	"status" "client_status" DEFAULT 'lead' NOT NULL,
	"source" text,
	"emails" text[] DEFAULT '{}' NOT NULL,
	"phones" text[] DEFAULT '{}' NOT NULL,
	"website" text,
	"notes" text,
	"ltv_cache_pence" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"name" text NOT NULL,
	"role" text,
	"email" text,
	"phone" text
);
--> statement-breakpoint
CREATE TABLE "industries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "industries_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"phone_whatsapp" text,
	"role" text DEFAULT 'owner' NOT NULL,
	"notification_prefs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_integrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"provider" "integration_provider" NOT NULL,
	"external_id" text,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"public_key" text NOT NULL,
	"secret_hash" text NOT NULL,
	"auth_mode" "key_auth_mode" DEFAULT 'hmac' NOT NULL,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "project_keys_public_key_unique" UNIQUE("public_key")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"type" "project_type" NOT NULL,
	"stack" "project_stack" DEFAULT 'custom_code' NOT NULL,
	"status" "project_status" DEFAULT 'scoping' NOT NULL,
	"build_fee_pence" bigint DEFAULT 0 NOT NULL,
	"retainer_pence_monthly" bigint DEFAULT 0 NOT NULL,
	"retainer_active" boolean DEFAULT false NOT NULL,
	"start_date" date,
	"live_date" date,
	"health" "project_health" DEFAULT 'green' NOT NULL,
	"goals" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid,
	"type" text NOT NULL,
	"source" "event_source" DEFAULT 'sdk' NOT NULL,
	"idempotency_key" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" jsonb,
	"subject" jsonb,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"value_pence" bigint,
	"currency" char(3) DEFAULT 'gbp' NOT NULL,
	"minutes_saved" numeric,
	"raw" jsonb NOT NULL,
	CONSTRAINT "events_dedup_uq" UNIQUE NULLS NOT DISTINCT("org_id","project_id","idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "metric_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"unit" "metric_unit" DEFAULT 'count' NOT NULL,
	"aggregation" "metric_aggregation" DEFAULT 'count' NOT NULL,
	"event_type" text NOT NULL,
	"value_path" text,
	"good_direction" "good_direction" DEFAULT 'up' NOT NULL,
	"is_kpi" boolean DEFAULT false NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "metric_rollups" (
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"metric_key" text NOT NULL,
	"period" "rollup_period" NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"value" numeric NOT NULL,
	"sample_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "metric_rollups_project_id_metric_key_period_period_start_pk" PRIMARY KEY("project_id","metric_key","period","period_start")
);
--> statement-breakpoint
CREATE TABLE "expenses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid,
	"category" "expense_category" NOT NULL,
	"vendor" text NOT NULL,
	"amount_pence" bigint NOT NULL,
	"recurring" boolean DEFAULT false NOT NULL,
	"period" text,
	"notes" text,
	"incurred_at" date NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"project_id" uuid,
	"source" "payment_source" NOT NULL,
	"kind" "payment_kind" NOT NULL,
	"amount_pence" bigint NOT NULL,
	"currency" char(3) DEFAULT 'gbp' NOT NULL,
	"status" "payment_status" DEFAULT 'paid' NOT NULL,
	"external_id" text,
	"invoice_ref" text,
	"paid_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"project_id" uuid,
	"stripe_subscription_id" text,
	"amount_pence_monthly" bigint NOT NULL,
	"status" "subscription_status" DEFAULT 'active' NOT NULL,
	"started_at" date NOT NULL,
	"cancelled_at" date
);
--> statement-breakpoint
CREATE TABLE "bookings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"client_id" uuid,
	"project_id" uuid,
	"source" "booking_source" NOT NULL,
	"kind" "booking_kind" NOT NULL,
	"invitee" jsonb,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"status" "booking_status" DEFAULT 'scheduled' NOT NULL,
	"external_id" text,
	"source_event_id" uuid,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"agent" "os_agent_kind" NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"status" "agent_run_status" DEFAULT 'running' NOT NULL,
	"model" text,
	"tokens_in" integer,
	"tokens_out" integer,
	"cost_estimate_pence" integer,
	"error" text,
	"output_refs" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "briefs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"scope" "brief_scope" NOT NULL,
	"project_id" uuid,
	"period" "brief_period" NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"headline" text NOT NULL,
	"body_md" text NOT NULL,
	"body_whatsapp" text,
	"data_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"model" text,
	"tokens_in" integer,
	"tokens_out" integer,
	"status" "brief_status" DEFAULT 'generated' NOT NULL,
	"sent_email_at" timestamp with time zone,
	"sent_whatsapp_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"role" "chat_role" NOT NULL,
	"content_md" text NOT NULL,
	"tool_calls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"model" text,
	"tokens_in" integer,
	"tokens_out" integer,
	"cost_estimate_pence" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "insights" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" "insight_kind" NOT NULL,
	"title" text NOT NULL,
	"body_md" text NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"fingerprint" text,
	"estimated_value_pence" bigint,
	"estimated_hours_saved_monthly" integer,
	"confidence" "insight_confidence" DEFAULT 'med' NOT NULL,
	"status" "insight_status" DEFAULT 'new' NOT NULL,
	"created_by" "created_by_kind" DEFAULT 'agent' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_articles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"industry_id" uuid NOT NULL,
	"title" text NOT NULL,
	"body_md" text NOT NULL,
	"sources" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"kind" "knowledge_kind" NOT NULL,
	"embedding" vector(1024),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "upsell_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"project_id" uuid,
	"title" text NOT NULL,
	"problem_md" text NOT NULL,
	"proposal_md" text NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"suggested_price_pence" bigint,
	"status" "proposal_status" DEFAULT 'draft' NOT NULL,
	"insight_ids" uuid[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alert_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid,
	"kind" "alert_kind" NOT NULL,
	"condition" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"channel" "alert_channel" DEFAULT 'whatsapp' NOT NULL,
	"cooldown_minutes" integer DEFAULT 60 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_fired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_key_id" uuid,
	"status" "delivery_status" NOT NULL,
	"http_status" integer NOT NULL,
	"latency_ms" integer,
	"error" text,
	"event_id" uuid,
	"raw" jsonb,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_industry_id_industries_id_fk" FOREIGN KEY ("industry_id") REFERENCES "public"."industries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "industries" ADD CONSTRAINT "industries_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_integrations" ADD CONSTRAINT "project_integrations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_integrations" ADD CONSTRAINT "project_integrations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_keys" ADD CONSTRAINT "project_keys_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_keys" ADD CONSTRAINT "project_keys_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_definitions" ADD CONSTRAINT "metric_definitions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_definitions" ADD CONSTRAINT "metric_definitions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_rollups" ADD CONSTRAINT "metric_rollups_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_rollups" ADD CONSTRAINT "metric_rollups_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "briefs" ADD CONSTRAINT "briefs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "briefs" ADD CONSTRAINT "briefs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "insights" ADD CONSTRAINT "insights_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "insights" ADD CONSTRAINT "insights_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_articles" ADD CONSTRAINT "knowledge_articles_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_articles" ADD CONSTRAINT "knowledge_articles_industry_id_industries_id_fk" FOREIGN KEY ("industry_id") REFERENCES "public"."industries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upsell_proposals" ADD CONSTRAINT "upsell_proposals_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upsell_proposals" ADD CONSTRAINT "upsell_proposals_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upsell_proposals" ADD CONSTRAINT "upsell_proposals_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_rules" ADD CONSTRAINT "alert_rules_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_rules" ADD CONSTRAINT "alert_rules_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_project_key_id_project_keys_id_fk" FOREIGN KEY ("project_key_id") REFERENCES "public"."project_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "clients_org_idx" ON "clients" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "contacts_client_idx" ON "contacts" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "project_integrations_provider_idx" ON "project_integrations" USING btree ("provider","external_id");--> statement-breakpoint
CREATE INDEX "project_keys_project_idx" ON "project_keys" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "projects_org_status_idx" ON "projects" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "events_project_type_time_idx" ON "events" USING btree ("project_id","type","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "events_org_time_idx" ON "events" USING btree ("org_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "events_data_gin" ON "events" USING gin ("data");--> statement-breakpoint
CREATE INDEX "metric_defs_project_idx" ON "metric_definitions" USING btree ("project_id","key");--> statement-breakpoint
CREATE INDEX "rollups_period_idx" ON "metric_rollups" USING btree ("period","period_start" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "expenses_org_idx" ON "expenses" USING btree ("org_id","incurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "payments_org_paid_idx" ON "payments" USING btree ("org_id","paid_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "payments_client_idx" ON "payments" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "subscriptions_org_idx" ON "subscriptions" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "bookings_org_time_idx" ON "bookings" USING btree ("org_id","starts_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "bookings_project_idx" ON "bookings" USING btree ("project_id","starts_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "agent_runs_org_idx" ON "agent_runs" USING btree ("org_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "briefs_org_period_idx" ON "briefs" USING btree ("org_id","period","period_start" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "chat_messages_session_idx" ON "chat_messages" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX "chat_sessions_org_idx" ON "chat_sessions" USING btree ("org_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "insights_project_status_idx" ON "insights" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "insights_fingerprint_idx" ON "insights" USING btree ("project_id","fingerprint");--> statement-breakpoint
CREATE INDEX "knowledge_industry_idx" ON "knowledge_articles" USING btree ("industry_id","kind");--> statement-breakpoint
CREATE INDEX "upsells_client_status_idx" ON "upsell_proposals" USING btree ("client_id","status");--> statement-breakpoint
CREATE INDEX "alert_rules_project_idx" ON "alert_rules" USING btree ("project_id","enabled");--> statement-breakpoint
CREATE INDEX "deliveries_key_time_idx" ON "webhook_deliveries" USING btree ("project_key_id","received_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "deliveries_status_idx" ON "webhook_deliveries" USING btree ("status","received_at" DESC NULLS LAST);