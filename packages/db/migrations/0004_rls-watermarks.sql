-- Uniform org RLS for the Phase 2 watermark table (policy parity with 0001).
ALTER TABLE public.rollup_watermarks ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY org_members ON public.rollup_watermarks
  FOR ALL TO authenticated
  USING (org_id = public.current_org_id())
  WITH CHECK (org_id = public.current_org_id());
