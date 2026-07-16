-- Phase 7 GHL purge (owner: no GoHighLevel anywhere). Migrate the two live rows
-- BEFORE the enum types are recreated without the 'ghl' value.
UPDATE "projects" SET "stack" = 'mixed' WHERE "stack" = 'ghl';--> statement-breakpoint
DELETE FROM "project_integrations" WHERE "provider" = 'ghl';--> statement-breakpoint
ALTER TABLE "events" ALTER COLUMN "source" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "events" ALTER COLUMN "source" SET DEFAULT 'sdk'::text;--> statement-breakpoint
DROP TYPE "public"."event_source";--> statement-breakpoint
CREATE TYPE "public"."event_source" AS ENUM('sdk', 'stripe', 'calendly', 'manual', 'import', 'feedback');--> statement-breakpoint
ALTER TABLE "events" ALTER COLUMN "source" SET DEFAULT 'sdk'::"public"."event_source";--> statement-breakpoint
ALTER TABLE "events" ALTER COLUMN "source" SET DATA TYPE "public"."event_source" USING "source"::"public"."event_source";--> statement-breakpoint
ALTER TABLE "project_integrations" ALTER COLUMN "provider" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."integration_provider";--> statement-breakpoint
CREATE TYPE "public"."integration_provider" AS ENUM('stripe', 'calendly', 'twilio', 'custom');--> statement-breakpoint
ALTER TABLE "project_integrations" ALTER COLUMN "provider" SET DATA TYPE "public"."integration_provider" USING "provider"::"public"."integration_provider";--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "stack" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "stack" SET DEFAULT 'custom_code'::text;--> statement-breakpoint
DROP TYPE "public"."project_stack";--> statement-breakpoint
CREATE TYPE "public"."project_stack" AS ENUM('custom_code', 'n8n', 'mixed');--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "stack" SET DEFAULT 'custom_code'::"public"."project_stack";--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "stack" SET DATA TYPE "public"."project_stack" USING "stack"::"public"."project_stack";--> statement-breakpoint
-- RLS for the Phase-7 tables (adversarial C-verify finding, lead-fixed):
-- matches the org_members pattern from migration 0004.
ALTER TABLE public.project_credentials ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_members ON public.project_credentials
  FOR ALL TO authenticated
  USING (org_id = public.current_org_id())
  WITH CHECK (org_id = public.current_org_id());--> statement-breakpoint
ALTER TABLE public.feedback_items ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_members ON public.feedback_items
  FOR ALL TO authenticated
  USING (org_id = public.current_org_id())
  WITH CHECK (org_id = public.current_org_id());