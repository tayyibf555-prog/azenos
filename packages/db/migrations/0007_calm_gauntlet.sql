CREATE TYPE "public"."credential_provider" AS ENUM('anthropic', 'openai', 'twilio', 'higgsfield', 'custom');--> statement-breakpoint
CREATE TYPE "public"."feedback_kind" AS ENUM('bug', 'feature', 'question', 'praise', 'other');--> statement-breakpoint
CREATE TYPE "public"."feedback_status" AS ENUM('new', 'seen', 'planned', 'done');--> statement-breakpoint
CREATE TYPE "public"."key_kind" AS ENUM('ingest', 'feedback');--> statement-breakpoint
ALTER TYPE "public"."event_source" ADD VALUE 'feedback';--> statement-breakpoint
CREATE TABLE "project_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"provider" "credential_provider" NOT NULL,
	"label" text NOT NULL,
	"ciphertext" text NOT NULL,
	"last4" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "feedback_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"kind" "feedback_kind" NOT NULL,
	"message" text NOT NULL,
	"severity" integer,
	"submitter_name" text,
	"submitter_email" text,
	"page_url" text,
	"status" "feedback_status" DEFAULT 'new' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_keys" ADD COLUMN "kind" "key_kind" DEFAULT 'ingest' NOT NULL;--> statement-breakpoint
ALTER TABLE "project_credentials" ADD CONSTRAINT "project_credentials_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_credentials" ADD CONSTRAINT "project_credentials_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_items" ADD CONSTRAINT "feedback_items_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_items" ADD CONSTRAINT "feedback_items_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_items" ADD CONSTRAINT "feedback_items_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_credentials_project_idx" ON "project_credentials" USING btree ("org_id","project_id");--> statement-breakpoint
CREATE INDEX "feedback_items_project_created_idx" ON "feedback_items" USING btree ("org_id","project_id","created_at");--> statement-breakpoint
CREATE INDEX "feedback_items_project_status_idx" ON "feedback_items" USING btree ("org_id","project_id","status");