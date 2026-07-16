# Phase 8 — Client-Facing & Reliability (READ FULLY BEFORE WRITING CODE)

Binding contracts, authored by the lead 2026-07-16. Deviations → docs/DECISIONS.md.
Ground rules UNCHANGED (docs/ORCHESTRATION.md + phase1 rules + the ANTI-NOISE and
BLOCKED-escalation clauses in your brief): TS strict, no any, extensionless imports,
money = integer pence, London via SQL, org-scoping everywhere, NO new deps, NO
schema/migration edits (lead pre-applies migration 0009), graceful degradation without
ANTHROPIC/OPENAI/VOYAGE/TWILIO/RESEND keys, throwaway-org tests never touch DEMO_ORG_ID.
Design = Quiet Glass (globals.css + ui.ts COLORS; docs/design/*.md principles only).

Lead pre-work (migration 0009, applied before launch):
- `share_tokens`: id uuid pk, org_id→orgs, client_id→clients null, project_id→projects null,
  proposal_id→upsell_proposals null, kind ('monthly_report'|'proposal'), token text unique
  (unguessable, ≥32 bytes url-safe), created_at, expires_at null, revoked_at null,
  view_count int default 0, last_viewed_at null.
- `alert_instances`: id uuid pk, org_id, project_id null, kind (alertKind enum), severity
  ('info'|'warn'|'critical'), message text, evidence jsonb, fired_at, acked_at null,
  resolved_at null. Index (org_id, resolved_at, fired_at desc).
- `projects.slo` jsonb null — shape { error_rate_pct?: number, p95_ms?: number,
  heartbeat_gap_minutes?: number }.

## Wave 1 (4 parallel, disjoint)

### P8-REPORT — Shareable Client Report Link (Opus 4.8; public surface)
- `apps/web/lib/server/share.ts`: createShareToken(orgId, {kind, clientId?, proposalId?, expiresAt?})
  → crypto.randomBytes(32) base64url; revokeShareToken; resolveShareToken(token) → null if
  revoked/expired; recordView (view_count+1, last_viewed_at). NEVER expose org internals.
- Public route `apps/web/app/share/[token]/page.tsx` — NO auth, READ-ONLY, `X-Robots-Tag: noindex`
  + meta noindex: for kind=monthly_report renders the latest monthly client report for that
  client (briefs table: scope/period monthly, client-scoped Strategist output) as a POLISHED
  white-label page: agency name header, headline value numbers (£ attributed value, hours saved,
  ROI — reuse the datapack/ROI conventions), the report markdown (rendered), a benchmark slot
  (`<BenchmarkBlock client>` — placeholder until P8-BENCH lands, degrade to hidden), calm glass
  design, mobile-perfect. Invalid/revoked/expired token → clean branded 404 (no info leak).
- "Share report" affordance where monthly client reports render internally (Briefs screen client
  reports + client detail): create/copy link, show view count, revoke. API routes:
  POST/DELETE `/api/share` (org-scoped), GET stays server-side only.
- Tests `apps/web/test/share/`: token entropy (length/charset), revoked→404, expired→404,
  cross-org create refused, view_count increments once per resolve call, response HTML never
  contains org ids/keys.

### P8-HEALTH — Health Center + SLOs + escalation (Opus 4.8; reliability core)
- Evaluation: `apps/web/lib/server/health/evaluate.ts` — pure, deterministic, SQL over the spine:
  per live project compute freshness (minutes since last event vs heartbeat_gap_minutes SLO or
  default 240), error streak (system.error run), agent uptime (heartbeat gaps 24h), error rate vs
  slo.error_rate_pct, p95 duration vs slo.p95_ms, feedback negative-spike, retainer past_due.
  Breaches → UPSERT alert_instances (dedupe on open instance of same kind+project; resolve
  auto-closes when the condition clears). `jobs/health.ts` (15-min cadence, defensively
  importable) + CLI `health:run` script line in packages/agents/package.json IF the evaluator
  lives web-side keep it a web CLI instead: `apps/web` route `POST /api/health/evaluate`
  (internal) + a tsx script `scripts/health-run.ts` — choose the simplest that respects
  ownership and REPORT it.
- Screen `apps/web/app/health/page.tsx` + AppFrame nav row "Health": traffic-light grid — rows =
  every live project (grouped by client), columns = freshness · errors · agent uptime · SLO ·
  feedback · retainer; open alert_instances list with ACK / RESOLVE actions
  (PATCH `/api/health/alerts/[id]`); a "silent projects" hero count. Objective health: derive the
  project health badge from SLO state (green = all pass, amber = warn breach, red = critical) —
  write back to projects.health on evaluate.
- Escalation: critical instance unacked >15 min → WhatsApp via the EXISTING Phase-3 delivery layer
  (graceful no-Twilio-key: log + surface a banner "escalation needs TWILIO_*").
- Tests: evaluator against hand-built events in a throwaway org (fresh vs silent project, error
  streak fires once not per-run, auto-resolve on recovery, SLO breach math), ack/resolve API
  org-scoping.

### P8-C360 — Client 360 (Sonnet 5; composition)
- Extend `apps/web/app/clients/[clientId]/page.tsx` into the one-look client view: header (status,
  industry, LTV, MRR share, markup), all projects w/ objective health chips + per-project value
  row (events 30d, ROI, API cost MTD), money summary (existing queries — reuse, do not rewrite),
  conversations digest (30d volume/resolution/sentiment across their projects), feedback rollup
  (open items by kind), open opportunities + proposals w/ status, recent briefs mentioning them,
  quick actions (view analytics, share report). READ-ONLY composition of existing queries —
  new SQL only for light aggregation across a client's projects.
- Tests: aggregation math vs hand-built rows (multi-project client), cross-org 404.

### P8-WIZARD — Guided onboarding (Sonnet 5; flow)
- `apps/web/app/projects/new/` becomes a stepper (keep the existing quick form reachable):
  1 client (pick/create) → 2 intake (optional transcript paste/dictation → drafted details;
  reuse the EXISTING intake flow + components, do not fork) → 3 details + TRACKING PLAN preview
  (lib/tracking-presets by type; toggles) → 4 keys + snippets (created on submit; reuse
  SnippetTabs pieces read-only + the feedback widget card) → 5 LIVE CHECK: poll the ticker/events
  API until the first event arrives ("✓ first event received" w/ type) with a skip.
  State client-side; single create call at step 4 (reuse the existing create API).
- Tests: stepper state transitions, create payload matches the API contract, live-check polling
  renders the arrived-event state (mock fetch).

## Wave 2 (2 parallel, after Wave 1 gate)

### P8-GROWTH2 — Proposal send + track + won→project (Sonnet 5)
- Growth board: "Send" on a ready proposal → share_tokens kind=proposal (via P8-REPORT's
  share.ts) → public `share/[token]` renders the client-ready proposal doc (same white-label
  shell); status auto → sent; board shows "viewed Nx · last seen" from token stats.
- Won proposal → "Create project" → prefills the onboarding wizard (P8-WIZARD) step 3 from the
  proposal (title/problem/price → build fee) + the client preselected.
- Tests: send creates token + flips status, viewed stats surface, won→wizard prefill mapping.

### P8-BENCH — Benchmarks layer (Opus 4.8; cross-client math)
- `apps/web/lib/server/benchmarks.ts`: per industry + metric key, compute p25/p50/p75 across
  that industry's ACTIVE projects from metric_rollups (London windows), ONLY when ≥3 distinct
  clients (else return null — anonymity floor). Deterministic, cached per request.
- `BenchmarkBlock` component filling P8-REPORT's slot: "your X vs industry median" bars for 3-5
  headline metrics; also a benchmark strip on the Client 360. Weave a benchmark block into the
  MONTHLY datapack (packages/agents/src/datapack — this workstream owns that file edit; additive
  field) so the Strategist can reference it (prompt bump, versioned).
- Tests: percentile math vs hand-built rollups, anonymity floor (2 clients → null), report slot
  renders + hides gracefully.

## Done-when (lead gate)
Share link opens the dental client's monthly report logged-out, view count ticks, revoke kills it.
Health grid shows a deliberately-silenced throwaway project as red within one evaluate run, ack
works, recovery auto-resolves. Client 360 numbers match SQL. Wizard onboards a throwaway project
to "first event received" against the local ingest. Proposal sent→viewed→won→wizard prefill loop
works. Benchmarks show p50 bars with ≥3 clients and hide below the floor. Full suite green.

## File ownership (collision map)
REPORT: lib/server/share.ts, app/share/**, app/api/share/**, briefs/client share affordances,
test/share. HEALTH: lib/server/health/**, app/health/**, api/health/**, AppFrame (Health nav row
ONLY), jobs/health-run wiring, test/health. C360: app/clients/[clientId]/** (+ its components),
test/client360. WIZARD: app/projects/new/**, components/onboarding/**, test/onboarding.
GROWTH2: app/growth/** (+ won→wizard link), test/growth2. BENCH: lib/server/benchmarks.ts,
components/BenchmarkBlock.tsx, C360 benchmark strip (coordinate: additive component import),
packages/agents datapack additive field + prompt bump, test/benchmarks. Lead: migration 0009,
gates.
