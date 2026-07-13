# Phase 2 build contracts — READ FULLY BEFORE WRITING CODE

Binding interface spec for Phase 2 (metrics engine + transcript intake),
authored by the lead after re-reading spec §5.3, §8, §10, §13, §14. Where
this doc and your instincts disagree, THIS DOC WINS. Deviations from
AZEN_OS_SPEC.md are deliberate and recorded in docs/DECISIONS.md.

Phase 1 ground rules apply unchanged (docs/phase1/CONTRACTS.md §Ground
rules): TS strict, extensionless imports, no new deps, no edits to
package.json/lockfile/migrations/schema, no pnpm install/git/dev servers,
DB at 127.0.0.1:54329 already migrated (0003 adds: projects.hourly_rate_pence,
metric_definitions.where_equals, rollup_watermarks, os_agent_kind
'project_intake'), throwaway-org test hygiene with full cleanup, never
mutate the demo org. Lead-owned files from Phase 1 remain read-only; Phase 1
agent-owned files may be EDITED ONLY where this doc explicitly grants it.

## Metric semantics (workstream M1 implements; M2/M3 consume)

**Definition resolution.** Effective definitions for a project = global
defaults (`metric_definitions.project_id IS NULL`) ∪ project rows; a project
row with the same `key` overrides the global. Seed ships 9 globals; M1 adds
these globals (in seed/demo-data.ts DEFAULT_METRIC_DEFINITIONS, keys exact):
- `events_total` — count, eventType `*`, isKpi false, sort 5
- `calls_handled` — count, `call.completed`, sort 45
- `forms_submitted` — count, `form.submitted`, sort 46
- `payments_captured` — count, `payment.captured`, sort 51
- `avg_transaction_pence` — avg, `payment.captured`, valuePath
  `$.data.amount_pence`, unit pence, sort 52
- `tokens_cost_pence` — sum, `agent.run.completed`, valuePath
  `$.data.cost_pence`, unit pence, goodDirection down, sort 75
- `agent_runs_succeeded` — count, `agent.run.completed`, whereEquals
  `{"$.data.success": true}`, isKpi false, sort 71
- `reviews_avg_rating` — avg, `review.received`, valuePath `$.data.rating`,
  unit count, sort 85
(Reseed after editing demo-data. The §8.1 pack's ratio metrics are DERIVED —
see below — and hours-since-last-event is a live query, not a rollup.)

**valuePath grammar** (tiny subset of JSONPath, implement in SQL):
- `$.value_pence` → events.value_pence; `$.minutes_saved` →
  events.minutes_saved (envelope numerics)
- `$.data.<key>` → `(data->>'<key>')::numeric` (one level only; non-numeric
  or missing → row contributes nothing (NULL — excluded from count/sum/avg))
- null valuePath + aggregation count → count rows; null + sum/avg → invalid
  definition, skip with console.warn.

**whereEquals**: map of path→scalar, ANDed equality. Paths use the same
grammar (`$.data.success`, `$.type` not allowed — eventType field covers
type). Compare as text: `data->>'success' = 'true'` (booleans/numbers
stringify). Null/absent map = no filter.

**eventType**: exact match, or `*` = all types.

**Aggregations**: count (matching rows), sum, avg (weighted recombination
uses sampleCount), p95 (`percentile_cont(0.95)`), last (value of the
matching row with max occurred_at in bucket), rate (compute as count;
readers label it per-day). sampleCount = matching rows in bucket (for count,
sampleCount = value).

## Rollup engine (M1) — packages/db/src/rollup/

**Bucket definitions** (all periodStart values are UTC instants):
- hour: `date_trunc('hour', occurred_at)` (UTC clock hours)
- day: `date_trunc('day', occurred_at AT TIME ZONE 'Europe/London') AT TIME
  ZONE 'Europe/London'` — the §13 London boundary, DST-correct via Postgres
- week: same with `date_trunc('week', ...)` (ISO Monday, London)
- month: same with `date_trunc('month', ...)`

**Incremental algorithm** (idempotent, late-event-proof — the ONLY write
path into metric_rollups):
1. Per project: `wm = rollup_watermarks.processed_through` (missing row =
   epoch). `now_cutoff = now()`.
2. Find affected windows: `SELECT DISTINCT` the four bucket starts for every
   event with `received_at > wm AND received_at <= now_cutoff` (org/project
   scoped). No affected events → advance watermark, done.
3. For each affected (period, periodStart) bucket and each effective metric
   definition: recompute the aggregate over ALL events in that bucket
   (occurred_at within [periodStart, periodEnd)), matching
   eventType/whereEquals/valuePath. Upsert into metric_rollups (PK
   project+metricKey+period+periodStart); DELETE rollup rows for
   (project, period, periodStart, metricKey) whose recomputed aggregate has
   zero matching rows (a bucket can empty out only via def changes — cheap
   to handle with delete-then-insert per bucket inside a transaction).
4. Advance watermark to now_cutoff (NOT max(received_at) — clock-based so
   concurrent inserts during the run are re-scanned next run).
5. Buckets per run capped at 500 (log + continue next run if exceeded).

Delete-then-insert per (project, period, periodStart) in one transaction is
the recommended shape — simplest provably-idempotent form.

**Entry points** (exported from `@azen/db` root, single export block added
to packages/db/src/index.ts — M1 owns this edit):
- `runRollups(db, {orgId?, projectId?, force?}): Promise<RollupRunSummary>`
  — all projects (or one); `force` ignores watermark and recomputes last 90
  days (used by backfill CLI).
- `runIncrementalRollupForProject(db, orgId, projectId): Promise<void>` —
  what ingest calls post-response.
- CLI: packages/db/src/rollup/cli.ts, package.json script `rollup:run`
  (`tsx src/rollup/cli.ts [--project=<slug>] [--force]`) — M1 MAY add this
  ONE script line to packages/db/package.json scripts (only line it may
  touch there). Root turbo scripts: lead wires later.

**Ingest hook**: M1 edits apps/web/lib/server/ingest/react.ts (Phase 1 file,
edit granted): inside the existing runAfterResponse callback, after the
error-streak block, call `runIncrementalRollupForProject(db, input.orgId,
input.projectId)` wrapped in try/catch(console.error). Insert-only edit —
do not restructure the file.

**Anomaly detector** (§8.4) — packages/db/src/rollup/anomaly.ts, invoked at
the end of runRollups for each project whose day-buckets changed: for each
KPI definition (isKpi=true), take the latest COMPLETE London day (yesterday;
skip today), compare vs trailing 28 complete days' rollup values (need ≥ 8
samples, σ > 0). |z| ≥ 2.5 → insert insights row (kind `anomaly`, confidence
`med`, status `new`, createdBy `agent`, title `"<Project>: <metric name>
<up|down> vs 28-day normal"`, bodyMd with value/mean/σ/z to 2dp, evidence
`{metric_key, period_start, value, mean, std, z}`) UNLESS an insights row
with kind anomaly + status new already exists for the same
project+metric_key (check evidence->>'metric_key'). The Phase 1 error_streak
reaction stays untouched.

**Tests** (packages/db/test/rollup/*.test.ts — vitest; M1 adds vitest+config
NO — vitest is NOT in packages/db devDeps and M1 may not edit package.json
beyond the one script line. Instead put engine tests in
apps/web/test/rollup/*.test.ts where vitest exists, importing from
@azen/db.) MANDATORY cases:
- London day boundary: events at 2026-07-11T22:30Z and 2026-07-11T23:30Z
  land in different London days (BST) — day bucket for the second =
  2026-07-11T23:00Z instant.
- **DST spring forward**: 2026-03-29 London day = periodStart
  2026-03-29T00:00Z and is 23h long — spans [00:00Z, 23:00Z); an event at
  2026-03-29T23:00Z belongs to the NEXT London day. (Corrected 2026-07-12:
  an earlier revision said 22:30Z was next-day — self-contradictory with the
  23h span; M1 followed the primary statement, which stands.)
- **DST fall back**: 2026-10-25 London day = periodStart 2026-10-24T23:00Z
  and is 25h long (event at 2026-10-25T23:30Z is still 2026-10-25 London).
- Idempotency: run twice → identical rollup rows.
- Late event: insert event with old occurred_at after first run → second run
  corrects the old bucket.
- whereEquals filters, avg/p95/last/valuePath extraction, `*` eventType.
- Watermark advance + force recompute.
- Anomaly: construct 29 days of flat rollups + spike day → insight written
  once (second run doesn't duplicate).

## Metrics/read API (M2) — apps/web/app/api/, wave 2

All org-scoped via requireOrgId + withErrorHandling, zod-validated params.
- `GET /api/projects/[projectId]/metrics` → `{definitions:[{key,name,
  description,unit,aggregation,eventType,valuePath,whereEquals,
  goodDirection,isKpi,sort,isCustom}]}` (resolved effective set, sorted).
- `POST /api/projects/[projectId]/metrics` body `{key(^[a-z][a-z0-9_]{1,48}$),
  name,description?,unit,aggregation,eventType,valuePath?,whereEquals?,
  goodDirection?,isKpi?}` → 201 {definition}; 409 duplicate key for project.
  After insert, trigger recompute for last 30 days of that project
  (runRollups force-scoped — M1 exposes what's needed).
- `DELETE /api/projects/[projectId]/metrics/[key]` → project-level custom
  defs only (404 for globals); delete its rollups.
- `POST /api/projects/[projectId]/metrics/preview` body = same as POST →
  `{series:[{periodStart,value,sampleCount}], total, sampleEvents:
  [{id,occurredAt,extracted}] (≤5)}` — evaluates the definition over the
  last 30 London days of raw events WITHOUT writing anything (live preview,
  §8.2).
- `GET /api/projects/[projectId]/metrics/series?keys=a,b,c&period=
  day|hour|week|month&from&to&compare=previous|none` → `{series:{<key>:
  [{periodStart,value}]}, compare?:{<key>:[...]}, meta:{<key>:{name,unit,
  goodDirection,aggregation}}}`. from/to = ISO dates interpreted as London
  days (default last 30 days). compare=previous returns the same-length
  window immediately before `from`. Ratio DERIVED series supported via
  virtual keys: `agent_success_rate` = agent_runs_succeeded/agent_runs,
  `escalation_rate` = escalations/conversations, `no_show_rate` =
  booking.no_show count/bookings_created — computed in the API from the two
  underlying series (unit percent, value 0-100, null when denominator 0).
  Virtual keys are listed in GET metrics with `isDerived:true`.
- `GET /api/projects/[projectId]/roi?month=YYYY-MM` (default current London
  month) → `{revenueAttributedPence, minutesSaved, timeValuePence,
  hourlyRatePence, retainerPence, runCostPence, roiMultiple|null,
  breakdown:{...}}` — §10: (revenue_attributed + minutes_saved/60 *
  hourlyRate) / (retainer + tokens_cost). roiMultiple null when denominator
  is 0. Sum day rollups for the month window.
- `GET /api/overview` — EXTEND (edit C's route+queries): add
  `healthSummary:{green,amber,red}` (live projects by health) and
  `openAnomalies` (insights kind anomaly status new count).
- `GET /api/projects/[projectId]/insights?status=new&limit=20` →
  `{insights:[{id,kind,title,bodyMd,confidence,status,evidence,createdAt}]}`
  + `PATCH /api/insights/[insightId]` `{status: reviewed|dismissed}`.
- `GET /api/projects/sparklines?days=7` → `{sparklines:{<projectId>:
  {metricKey, points:[{day,value}]}}}` — each project's primary KPI = first
  effective def with isKpi by sort that has ANY day-rollup data in window,
  else events_total.
Tests: apps/web/test/metrics-api/*.test.ts — seed a throwaway project with
hand-built events, run M1 engine, assert series/roi/preview numbers EXACTLY
(hand-computed expectations in comments), pagination-free.

## Metrics UI (M3) — wave 2

- **Metrics tab** (enable in project page tabs, remove P2 chip): KPI strip
  (each isKpi def: latest complete day value + Δ vs previous day, colored by
  goodDirection); chart area — SVG LINE charts (hand-rolled, no deps,
  pattern: 640×220 viewBox, path from series, y-axis 3 gridlines w/ labels,
  x-axis first/mid/last date labels, hover dot+tooltip via nearest point,
  compare series as dashed line); controls: range picker (7d/30d/90d/custom
  from-to), granularity (day default, hour for ≤7d, week for ≥60d), compare
  toggle, multi-metric select (chips, max 4 charts rendered). "+ Add metric"
  button → modal form (key auto-slugged from name, event type select from
  taxonomy + seen types, aggregation, valuePath text w/ helper text,
  whereEquals key/value rows, unit, direction, KPI toggle) with LIVE PREVIEW
  panel (calls preview endpoint debounced 500ms, renders mini chart +
  sample extractions) → save → refresh. Custom defs get a delete affordance.
- **Overview tab upgrade**: ROI headline card (roiMultiple big number, "£X
  generated + £Y time saved vs £Z costs this month", honest "attributed"
  labeling per §10, em-dash placeholder when null) + goals vs actuals list
  (project.goals: each goal's metric current period value from series API vs
  target, progress bar) + open insights list (anomaly cards w/
  review/dismiss buttons hitting PATCH).
- **Projects list sparklines**: 7-day SVG sparkline (120×28) per card from
  the sparklines endpoint (one batched fetch, client component).
- **Command Center**: hero strip gains health summary dots (n green/amber/
  red) + open anomalies count linking to first project w/ anomalies (uses
  extended /api/overview).
- Follow existing globals.css tokens/components; London date labels via
  lib/format.ts; no deps.

## Transcript intake (W-INTAKE) — full vertical, wave 1

**Model**: `AGENT_MODEL` from `@azen/config` (claude-sonnet-5 — owner-pinned
spec §18.4; do NOT hardcode the model string; do NOT use another model).
SDK: `@anthropic-ai/sdk` ^0.111.0 (installed). Env: ANTHROPIC_API_KEY (may
be invalid locally — handle cleanly).

**Draft schema** (zod, in apps/web/lib/server/intake/schema.ts) — the wire
contract between agent, refine loop, and UI:
```ts
projectDraftSchema = z.object({
  name: z.string(),                       // ≤200 chars
  client: z.object({
    match: z.enum(["existing", "new"]),
    clientId: z.string().nullable(),      // uuid when match=existing
    name: z.string(),
    industrySlug: z.string().nullable(),  // kebab, e.g. "dental"
  }),
  type: z.enum(projectType.enumValues),
  stack: z.enum(projectStack.enumValues),
  description: z.string(),                // 1-2 sentences, client-facing
  retainerPenceMonthly: z.number().int().nullable(),
  buildFeePence: z.number().int().nullable(),
  hourlyRatePence: z.number().int().nullable(),
  goals: z.array(z.object({ metric: z.string(), target: z.number(),
    period: z.enum(["day","week","month"]) })), // ≤5; metric = a §8.1 key
  suggestedEventTypes: z.array(z.string()),     // from the 41-type taxonomy
  assumptions: z.array(z.string()),       // what the agent inferred/unsure of
})
```
Use `client.messages.parse()` + `zodOutputFormat(projectDraftSchema)` from
"@anthropic-ai/sdk/helpers/zod" (structured outputs — no prefill, no
temperature, max_tokens 4000, non-streaming). Guard `parsed_output` null →
502 {error:"intake_parse_failed"}.

**Routes** (owned): apps/web/app/api/projects/intake/route.ts +
apps/web/lib/server/intake/*.ts
- `POST /api/projects/intake` `{transcript: string (100..100_000 chars)}` →
  `{draft, runId}`. System prompt (versioned FILE
  lib/server/intake/prompt.ts exporting a template fn — spec §13 "agent
  prompts are versioned files"): Azen OS context; the org's existing clients
  (id+name+industry, from DB) so the agent proposes match=existing w/ real
  clientId; the enum values; goal metrics limited to §8.1 keys; retainer/
  build-fee heuristics (£ amounts mentioned in call → pence); UK context;
  "assumptions" must list anything invented. User message = transcript.
- `POST /api/projects/intake/refine` `{draft, instruction: string (1..2000),
  transcript?: string}` → `{draft, note, runId}` — same schema; system
  prompt: current draft JSON + optional original transcript + the user's
  spoken/typed instruction → return the FULL updated draft (not a diff) via
  parse(); `note` = one-sentence summary of what changed (second zod field:
  wrap schema as z.object({draft: projectDraftSchema, note: z.string()})).
- Both: log an `agent_runs` row (kind `project_intake`, status
  succeeded/failed, model, tokensIn/tokensOut from response.usage,
  costPence = round((in*0.03 + out*0.15)/1000) [USD-cents≈pence v1,
  documented], durationMs, inputSummary = first 200 chars, projectId null).
  Check agents.ts schema for exact columns FIRST and adapt.
- Error mapping: Anthropic AuthenticationError → 502
  {error:"anthropic_auth"}; RateLimitError → 429 {error:"anthropic_rate_
  limited"}; other APIError → 502 {error:"intake_failed"} (detail
  console.error only). NEVER surface raw provider errors to the client.
- Client-match validation: if agent returns clientId not in the org's
  client list → coerce match to "new", clientId null (server-side guard).

**UI** (owned): apps/web/app/projects/new/page.tsx + NewProjectForm.tsx MAY
be edited (Phase 1 D files, edit granted) + new components
TranscriptIntake.tsx, IntakeCopilot.tsx, DraftCard.tsx:
- /projects/new gains a mode toggle at top: **"From call transcript"**
  (default) | "Manual form" (existing form unchanged below toggle).
- Transcript mode: large textarea (paste) + "Upload .txt" button (client-
  side FileReader, .txt/.md/.vtt, ≤200KB, populates textarea) + char count +
  "Identify project" btn (disabled <100 chars) → loading state ("Sonnet is
  reading the call…") → renders DraftCard + IntakeCopilot side by side
  (stack on narrow).
- DraftCard: every draft field displayed cleanly (client match badge
  "existing: Sarah Mitchell" vs "new client"; type/stack pills; £ formatted
  money; goals list; suggested event types as taxonomy-colored badges;
  assumptions as amber bullet list). Fields that changed in the last refine
  get a brief highlight animation. An inline editable name input (direct
  rename without the copilot).
- IntakeCopilot: chat panel — message history (user + assistant notes),
  text input + send; **mic button** using Web Speech API
  (`webkitSpeechRecognition || SpeechRecognition`, lang en-GB, interim
  results into the input, auto-stop on silence; hide button when
  unsupported; while listening, pulse the mic + show live transcript).
  Each send → POST refine with current draft → update DraftCard + append
  the returned note as the assistant message. Errors as inline quiet text.
- "Create project" btn under DraftCard → POST /api/projects (existing
  route) with {name, type, stack, description, retainerPenceMonthly?,
  buildFeePence?, hourlyRatePence?, goals, clientId | newClient{name,
  industrySlug}} from draft → existing KeyReveal flow takes over (reuse the
  component/flow NewProjectForm uses — refactor NewProjectForm minimally to
  share the reveal, don't fork it).
- anthropic_auth error → banner in transcript mode: "Anthropic API key
  missing/invalid — set ANTHROPIC_API_KEY in .env to enable intake." Manual
  mode always available.

**Tests** (apps/web/test/intake/*.test.ts): schema round-trip; route with
MOCKED Anthropic client (inject via a module-level factory you own —
lib/server/intake/anthropic.ts exporting getAnthropic() that tests can
vi.mock) covering: happy path draft, client-match coercion guard, parse-fail
502, auth-error mapping, agent_runs row written with tokens; refine returns
full draft + note. NO live API calls in tests.

## File ownership (hard boundaries)

- M1 (rollup engine): packages/db/src/rollup/**, packages/db/src/seed/
  demo-data.ts (ONLY the DEFAULT_METRIC_DEFINITIONS array), ONE export block
  in packages/db/src/index.ts, ONE script line in packages/db/package.json,
  apps/web/lib/server/ingest/react.ts (insert-only hook), apps/web/test/
  rollup/**.
- W-INTAKE: apps/web/lib/server/intake/**, apps/web/app/api/projects/
  intake/**, apps/web/components/{TranscriptIntake,IntakeCopilot,
  DraftCard}.tsx, apps/web/app/projects/new/page.tsx,
  apps/web/components/NewProjectForm.tsx (minimal shared-reveal refactor),
  apps/web/test/intake/**.
- M2 (wave 2): apps/web/app/api/projects/[projectId]/{metrics,roi,
  insights}/**, api/insights/**, api/projects/sparklines/**, EXTEND
  api/overview/route.ts + lib/server/queries.ts (append-only additions) +
  lib/server/schemas.ts (append-only), apps/web/test/metrics-api/**.
- M3 (wave 2): apps/web/components/{charts/*,MetricsTab,AddMetricModal,
  RoiCard,GoalsList,InsightsList,Sparkline}.tsx, app/projects/[projectId]/
  page.tsx (tab enable + overview sections), app/projects/page.tsx
  (sparklines), app/page.tsx (health summary), globals.css (append-only).
- Lead-owned (read-only): everything else, incl. all Phase 1 files not
  explicitly granted above.

## ADDENDUM (owner requirements, 2026-07-12): Whisper dictation + client API-cost billing

**A. Voice dictation = OpenAI Whisper** (replaces Web Speech as primary).
- New route `POST /api/transcribe` (W-INTAKE owns): multipart form upload
  `audio` (webm/ogg/mp4/wav, ≤ 15MB, ~90s cap client-side) → server fetch to
  `https://api.openai.com/v1/audio/transcriptions` (model `whisper-1`,
  language "en", response_format json) with `OPENAI_API_KEY` — plain fetch +
  FormData, NO new npm dependency. Returns `{text}`. Errors: missing/invalid
  key → 502 `{error:"openai_auth"}`; provider failure → 502
  `{error:"transcribe_failed"}`; detail console.error only.
- IntakeCopilot mic: MediaRecorder capture (opus webm preferred, fall back
  to whatever mimeType is supported) with recording UI (pulse + elapsed
  seconds + stop button + auto-stop at 90s) → POST /api/transcribe → append
  text into the input (user reviews/edits before send). If OPENAI_API_KEY
  is unset (probe: transcribe returns openai_auth) fall back silently to
  the existing Web Speech recognition when available; if neither, hide mic.
- Env: OPENAI_API_KEY (already in .env/.env.example, empty locally — build
  to the same graceful-degradation bar as intake).

**B. Client API-cost tracking (billing groundwork).**
Two cost streams, both per-client/per-project:
1. Client-system AI spend — ALREADY captured as `agent.run.completed`
   `data.cost_pence` events; M1's `tokens_cost_pence` metric rolls it up
   daily. Nothing new to store.
2. OS-side spend — `agent_runs` now has `project_id`/`client_id`
   (migration 0005). Rules: every future agent run writer MUST set them
   when known. W-INTAKE adds `POST /api/projects/intake/attribute`
   `{runIds: uuid[], projectId}` (org-checked; sets project_id + client_id
   from the project; only touches rows with agent='project_intake', same
   org, null project_id) and TranscriptIntake calls it fire-and-forget
   after successful project creation with the runIds it collected.
- M2 (wave 2) adds `GET /api/costs?month=YYYY-MM` →
  `{clients:[{clientId, clientName, projects:[{projectId, name,
  clientSystemAiPence, osAgentPence, totalPence}], totals...}], orgOverheadPence}`
  — client-system from tokens_cost_pence day rollups in the London month;
  OS from agent_runs cost_estimate_pence grouped by project (null project →
  orgOverheadPence). Plus `GET /api/projects/[projectId]/costs?month` for
  the single-project view.
- M3 (wave 2) renders: "API costs" card on project Overview (both streams +
  total, "billable to client" framing) and a per-client costs table row on
  /clients (month-to-date total). Invoicing/markup lands with Money
  (Phase 4) — costs here are the tracked source of truth.
