ALTER TYPE "public"."os_agent_kind" ADD VALUE 'project_intake';--> statement-breakpoint
CREATE TABLE "rollup_watermarks" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"processed_through" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "hourly_rate_pence" integer;--> statement-breakpoint
ALTER TABLE "metric_definitions" ADD COLUMN "where_equals" jsonb;--> statement-breakpoint
ALTER TABLE "rollup_watermarks" ADD CONSTRAINT "rollup_watermarks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rollup_watermarks" ADD CONSTRAINT "rollup_watermarks_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;