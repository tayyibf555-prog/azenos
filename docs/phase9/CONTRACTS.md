# Phase 9 — Cost Unification & Power-Pack Analytics (READ FULLY BEFORE WRITING CODE)

Binding contracts, lead-authored 2026-07-16. Same ground rules as docs/phase8/CONTRACTS.md
(ANTI-NOISE + BLOCKED escalation, TS strict, pence, London SQL, org-scoping, no new deps,
no schema edits — lead pre-applies migration 0010, graceful no-key degradation, throwaway-org
tests). Design = Quiet Glass. Runs strictly AFTER Phase 8 gates.

Lead pre-work (migration 0010): add `'cost_spike'` to the alertKind enum. Nothing else —
every other Phase 9 need is computable from existing tables (agent_runs, events, rollups,
webhook_deliveries, share_tokens, alert_instances).

## Wave 0 (2 parallel, disjoint — MUST complete before Wave 1; owner directive 2026-07-16:
## "I don't want metrics shown in graphs, I want numbers — easier to read — and a LOT of them")

### P9-W0A — Numbers-first presentation overhaul (Sonnet 5)
- Convert ALL NINE analytics sections (components/analytics/sections/**) to the
  APPLE-THEME.md §Numbers-first rule: each section leads with a dense StatGrid of tiles
  (big tnum value · label · delta chip vs prior equal window, good-direction aware; tiny
  ≤48px axis-less sparkline hint allowed). Charts collapse behind a per-tile/group expand
  (client-side toggle; reuse the EXISTING LineChart/primitives inside the expanded state —
  do not delete them). Heatmaps/donuts → ranked number lists (top value headline + top-3)
  with the visual behind the same expand. SURFACE MORE NUMBERS: every aggregate the routes
  already compute gets a tile (the endpoints stay UNCHANGED — presentation only). Add
  shared components/analytics/StatGrid.tsx + StatTile.tsx + ExpandableChart.tsx; refactor
  sections onto them. Same treatment for the project METRICS tab's chart-led areas
  (components/MetricsTab.tsx: KPI strip stays, charts collapse).
- Tests: StatTile delta/direction logic (pure), a render test that a section shows
  tiles-by-default and no chart until expanded. Suite must stay green.

### P9-W0B — Metric discovery: presets + webhook-driven availability (Sonnet 5)
- apps/web/lib/server/metric-discovery.ts + lib/metric-catalog.ts: a static METRIC_CATALOG
  mapping data signals → metric templates (event type present / field present:
  payment.*+value_pence → attributed revenue & AOV; llm.conversation → conversations,
  resolution %, escalation %, avg turns; booking.* → bookings, no-show %, reschedule %;
  agent.run.completed → runs, success %, p95, cost; minutes_saved → hours saved & £ value;
  agent.feedback → rating; feedback.submitted → feedback volume & bug share; lead.* +
  payment → funnel conversion; message.* → message volume). discoverMetrics(orgId,
  projectId) → { core: [per TRACKING_PRESETS projectType], enabled: [existing
  metric_definitions], available: [catalog matches from ONE scan: select distinct type +
  bool aggregates of value_pence/minutes_saved presence, minus enabled], missing: [preset
  expects, no data — reuse coveragePlan] }.
- Metrics tab UI: an "Available to add (N)" panel — one-click add creates the
  metric_definitions row via the EXISTING preview/create API (no new write path); each
  row shows why it unlocked ("payment.captured seen 214×"). Do NOT touch analytics
  sections (W0A owns them).
- Tests: catalog→discovery on hand-built events in a throwaway org (payment events →
  revenue metrics available; none → absent); one-click add path hits the existing create
  API; preset core resolution per projectType.



### P9-COST — Unified API Usage & Cost + billing v2 (Opus 4.8; money correctness)
- New analytics section (rail #10) "API Cost": apps/web/app/api/projects/[projectId]/analytics/
  api-cost/route.ts + components/analytics/sections/ApiCostSection.tsx (+ append the rail entry
  in AnalyticsWorkspace — additive, do not reorder). Merge TWO cost streams, clearly labelled:
  (a) OS costs — agent_runs for this project (tokens, cost_estimate_pence, by os_agent kind);
  (b) client-emitted costs — events type agent.run.completed data.cost_pence/tokens (their own
  systems), grouped by data.provider when present ('anthropic'|'openai'|'twilio'|'higgsfield'|
  other). Metrics: spend by stream + provider over the range (series, London days), tokens
  in/out trends, cost-per-conversation (spend ÷ llm.conversation count), cost-per-resolution,
  £-PER-OUTCOME (spend ÷ payment/booking outcomes — label honestly "attributed"), top costly
  runs leaderboard. Empty states everywhere.
- Billing v2: extend the EXISTING /api/money/cost-statements: per-provider line items; OS costs
  keep the markup convention. Do not break the existing statement shape — additive fields only.
  LEAD RULING 2026-07-16: BOTH cost streams — OS (agent_runs) and client-system AI
  (tokens_cost_pence rollup) — are billed WITH the client markup by DEFAULT
  (include_client_emitted defaults to TRUE), so the v2 default reproduces the v1 statement total
  exactly (v1 marked up os+client-system-AI combined; no retroactive restatement). The two
  streams stay as SEPARATE labelled line items ("OS agents" vs "client-system AI") that reconcile
  to the client billable. include_client_emitted=false EXCLUDES the client-system AI stream from
  billing (display-only block) for clients who bring their own keys. The event-spine
  agent.run.completed per-provider lines remain provider detail on that stream.
- Margin per client: extend the Money screen's revenue-by-client area with margin, MTD + prior
  month. Reuse existing queries where they exist. LEAD RULING 2026-07-16: margin = retainer +
  billable-markup spread summed over every stream ACTUALLY BILLED under the statement default
  (billable − cost per stream, i.e. OS + client-system AI). The reimbursed cost is NOT subtracted
  — the statement bills it back to the client (e.g. £1000 retainer / £10 OS cost / 20% markup →
  £1002 margin).
- Cost alert: extend the Phase-8 health evaluator (coordinate: ADDITIVE rule function, own file
  lib/server/health/rules/cost-spike.ts): client OS+emitted spend this-7d > 1.4× prior-7d AND
  > £5 absolute → alert_instances kind cost_spike severity warn. Test the threshold math.
- Tests: stream merge math vs hand-built rows, statement backwards-compat + new line items,
  margin math, spike rule boundaries (1.39× no, 1.41× yes, sub-£5 never).
- Update tracking presets: add agent.run.completed guidance note that client systems SHOULD send
  data.provider + data.cost_pence (tracking-presets.ts additive comment/recommended list only).

### P9-PACK1 — Goals, pacing & forecasts (Sonnet 5)
- lib/server/pacing.ts: for each project goal ({metric, target, period} — projects.goals exists):
  actual-to-date from rollups, expected-to-date = target × elapsed/period (London), pace % and
  on/off-pace flag. Deterministic; unit-tested against hand-built rollups incl. month boundaries.
- Surface: goal pacing bars on the project Overview (additive card) + a pacing strip in the
  analytics Pulse section (you own PulseSection for this additive block only).
- Forecast bands: lib/server/forecast.ts — simple, DETERMINISTIC linear regression over the last
  28 London days → next-7-day band (±1 stddev of residuals); render as a dashed band on the
  Pulse daily-volume chart + Money revenue trend (additive prop on the existing LineChart —
  extend charts/LineChart.tsx additively, do NOT restructure). Label "projection". Tests: known
  series → exact slope/band values; flat/empty series → no band, no crash.

### P9-PACK2 — Behaviour depth (Sonnet 5)
- Engagement section additive blocks: end-user RETENTION cohorts (subjects first-seen week ×
  active in following weeks, 8×8 triangle heatmap over 90d) + channel-shift trend.
- Funnel section additive: stage-to-stage time percentiles p50/p90 (percentile_cont in SQL) +
  a drop-off reasons hint block (top intents of conversations that ended abandoned).
- Conversations & AI additive: first-contact resolution (resolved with turns ≤ threshold from
  the existing convention or ≤3), escalation root-cause clusters (top topics of escalated convos),
  sentiment-by-topic mini-matrix.
- All READ-ONLY SQL in the sections' own route files; no shared-file edits beyond those three
  section pairs. Tests: each aggregate vs hand-built events (cohort triangle exactness, p50/p90
  vs known durations, FCR boundary).

## Wave 2 (2 parallel, after Wave 1 gate)

### P9-PACK3 — Money depth + data quality + portfolio (Sonnet 5)
- Money section additive: payback period (build fee ÷ monthly attributed value), client LTV
  curve (cumulative agency revenue for this client over months), revenue-concentration note.
- Data-quality card in Custom & Raw: webhook_deliveries rejected/failed rates (7d), duplicate
  rate, unknown-event-type share, tracking-plan coverage % (reuse lib/tracking-presets
  coveragePlan) — with a calm "all clean" state.
- NEW screen app/portfolio/page.tsx + AppFrame nav "Portfolio": all live projects on a value-vs-
  cost quadrant (x = OS+emitted cost MTD, y = attributed value MTD, dot size = events, colour =
  objective health), a ranked ROI table, concentration hero. Read-only composition.
- Tests: payback/LTV math, data-quality rates vs hand-built deliveries, quadrant data endpoint.

### P9-KB — Content-gap → deliverables + churn risk (Opus 4.8; agent + scoring)
- packages/agents/src/agents/kb-gaps.ts: runKbGapMiner(db, {orgId, projectId}) — deterministic
  pack of the Conversations&AI "content gap" questions (frequent + escalating/negative) →
  runAgent (graceful no-key) drafting SUGGESTED KB ARTICLES / bot-improvement briefs →
  insights kind automation_opportunity with evidence.content_gap=true + the draft in evidence
  (these flow into the EXISTING Growth pipeline as sellable work). Fingerprint-dedup like
  convo-cluster. CLI kb:run script line. Tests with mocked runAgent.
- Churn-risk score: lib/server/churn.ts — deterministic 0-100 composite per client (weights
  pinned in code: engagement trend 30%, sentiment trend 20%, feedback bug-spike 15%, payment
  lag/past_due 20%, silence 15%); surfaced as a chip on Client 360 + a column in the Health grid
  (coordinate: additive component/prop, Phase-8 files exist by now). Tests: hand-built scenarios
  hit expected bands (healthy <25, watch 25-60, risk >60).

## Done-when (lead gate)
API-Cost section shows both streams for the dental project and the statement's new line items
reconcile to SQL exactly; margin per client matches hand math; a simulated spend spike fires
cost_spike once and auto-resolves. Goal pacing matches hand math on a mid-month day; forecast
bands render deterministically. Cohort triangle/percentiles/FCR reproduce hand-built fixtures.
Portfolio quadrant + payback + data-quality live. KB-gap miner writes deduped opportunity
insights (mocked run) that appear in Growth. Churn chips render with pinned-weight scores.
Full suite green; browser sweep clean.

## File ownership
COST: analytics api-cost pair + AnalyticsWorkspace additive entry, money cost-statements +
margin area, health/rules/cost-spike.ts, tracking-presets additive note, test/api-cost.
PACK1: lib/server/{pacing,forecast}.ts, Overview pacing card, Pulse additive strip+band,
charts/LineChart additive band prop, test/pacing. PACK2: engagement/funnel/conversations-ai
section pairs (additive blocks), test/behaviour. PACK3: Money section additive, Custom
data-quality card, app/portfolio/** + AppFrame Portfolio nav row, test/portfolio. KB:
packages/agents kb-gaps + prompts + cli + test, lib/server/churn.ts, C360 chip + Health column
(additive), test/churn. Lead: migration 0010, gates.
