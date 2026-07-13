/**
 * Pinned model + platform constants (spec §2, §12, §18.4).
 * Model IDs verified against Anthropic docs on 2026-07-11.
 * Env vars override per environment; these are the committed defaults.
 */

// Agent fleet (briefs, scout, strategist, learning) — spec §9
export const AGENT_MODEL = process.env.AGENT_MODEL || "claude-sonnet-5";

// Ask Azen interactive chat — spec §9.8 (tuned independently of the fleet)
export const CHAT_MODEL = process.env.CHAT_MODEL || "claude-sonnet-5";

// Knowledge-base embeddings — Voyage AI (owner decision 2026-07-11), pgvector dims must match
export const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "voyage-3.5";
export const EMBEDDING_DIMS = Number(process.env.EMBEDDING_DIMS || 1024);

// Fleet + chat shared monthly token budget cap — spec §13. Default £100/month.
export const AGENT_BUDGET_PENCE_MONTHLY = Number(
  process.env.AGENT_BUDGET_PENCE_MONTHLY || 10_000,
);

// ROI time-value default — spec §8.1 (£30/h, configurable per project)
export const DEFAULT_HOURLY_RATE_PENCE = 3_000;

// Client API-cost invoicing markup default (Phase 4, owner requirement) —
// per-client clients.cost_markup_pct overrides. 0 = bill at cost.
export const DEFAULT_COST_MARKUP_PCT = Number(
  process.env.DEFAULT_COST_MARKUP_PCT || 0,
);

// All scheduling and rollup boundaries — spec §13
export const TIMEZONE = "Europe/London";

export const INGEST_SIGNING_VERSION =
  process.env.INGEST_SIGNING_VERSION || "v1";

// Ingest limits — spec §6.3, §15
export const INGEST_MAX_BODY_BYTES = 256 * 1024;
export const INGEST_TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;
export const INGEST_DEFAULT_RATE_LIMIT = { requests: 100, windowSeconds: 10 };
