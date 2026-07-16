-- Phase-8 hardening (lead ruling on the W1:fix escalation): share tokens move
-- to hash+ciphertext at rest — sha256 hex for lookup, AES-256-GCM ciphertext
-- (INGEST_SECRET_ENC_KEY) only for owner re-display. A read-only DB leak
-- yields nothing usable. The feature shipped hours ago in dev and the owner
-- has minted no real links: wipe rows rather than backfill.
DELETE FROM "share_tokens";--> statement-breakpoint
ALTER TABLE "share_tokens" DROP COLUMN "token";--> statement-breakpoint
ALTER TABLE "share_tokens" ADD COLUMN "token_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "share_tokens" ADD COLUMN "token_ciphertext" text NOT NULL;--> statement-breakpoint
ALTER TABLE "share_tokens" ADD CONSTRAINT "share_tokens_token_hash_unique" UNIQUE("token_hash");--> statement-breakpoint
-- Phase 9 §P9-COST: the client API-spend spike alert kind.
ALTER TYPE "public"."alert_kind" ADD VALUE 'cost_spike';
