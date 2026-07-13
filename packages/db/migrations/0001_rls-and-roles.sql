-- RLS + roles (spec §4 preamble, §15).
-- Reality check (§15): v1 server code reaches Postgres through Drizzle on a
-- privileged connection, so the actual enforcement layer is app-level auth.
-- These policies exist from day 1 and become load-bearing when non-privileged
-- access paths (client portal, team seats) arrive in Phase 7+.

-- Local plain-Postgres dev has no Supabase auth schema — stub auth.uid() so
-- the policies below are valid. On hosted Supabase the schema already exists
-- and this block is a no-op.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_namespace WHERE nspname = 'auth') THEN
    CREATE SCHEMA auth;
  END IF;
  IF NOT EXISTS (
    SELECT FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'auth' AND p.proname = 'uid'
  ) THEN
    CREATE FUNCTION auth.uid() RETURNS uuid
      LANGUAGE sql STABLE
      AS 'SELECT NULL::uuid';
  END IF;
END $$;
--> statement-breakpoint

-- Membership helper: the org the authenticated user belongs to.
CREATE OR REPLACE FUNCTION public.current_org_id() RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS 'SELECT org_id FROM public.users WHERE id = auth.uid()';
--> statement-breakpoint

-- Local plain-Postgres dev has no `authenticated` role (Supabase provides it).
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
END $$;
--> statement-breakpoint

-- Enable RLS on every table with the uniform org policy (v1 policy is simply
-- "authenticated user belongs to org" — org_id is denormalized onto all
-- tables for exactly this reason).
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users','industries','clients','contacts',
    'projects','project_keys','project_integrations',
    'events','metric_definitions','metric_rollups',
    'payments','subscriptions','expenses','bookings',
    'briefs','insights','upsell_proposals','knowledge_articles',
    'agent_runs','chat_sessions','chat_messages',
    'webhook_deliveries','alert_rules'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY org_members ON public.%I FOR ALL TO authenticated USING (org_id = public.current_org_id()) WITH CHECK (org_id = public.current_org_id())',
      t
    );
  END LOOP;
END $$;
--> statement-breakpoint

-- organizations has no org_id column — membership is by id.
ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY org_members ON public.organizations
  FOR ALL TO authenticated
  USING (id = public.current_org_id())
  WITH CHECK (id = public.current_org_id());
--> statement-breakpoint

-- Read-only role for Ask Azen's run_sql tool (§9.8, §15): SELECT-only grants,
-- 5s statement timeout; row limits enforced app-side. DATABASE_URL_RO
-- connects as this role. Password is a local-dev default — rotate on hosted
-- environments. BYPASSRLS because access is app-mediated and read-only.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'azen_readonly') THEN
    CREATE ROLE azen_readonly LOGIN PASSWORD 'readonly' BYPASSRLS;
  END IF;
END $$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO azen_readonly;
--> statement-breakpoint
GRANT SELECT ON ALL TABLES IN SCHEMA public TO azen_readonly;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO azen_readonly;
--> statement-breakpoint
ALTER ROLE azen_readonly SET statement_timeout = '5s';
