CREATE TYPE "public"."alert_severity" AS ENUM('info', 'warn', 'critical');--> statement-breakpoint
CREATE TYPE "public"."share_kind" AS ENUM('monthly_report', 'proposal');--> statement-breakpoint
CREATE TABLE "share_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"client_id" uuid,
	"project_id" uuid,
	"proposal_id" uuid,
	"kind" "share_kind" NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"view_count" integer DEFAULT 0 NOT NULL,
	"last_viewed_at" timestamp with time zone,
	CONSTRAINT "share_tokens_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "alert_instances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid,
	"kind" "alert_kind" NOT NULL,
	"severity" "alert_severity" DEFAULT 'warn' NOT NULL,
	"message" text NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"fired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acked_at" timestamp with time zone,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "slo" jsonb;--> statement-breakpoint
ALTER TABLE "share_tokens" ADD CONSTRAINT "share_tokens_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_tokens" ADD CONSTRAINT "share_tokens_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_tokens" ADD CONSTRAINT "share_tokens_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_tokens" ADD CONSTRAINT "share_tokens_proposal_id_upsell_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."upsell_proposals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_instances" ADD CONSTRAINT "alert_instances_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_instances" ADD CONSTRAINT "alert_instances_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "share_tokens_org_kind_idx" ON "share_tokens" USING btree ("org_id","kind","created_at");--> statement-breakpoint
CREATE INDEX "alert_instances_open_idx" ON "alert_instances" USING btree ("org_id","resolved_at","fired_at");