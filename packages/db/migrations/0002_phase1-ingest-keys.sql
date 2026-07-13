-- UNLOGGED: throwaway fixed-window rate counters (§6.3 step 2, Postgres
-- fallback when Upstash is absent). No org_id, no RLS — internal infra,
-- read/written only by the ingest route on the privileged connection.
CREATE UNLOGGED TABLE "ingest_rate_counters" (
	"project_key_id" uuid NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "ingest_rate_counters_project_key_id_window_start_pk" PRIMARY KEY("project_key_id","window_start")
);
--> statement-breakpoint
ALTER TABLE "project_keys" ADD COLUMN "secret_ciphertext" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "project_keys" ADD COLUMN "rate_limit_per_10s" integer DEFAULT 100 NOT NULL;--> statement-breakpoint
ALTER TABLE "project_keys" ADD COLUMN "last_used_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ingest_rate_counters" ADD CONSTRAINT "ingest_rate_counters_project_key_id_project_keys_id_fk" FOREIGN KEY ("project_key_id") REFERENCES "public"."project_keys"("id") ON DELETE cascade ON UPDATE no action;