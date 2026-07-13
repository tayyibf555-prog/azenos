# Decisions & deviations log

Per spec §18.6: when the spec conflicts with reality, choose the pragmatic
path and record it here.

## 2026-07-11 — Spec review + amendments (pre-build)

The spec was reviewed and amended before any code: payments two-ledger rule
pinned (§6.3), `events.project_id` made nullable, `webhook_deliveries` +
`alert_rules` added (§4.8), key-rotation semantics pinned (public key stable,
secret rotates), Voyage AI embeddings at 1024 dims, Trigger.dev committed,
Ask Azen agent added (§9.8/§5.9/Phase 3b). See the spec's git history.

## 2026-07-12 — Phase 0 build decisions

1. **Model IDs pinned** (spec §18.4, verified against Anthropic docs at build
   time): `AGENT_MODEL` and `CHAT_MODEL` = `claude-sonnet-5`;
   `EMBEDDING_MODEL` = `voyage-3.5` @ 1024 dims. One place:
   `packages/config/src/index.ts`, env-overridable.

2. **Local dev DB = Homebrew postgresql@17 + pgvector, not Docker/Supabase
   local.** The host disk was critically full (415/460GB) and Docker
   Desktop's VM wedged mid-pull; native Postgres needs ~150MB vs multi-GB
   for the VM. `docker-compose.dev.yml` is kept (`pnpm db:local:docker`) for
   machines with headroom. Hosted Supabase remains the deploy target: the
   RLS migration stubs `auth.uid()`/`authenticated` only when absent, so it
   applies cleanly on Supabase; `apps/web` auth activates when `SUPABASE_*`
   env vars are set.

3. **`org_id` denormalized onto every table** (spec §4 preamble says no table
   may reference data without an org_id; the §4 table sketches omitted it on
   children). Buys a uniform RLS policy (`org_id = current_org_id()`) and
   join-free analytics. Uniform policy created in migration
   `0001_rls-and-roles.sql`.

4. **§7 taxonomy count is 41 types**, not the "39" that circulated during
   planning (6 leads + 5 bookings + 9 money + 6 agents + 1 llm + 6 comms +
   5 ops + 3 system). All 41 implemented + `custom.*`.

5. **Extensionless relative imports in TS packages.** NodeNext-style `./x.js`
   specifiers broke Next's webpack resolution of transpiled workspace
   packages. All internal packages are consumed as TS source (tsx, vitest,
   Next transpilePackages), so extensionless is correct everywhere. If a
   package is ever compiled for plain Node, revisit.

6. **Seed day boundaries are Europe/London calendar dates**
   (`packages/db/src/seed/time.ts`). The first cut used UTC "today" and the
   whole 90-day window shifted by a day when run 23:00–01:00 London — exactly
   the §13 day-boundary bug class. Rollup jobs (Phase 2) must carry the
   London-boundary tests the spec mandates.

7. **Ask Azen read-only DB role** (`azen_readonly`, `DATABASE_URL_RO`) is
   created in migration 0001 with SELECT-only grants + 5s statement timeout.
   Local password is a dev default — MUST be rotated when applied to hosted
   Supabase.

8. **pnpm ignored esbuild/sharp postinstall scripts** (pnpm v10 default).
   Everything works (esbuild resolves via optional deps); if `sharp` is ever
   needed at runtime (image work), run `pnpm approve-builds`.

## 2026-07-12 — Phase 1 build decisions (ingestion + projects)

Built by four Opus 4.8 subagents under lead-pinned contracts
(docs/phase1/CONTRACTS.md); every workstream line-reviewed, integration-fixed,
and E2E-verified in the browser by the lead. 108 tests across the workspace.

9.  **Ingest secrets are encrypted, not hashed.** Spec §6.1 said "stored
    hashed", but a hash cannot verify an HMAC signature (§6.2) — the server
    must recompute HMAC(secret, body). Resolution: `secret_hash` (sha256)
    kept for token-mode compare; `secret_ciphertext` (AES-256-GCM under
    `INGEST_SECRET_ENC_KEY`, migration 0002) decrypted only inside ingest
    verify and test-event send. Plaintext still shown once, never returned by
    read APIs. Standard practice for webhook signing keys (Stripe/Svix).
10. **Rotation has no grace period** (§6.1 read literally): new secret on the
    same public key, old secret dies instantly — the UI modal says so.
    Revocation issues a whole new pair (URL changes). Verified E2E: old
    secret → 401 the second after rotate.
11. **Rate limiting**: Upstash REST (plain fetch, no SDK) when env vars
    exist; otherwise a Postgres fixed 10s window on UNLOGGED
    `ingest_rate_counters` (migration 0002). Fail-open on Upstash outage —
    never drop client data over infra hiccups. Per-key override column
    `rate_limit_per_10s` (default 100).
12. **Live UI is polling, not Supabase Realtime** (no hosted Supabase
    locally): ticker 2.5s, events auto-refresh 5s, first-event listener 2s —
    all through one `usePolling` hook that pauses on `document.hidden`.
    Realtime broadcast slots in when the hosted project exists (§5.1);
    the <5s done-when is met by polling.
13. **`waitUntil` fallback**: reactions run via dynamic import of
    `@vercel/functions` with a detached-promise fallback
    (apps/web/lib/server/after.ts) — zero local deps; add the package when
    deploying to Vercel.
14. **Delivery-log boundaries**: unknown/revoked keys and oversize (413)
    requests get no `webhook_deliveries` row (org unknowable / body unread
    by design); auth failures log the real reason server-side while callers
    get generic 401 (§15). Raw payload kept only on `rejected` rows
    (dead-letter); replay re-runs pipeline steps 5–10 from the Setup tab.
15. **Event `source` mapping**: hmac-auth keys → `sdk`, token-auth keys →
    `ghl` (token mode exists for no-code callers per §6.3).
16. **Seed booking coherence fix**: Phase 0 generators gave lifecycle
    booking events random `booking_id`s that matched nothing. Now
    cancelled/no_show reference a real created booking from the same day, so
    ingest mirroring flips statuses in simulated days too. The sender
    contract: lifecycle events carry the `booking_id` from `booking.created`.
17. **postgres-js + raw `sql` fragments**: params in raw fragments bypass
    drizzle's column encoders/decoders BOTH ways — pass Dates as
    `.toISOString()` + `::timestamptz`, and expect timestamptz aggregates
    (`max(occurred_at)`) back as strings. Two E2E bugs from this; helpers
    now normalize (queries.ts, project pages).
18. **Latent multi-tenancy constraint** (flagged, not fixed):
    `projects.slug` and `industries.slug` are globally unique — cross-org
    collisions would 500. Harmless single-org; revisit before real
    multi-tenancy (Phase 7+).

## Owner to-dos (external lead-time items, spec §14 Phase 0)

- [ ] Create the hosted Supabase project; fill `SUPABASE_URL`,
      `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, switch `DATABASE_URL`
      to the pooler URL for deploys; create the owner login (email + TOTP).
- [ ] Kick off Twilio WhatsApp sender registration + Meta template approval
      (gates Phase 3 delivery — days-to-weeks lead time).
- [ ] Secure the npm `@azen` scope and PyPI `azen-os` name (gates SDK
      publishing).
- [ ] Lock the production ingest domain (spec §6.1) before the first live
      client integration.
- [ ] Free disk space on this Mac — it hit 100% full (415/460GB) during
      Phase 0 and destabilized Docker; ~11GB of app caches exist
      (`~/Library/Caches`), plus Adobe/Chrome caches are 5.5GB alone.

## 2026-07-13 — Phase 2 close-out (metrics engine + intake), verified

Built by Opus 4.8 subagents in ultracode Workflows under lead contracts
(docs/ORCHESTRATION.md); lead-reviewed, independently re-tested, and
browser-E2E'd. 178 workspace tests green. Done-when (§14) met: ROI/metric
numbers hand-verified against SQL (revenue 999900p, minutes 2505, token cost
770p all match rollups exactly; ROI 9.32×), and a custom JSONPath metric
runs the full preview→create(201)→dup(409)→delete(200) lifecycle from the UI.

19. **Rollup engine = incremental watermark, London/DST-correct.** The ONLY
    writer to metric_rollups. Day/week/month buckets via
    `date_trunc(..., occurred_at at time zone 'Europe/London') at time zone
    'Europe/London'` — DST-correct by construction (23h/25h days asserted in
    tests). Watermark = now_cutoff (not max received_at) so late events
    self-heal. §8.1 KPI pack + 8 added globals; anomaly detector z≥2.5 vs
    trailing 28 complete London days → insights (deduped per project+metric).
20. **Derived ratio metrics are computed in the API, clamped 0–100.**
    agent_success_rate / escalation_rate / no_show_rate divide two
    underlying series per bucket; numerator/denominator count disjoint
    populations, so a raw ratio can exceed 100% (e.g. no-shows for bookings
    created on earlier days) — clamped, null when denominator 0. Charts draw
    null buckets as gaps, not zeros.
21. **`eventsToday` live counter now uses the rollup engine's SQL London-day
    boundary, not the JS `londonTodayUTC()` helper.** That helper returns
    UTC-midnight-of-the-London-date (correct for deriving date *strings*, its
    main use) but is an hour late as a *timestamp* boundary during BST, so
    "events today" under-counted the first UTC-hour of each London day. Both
    call sites (listProjects, projects page) now use
    `date_trunc('day', now() at time zone 'Europe/London') at time zone
    'Europe/London'` so the live counter and the rollups agree. (Found by a
    date-rollover test failure at the lead gate, not by any agent.)
22. **Transcript intake co-pilot** (owner scope, beyond spec): paste/upload a
    call transcript → Sonnet 5 (AGENT_MODEL) via `messages.parse` +
    `zodOutputFormat` drafts a schema-validated project (matched-or-new
    client, type, £-in-pence, goals, suggested events, honest assumptions) →
    refine chat (text + **OpenAI Whisper** dictation, /api/transcribe, plain
    fetch, MediaRecorder, Web-Speech fallback) → Create hands to the existing
    key-reveal. Every call logged to agent_runs. Graceful-degrades when
    ANTHROPIC_API_KEY / OPENAI_API_KEY are unset (both empty locally).
23. **Client API-cost tracking for billing** (owner requirement): agent_runs
    gained project_id/client_id (migration 0005); two cost streams surfaced
    per project (Overview "BILLABLE TO CLIENT" card) and per client
    (/clients month-to-date column + /api/costs): client-system model spend
    (tokens_cost_pence rollup from event data.cost_pence) + OS-agent spend
    (agent_runs.cost_estimate_pence). Invoicing/markup lands with Money
    (Phase 4); this is the tracked source of truth.
24. **Orchestration hardening** (docs/ORCHESTRATION.md): the M3-UI builder
    followed injected mid-task noise and abandoned ~60% of its work with a
    garbage report; the verify stage catches bugs in code that EXISTS but not
    ABSENCE. Standing mitigations: an explicit anti-noise clause in every
    agent brief, the lead never trusting self-reports (ground truth =
    typecheck/tests/file-inventory/SQL), and build→verify→refute→fix loops.
    Recovery: lead hand-fixed the type errors + stale test, then ran a
    hardened single-builder completion workflow.

## 2026-07-13 — Phase 3 close-out (Daily Brief + delivery), verified

Built as a two-wave ultracode Workflow (23 Opus 4.8 agents) under
docs/phase3/CONTRACTS.md; lead-gated. 200 workspace tests green. Done-when
(§14) met on the deterministic path: the data pack matches SQL EXACTLY
(AI Receptionist revenue 129000p, Quote Bot 6 errors, 16 client bookings,
MRR 325000p all identical to independent queries); email renders (8840 bytes
HTML + text), delivery returns typed results in dryRun and degrades
gracefully; the brief CLI fails clean (anthropic_auth) without a key; Briefs
screen + Command Center v1 (Today column + inline brief) render. LIVE brief
generation needs ANTHROPIC_API_KEY (owner) — until then the agent path is
proven with a mocked client, the data pack against SQL.

25. **The fleet runner chassis** (`@azen/agents` → runAgent) — every current
    and future agent runs through it: one messages.parse + zodOutputFormat,
    retry-once-on-null, agent_runs logging (model/tokens/cost + project/
    client attribution), and a budget guard. Cost formula matches intake
    (USD-cents≈pence v1). Deterministic data packs (buildAgencyDailyPack) —
    agents receive curated JSON, never query the DB (§9), so runs are cheap,
    auditable (data_snapshot), and testable against SQL.
26. **Budget guard fails CLOSED for non-critical runs** (adversarial finding,
    fixed): if checkBudget throws, non-critical agents return budget_exceeded
    rather than proceeding; only `critical:true` (the daily brief, §13) runs
    regardless. Halt at 100% of AGENT_BUDGET_PENCE_MONTHLY, warn at 80%.
27. **Delivery is plain-fetch, no SDKs** (Resend + Twilio REST), React Email
    for the template (@react-email/components — the one new dep group, lead-
    added). Every sender + the deliverBrief orchestrator degrade to typed
    *_not_configured / no_recipient results and never throw (render wrapped in
    try/catch — adversarial finding, fixed). WhatsApp→SMS only after two
    WhatsApp failures (§9.7). dryRun returns would-send payloads (how it's
    demoed without keys). Approved-template requirement for the 24h window is
    noted for production.
28. **Trigger.dev job def is defensively importable** — jobs/daily-brief.ts
    (cron 0 7 * * * Europe/London) typechecks and the repo builds WITHOUT
    @trigger.dev/sdk installed (stub + comment); local scheduling is the
    `pnpm --filter @azen/agents brief:run` CLI. Trigger.dev deploy = owner
    to-do.
29. **Cross-package JSX build fix** (lead): consuming @azen/emails TS source
    from @azen/agents made tsc follow into the .tsx under the wrong config —
    added `jsx: react-jsx` to tsconfig.base.json + @types/react to
    packages/agents so any package following a .tsx import compiles it.
30. **Ask Azen run_sql core built by the lead ahead of Phase 3b** — the
    guarded read-only SQL (`@azen/db/readonly`, DATABASE_URL_RO): SELECT/WITH
    only, single-statement, keyword denylist (write/DDL/side-effect + comment/
    literal stripping so keywords can't hide), enforced outer LIMIT, runs as
    the SELECT-only azen_readonly role with a 5s timeout (defense in depth).
    Verified 14/14 validation cases + live (LIMIT overrides inner limit,
    writes blocked). §15: single-owner v1 only; revisit before client-facing.

## 2026-07-13 — Phase 3b close-out (Ask Azen), verified

Two-wave ultracode Workflow (22 Opus 4.8 agents) under docs/phase3b/CONTRACTS.md;
lead-gated. 228 workspace tests green. Verified: /api/ask degrades cleanly
without a key (SSE `error: ANTHROPIC_API_KEY not set`, no 500); the tool belt
answers real data (get_business_snapshot MRR £3,250 / 222 bookings; run_sql
counts 10,191 events and BLOCKS a delete through the tool path); Ask screen +
command-K render, nav enabled. Live answers need ANTHROPIC_API_KEY (owner) —
until then the loop is proven with a mocked client + tools against SQL.

31. **Read-only tool belt** (apps/web/lib/server/ask/tools) — a typed registry
    ASK_TOOLS; `runTool(name,orgId,input)` is the single validated entry point
    (unknown tool / zod-invalid / thrown error all become `{ok:false,error}`
    so the loop can always feed a tool_result back). All tools org-scoped
    except run_sql (the escape hatch, §15). search_knowledge is a stub until
    Phase 6.
32. **Three latent tool bugs caught by adversarial verify, all fixed:**
    metric-series truncation was keeping the OLDEST 400 points (now
    slice(-cap) → newest); list_payments ordered `paid_at desc` with Postgres
    NULLS FIRST floating pending rows to the top (now `desc nulls last`);
    the bare-date range helper used a UTC-midnight boundary while the rollups
    use Europe/London (now London for both, so cross-tool day counts agree).
    All three are invisible on seed data but real once Stripe/CSV data lands —
    exactly what the verify stage is for.
33. **Chat cost counts against the fleet budget** (§13): checkBudget
    (@azen/agents, lead-extended) now sums BOTH agent_runs.costEstimatePence
    AND chat_messages.costEstimatePence for the London month; the /api/ask
    route halts with a canned message (zero model calls) at 100%.

## Known non-blocking issue
- The ingest→rollup reaction (react.ts, Phase 2) logs a caught
  DrizzleQueryError in web tests that use throwaway orgs lacking rollup setup.
  All tests pass (it's best-effort + caught), and the engine works on real
  data. Tracked to silence (skip cleanly when no metric_definitions/watermark).

## 2026-07-13 — Phase 4 close-out (Money + Bookings + client invoicing), verified

Two-wave ultracode Workflow (27 Opus 4.8 agents) under docs/phase4/CONTRACTS.md;
lead-gated. 275 workspace tests green, typecheck clean. Done-when (§14) met:
two-ledger rule holds (agency payments = build_fee/retainer only; 166 client
end-customer payment.captured events stay in events; 0 leak into payments —
verified before AND after the sims); Stripe + Calendly hooks work E2E via
signed simulators (invoice.paid → £500 agency payment; invitee.created →
booking; both signature-verified, no live accounts); Money screen renders all
§5.4 elements with correct numbers (MRR £3,250, overdue retainer £750,
per-project margin, revenue-by-client + LTV); cost-statement invoicing math
verified (Sarah Mitchell £7.70 cost × 50% = £11.55 billable).

34. **Two adversarially-caught money-correctness bugs, fixed:** (a) invoice
    idempotency keyed only on externalId DROPPED a failed→paid dunning
    transition (invoice stuck 'failed' forever, understating cash-in) — now
    updates the existing row to paid; (b) subscription amountPenceMonthly took
    price.unit_amount verbatim, so a yearly retainer read as 12× MRR — now
    normalizes by recurring.interval (year ÷ 12). Both invisible on seed data;
    exactly the money-accuracy class the verify stage exists to catch.
35. **Webhook signature verification is plain node:crypto** (no Stripe/Twilio
    SDKs) — verifyStripeSignature/verifyCalendlySignature, constant-time, ±5min,
    the t=,v1= HMAC scheme mirroring @azen/events/signing. Local demo needs
    STRIPE_WEBHOOK_SECRET + CALENDLY_WEBHOOK_SIGNING_KEY set to any shared local
    value (the sim signs with the same secret the hook verifies) — set to
    whsec_localdev_* / calsign_localdev_* in .env. Approved-template WhatsApp
    requirement for prod is noted.
36. **Client cost invoicing** (owner requirement): clients.cost_markup_pct
    (migration 0006, null → DEFAULT_COST_MARKUP_PCT=0) → /api/money/cost-
    statements computes billable = attributed API cost × (1 + markup/100),
    per-project line items. Reuses Phase 2 getCostsByClient. Actual invoice
    documents are Phase 7+; this is the tracked billable source of truth.
37. **Lead gate caught a real sim bug:** simulate-money.ts loaded .env from
    `../../../.env` (copied from client.ts) but sits one dir deeper in seed/,
    resolving to packages/.env — fixed to `../../../../.env`. Without it the
    simulators could never find the webhook secrets.

## Known operational papercut (tracked)
- seed:demo does NOT populate metric_rollups (reseed cascade-wipes them; the
  incremental rollup:run finds 0 buckets on historical events). Run
  `pnpm --filter @azen/db rollup:run --force` after any reseed or the Metrics
  tab / Money margins / cost-statements show £0. Fix: seed should call
  runRollups({force:true}) at the end (task #29).

## 2026-07-13 — Phase 5 close-out (weekly/monthly agents + conversation intelligence), verified

Two-wave ultracode Workflow (17 Opus 4.8 agents) under docs/phase5/CONTRACTS.md;
lead-gated. 303 workspace tests green. NOTE: 5 of the Wave-2 verify/refute
agents died on TRANSIENT SSL errors (API infra, not code), so the weekly/
monthly adversarial net had holes — the LEAD covered that gap by verifying the
monthly + weekly data packs directly against SQL. Done-when (§14): the monthly
MRR bridge is correct (start £3,250 + gained £0 − lost £0 = end £3,250; the
0-moves validated — 0 subs started/cancelled in July); weekly scoreboard reads
5 KPIs + the daily briefs (0 without a key, expected); Conversations + Agents
tabs render correct aggregates. Live agent narrative needs ANTHROPIC_API_KEY —
proven with mocked runAgent + packs against SQL.

38. **Conversation clustering** (packages/agents convo-cluster) turns
    llm.conversation events into faq_cluster insights (deterministic 7-day
    London pack → runAgent → idempotent fingerprinted writes). Unautomated-
    repetition clusters get evidence.scout_candidate=true for the Phase 6
    Scout. Conversations tab (pure SQL) shows topics/resolution/escalation/
    sentiment/volume.
39. **Label-drift retirement** (adversarial finding, fixed): fingerprint dedup
    only held for byte-identical topic labels; "Booking"→"Bookings" drift left
    orphan faq_cluster rows with frozen counts. Now each run retires this
    project's stale unactioned faq_cluster insights (not seen this run),
    preserving actioned/dismissed ones.
40. **Agents tab** (pure SQL, no LLM): per registered agent from
    agent.heartbeat/run.completed/escalated — status, runs, success rate,
    tokens/cost, minutes saved, per-agent ROI (minutesSaved/60 × hourlyRate ÷
    cost, matching Phase 2 ROI convention).
41. **Monthly Strategist = 3 documents** (§9.3) from ONE runAgent call
    ({owner_report, client_reports[], upsell_dossiers[]}) fanned out to briefs
    rows; the MRR bridge (gained/lost/net) is deterministic in the pack. Weekly
    Synthesizer references its own prior edition (fetched into the pack).
    Dismissed insights are included in the monthly pack (§9.3 "it learns what
    Tayyib ignores").

## Phase 6 — Opportunity Scout · Upsell Engine · Industry Learning · Python SDK — CLOSED 2026-07-13

The FINAL build phase; closes the spec's Phase 0–6. Built via ultracode workflows
(Fable plans/gates, Opus 4.8 builds + adversarial verify→refute→fix). Wave 1
(Scout + Python SDK/GHL) landed clean; Wave 2 (Growth/Upsell + Learn) was hit by a
transient API/network outage mid-run that killed all its builders — see #46.
Recovered by a serialized Wave-2 rebuild. Gate: **360 tests green** (events 24,
sdk-node 31, agents 58, web 234, python 13), typecheck green; all six §14 done-when
criteria PASS (zero blocking fails); Phase 0–5 conformance audit clean (0 true gaps
across §4/§6.2/§7/§10/§12).

42. **Opportunity Scout** (packages/agents scout.ts, §9.4) — deterministic 30-day
    per-project pack: faq_cluster scout_candidates, agent.escalated patterns,
    repetitive human task.completed, error/dropoff, and UNUSED TAXONOMY AREAS (a
    project emitting booking.* but no payment.* → "payment collection not
    automated" — pure SQL, tested against hand-built events). → runAgent
    (ScoutOutput) → automation_opportunity insights (evidence event_ids +
    aggregates, estimatedValue/hoursSaved/confidence, project+slug fingerprint
    dedup + retirement à la convo-cluster). Insights tab enabled with evidence
    drilldown. jobs/scout.ts + scout:run. Gate: the unused-taxonomy detector fires
    correctly (Recall Reminders flagged: bookings, no payments; AI Receptionist
    NOT flagged: it has payments) and pack signals ≥3 against real seed data;
    live opportunity WRITES need ANTHROPIC_API_KEY (graceful path verified).
43. **Python SDK azen_os + GHL preset** (packages/sdk-python, §6.2/§6.4) — mirrors
    @azen/os-sdk (track/conversation/heartbeat/metric, fire-and-forget, backoff+
    jitter, never raises). HMAC signing byte-identical to @azen/events/signing,
    guarded by a pinned cross-language signature vector (pytest) — the gate
    independently recomputed both hexes and confirmed they match. GHL
    ghl-default-v1 mapping (contact/appointment/pipeline/form webhooks → taxonomy
    events, validated with parseEvent) + POST /integrations/ghl + Setup snippet.
44. **Upsell Engine + Growth pipeline** (packages/agents upsell.ts, §9.5) —
    reviewed/high-confidence insights → runAgent (UpsellOutput) → one
    upsell_proposals row (draft, insightIds=sources), every claim traced to
    evidence (hallucinated event ids filtered). Growth screen: pipeline →
    convert-to-proposal → draft→ready→sent→won→lost board + won-revenue
    attribution + client-ready proposal document. Idempotent: a converted insight
    can't be re-loaded — both entry paths share the not-dismissed/not-converted
    predicate (adversarial fix; the single-insight path had dropped it).
45. **Industry Learning + pgvector retrieval** (packages/agents learn.ts +
    apps/web knowledge.ts, §9.6) — anonymized aggregate pattern pack across an
    industry's projects → runAgent (native web_search tool-loop, logged to
    agent_runs) → knowledge_articles (primer/digest/pattern/playbook; playbook
    only when a pattern recurs across ≥2 clients), each embedded via Voyage
    voyage-3.5/1024 by plain fetch (NO SDK; missing key → embedding null, article
    still written; a Voyage outage never wipes a good stored vector). searchKnowledge
    = Voyage query embed → pgvector cosine with a **0.3 similarity floor**
    (adversarial fix — irrelevant queries return [] not confidently-wrong
    neighbours); missing key / no embeddings → [] gracefully. Ask's
    search_knowledge stub swapped for real retrieval. Learn screen + ALL nav
    unlocked (the LOCKED "later phases" section removed — nothing stays locked).
46. **Network-outage recovery** (ops lesson): a transient API/network outage
    (Connection closed / SSL hostname mismatch / ConnectionRefused / FailedToOpen
    Socket) killed 8 of 24 Phase-6 agents including ALL Wave-2 builders and the W1
    fixer. The verifiers' "Scout absent" criticals were a STALE mid-flight read —
    the lead's independent disk + typecheck + test check proved Wave 1 was actually
    complete. Wave 2 was rebuilt SERIALIZED (Growth then Learn) to remove the
    shared-file race (packages/agents index.ts barrel + AppFrame nav) that
    concurrent builders would hit. Lesson (extends the M3 lesson in ORCHESTRATION):
    adversarial verify catches bugs in code that EXISTS; the lead's file-inventory
    + green-build check is the backstop for code ABSENT because a builder died.

## Known minor — RESOLVED
- (task #30, fixed) ConversationsTab: the ~30-day stat strip vs the 7-day
  "% of the week" cluster shares now read as distinct windows — the FAQ-cluster
  section carries a "Rolling 7-day window …" caption naming both.
