# Phase 7 — Total Completion Plan (Feedback Webhook · Vault · Analytics Gate · Glass Polish)

> **For agentic workers:** This plan is executed by mixed-model subagent teams (Sonnet 5 + Opus 4.8)
> orchestrated via Workflow scripts in `scripts/workflows/`, planned/gated by the Fable 5 lead.
> Every brief carries the BLOCKED escalation protocol (§Escalation). Steps use checkbox syntax.
> Repo rule: NO git commits unless the owner asks (standing instruction — overrides any skill default).

**Goal:** Finish the platform completely — verify the deep-analytics screen, add the Feedback
Webhook (bugs/feature-requests from client staff → analytics + briefs), replace GHL with a
per-project encrypted Connections vault (Anthropic/OpenAI/Twilio/Higgsfield/Custom), and finish
the liquid-glass UI sweep — ending with a full lead gate.

**Architecture:** Everything rides the existing event spine (events table + mirrors + rollups).
Feedback is a new public, least-privilege webhook (its key can ONLY create `feedback.submitted`
events) with a `feedback_items` triage mirror. Credentials are AES-256-GCM rows (existing
`packages/db/src/keys.ts` scheme) that never leave the server unmasked. Analytics stays
read-only SQL over the spine.

**Tech stack:** Turborepo · Next.js 15 App Router · Drizzle + Postgres (127.0.0.1:54329) ·
Zod v4 · vitest · existing Quiet Glass system (globals.css + ui.ts COLORS: royal #3f6bff,
cyan #22cadb, dark-first).

---

## 0 · Lead review — where we are & what must improve

**Verified state (2026-07-16, all checked by the lead, not agent self-reports):**
- Phases 0–6 complete, gated, closed. 360 tests green at the Phase-6 gate (events 24 · sdk-node 31 · agents 58 · web 234 · py 13). Whole-workspace typecheck green RIGHT NOW.
- Deep analytics: foundation + **7 of 8 sections real and builder-SQL-verified** (Pulse 303L, Engagement, Conversations&AI 685L+431L route incl. Question Intelligence, Funnel, Bookings, Money, Agent&Dev). **Custom is a 23-line stub** (builder died on a transient 401). **The adversarial verify wave never ran** (weekly-limit outage) — numbers are builder-claimed, not skeptic-proven.
- Wave-2 confirmed-minor fixes both landed (ProposalsBoard markdown rendering; upsell insightId idempotency guard — verified by grep, lines 152/167).
- GHL preset exists and must go (user does not use GHL): `lib/server/integrations/ghl.ts`, `app/api/projects/[projectId]/integrations/ghl/**`, 7 refs in `SnippetTabs.tsx`, `apps/web/test/ghl/**`.
- No credentials vault → owner cannot store client-project keys (Anthropic/OpenAI/Twilio/Higgsfield). Gap confirmed by owner.
- No feedback channel → client staff/users cannot report bugs/feature-requests into the OS. New owner requirement.
- `awesome-design-md` not vendored; older screens (Money/Bookings/Briefs/Ask/Growth/Learn/Clients) predate the glass kit and drift from it.
- Agent surfaces don't tell the owner WHY they're empty (missing ANTHROPIC_API_KEY) — needs activation banners.

**Improvement list folded into workstreams below:** A(verify-everything), B(feedback), C(vault+GHL), D(glass sweep + banners + design vendor), E(final gate).

---

## Workstream A — Analytics completion & adversarial gate  *(workflow: `analytics-complete.js`, runs FIRST)*

### Task A1 — Build the Custom & Raw section (Sonnet 5)
**Files:** Modify `apps/web/app/api/projects/[projectId]/analytics/custom/route.ts` (33L stub → real) ·
Modify `apps/web/components/analytics/sections/CustomSection.tsx` (23L stub → real). ONLY these two.
- [ ] Route: read-only SQL — this project's `metric_definitions` (org defaults + project overrides via the Phase-2 resolution rules; reuse `/api/projects/[projectId]/metrics` logic by import, do NOT duplicate) → for each: latest value, range series from `metric_rollups`, delta vs prior period. Plus RAW EXPLORER data: most-recent 50 events (id/type/occurred_at/actor/subject summary + `value_pence`), breakdown-by-type counts, breakdown-by-actor table over the range.
- [ ] Section UI: one glass card per custom metric (label, `tnum` value, delta chip, `MiniTrend`), then the raw explorer (type filter pills, breakdown `HBars`, recent-events table). Empty state: "No custom metrics yet — define one in the Metrics tab."
- [ ] Verify slice: `pnpm --filter @azen/web typecheck && pnpm --filter @azen/web exec vitest run` → tails verbatim.

### Task A2 — Conversations & AI completion review (Opus 4.8)
The 685-line section + 431-line route LANDED but the builder died before reporting; it is entirely unverified.
**Files:** the two conversations-ai files (+ `packages/db/src/seed/generators.ts` question-capture it owns).
- [ ] Read the section contract (in `scripts/workflows/analytics.js` SECTIONS[2]) and diff reality against it: resolution/escalation/abandonment/deflection + trends, turns/duration, sentiment mix+trend, intent hbars, QUESTION INTELLIGENCE (ranked searchable top-questions w/ freq + trend arrow + dominant sentiment, "content gaps" callout for escalating/negative questions, faq_cluster reuse), seed generators emit realistic question text, Setup snippet for question capture exists.
- [ ] Complete/fix any gap found; run typecheck + vitest; report what was missing vs already-done.

### Task A3 — Adversarial verify wave, all 8 sections (8 × Opus 4.8, parallel)
Reuses the original verify lens verbatim (independent SQL over `postgres://postgres:postgres@127.0.0.1:54329/azen_os`
reconstructing 2–3 key aggregates per section; London boundaries; org/project scoping; read-only; empty-state;
two-ledger rule in Money; render safety). → dedup → **refute per finding** (Opus skeptic) → **fixer** applies survivors.

### Task A4 — Lead gate for A
- [ ] `pnpm --filter @azen/web typecheck && pnpm --filter @azen/web exec vitest run` clean.
- [ ] Browser: open `/projects/<dental>/analytics`, click all 8 rail sections × 3 ranges; screenshot proof.
**Done-when:** every section renders real numbers a skeptic reproduced by SQL; zero confirmed-unfixed findings.

---

## Workstream B — Feedback Webhook  *(workflow: `phase7.js` stage 1 — after A gates)*

**Design pinned by lead.** A public, least-privilege intake: the embeddable widget/POST can *only*
create `feedback.submitted` events on one project. No secret ever ships to a browser.

### Task B0 — LEAD: schema + migration 0007 (done by the lead before phase7.js launches)
- [ ] `project_keys.kind text NOT NULL DEFAULT 'ingest'` + CHECK `kind in ('ingest','feedback')`.
- [ ] New table `feedback_items` (triage mirror): `id uuid pk default gen_random_uuid()`, `org_id uuid NOT NULL → orgs`, `project_id uuid NOT NULL → projects`, `event_id uuid NOT NULL → events`, `kind text NOT NULL CHECK (kind in ('bug','feature','question','praise','other'))`, `message text NOT NULL`, `severity int CHECK (severity between 1 and 3)`, `submitter_name text`, `submitter_email text`, `page_url text`, `status text NOT NULL DEFAULT 'new' CHECK (status in ('new','seen','planned','done'))`, `created_at timestamptz NOT NULL DEFAULT now()`. Indexes: `(org_id, project_id, created_at desc)`, `(org_id, project_id, status)`.
- [ ] Drizzle schema + `drizzle-kit generate` migration 0007; apply to local DB.

### Task B1 — Feedback core: event type, endpoint, provisioning, Setup card (Opus 4.8 — public abuse surface)
**Files:** Modify `packages/events/src/taxonomy.ts` (+ its test) · Create `apps/web/app/api/feedback/[publicKey]/route.ts` ·
Modify project-create API (auto-provision) + `packages/db/src/seed/index.ts` (feedback key + demo events via `generators.ts`) ·
Modify `apps/web/components/SnippetTabs.tsx` or Setup tab (new "Feedback widget" card) · Create `apps/web/test/feedback/*.test.ts`.
- [ ] Taxonomy: `feedback.submitted` with Zod data `{ kind: enum('bug','feature','question','praise','other'), message: string min 1 max 2000, severity?: 1|2|3, submitter?: { name?, email? }, page_url?: string }` + taxonomy test (parseEvent round-trip + rejects >2000 chars).
- [ ] Endpoint `POST /api/feedback/[publicKey]`: look up key `kind='feedback'` + not revoked (else 401) → rate limit per-key 30/min AND per-IP 10/min (reuse the ingest limiter pattern; Postgres fallback) → reject body >8KB (413) → **honeypot**: JSON field `website` non-empty → respond `200 {ok:true}` but write NOTHING → Zod parse (400 on invalid) → insert `events` row (type `feedback.submitted`, source `'feedback'`, project-scoped, idempotency key = sha256 of key+message+minute-bucket) → mirror a `feedback_items` row (status `new`) in the same transaction → `200 {ok:true}`. `OPTIONS` handler + `Access-Control-Allow-Origin: *` on POST/OPTIONS (widget embeds on client sites). NEVER expose org/project ids in responses.
- [ ] Provisioning: project-create flow ALSO creates a `kind='feedback'` key (public key only shown; no secret needed). Existing key rotate/revoke made kind-aware. **The ingest route must REJECT `kind='feedback'` keys (401)** and vice-versa — least privilege both ways.
- [ ] Setup tab card "Feedback widget": (1) embeddable self-contained snippet — `<script>` ~2KB inline: floating "Feedback" button → tiny dark glass modal (kind select, textarea, optional email, hidden `website` honeypot input) → `fetch(POST)` → thanks state; (2) plain `curl` example; (3) the feedback key with rotate/revoke.
- [ ] Seed: each demo project gets a feedback key + ~15–40 deterministic `feedback.submitted` events over 30d (Rng; niche-appropriate: bugs/features/questions with severity mix) + mirrored `feedback_items` (varied statuses) so analytics/briefs demo instantly after reseed.
- [ ] Tests (`apps/web/test/feedback/`): valid POST → event + mirror row exist; honeypot → 200 but zero rows; revoked key → 401; ingest-kind key on feedback route → 401; feedback-kind key on ingest route → 401; >8KB → 413; invalid kind → 400; rate-limit → 429; project-create provisions a feedback key.

### Task B2 — Feedback analytics section (Sonnet 5)
**Files:** Modify `apps/web/components/analytics/AnalyticsWorkspace.tsx` (add 9th rail entry "Feedback" — A is gated, safe now) ·
Create `apps/web/app/api/projects/[projectId]/analytics/feedback/route.ts` · Create `apps/web/components/analytics/sections/FeedbackSection.tsx` ·
Create `apps/web/app/api/projects/[projectId]/feedback/[itemId]/route.ts` (PATCH status) · Create `apps/web/test/feedback-analytics/*.test.ts`.
- [ ] Route: counts by kind (range + series by London day), severity mix, status board buckets, top recent 20 items, submitter leaderboard, resolution stats (done÷total).
- [ ] Section: `BigStat` hero (feedback this range + delta), stacked kind series (LineChart per kind or HBars), severity `Donut`, **triage board** (new→seen→planned→done columns; status chip PATCH via the route; optimistic update), recent list with kind/severity chips + page_url. Empty state: "No feedback yet — embed the widget from Setup."
- [ ] PATCH route: org-scoped, Zod `{status}`, 404 cross-org, updates `feedback_items`.
- [ ] Tests: analytics numbers vs hand-built rows; PATCH transitions; cross-org 404.

### Task B3 — Feedback in the briefs (Sonnet 5)
**Files:** Modify `packages/agents/src/datapack/agency-daily.ts` (+ weekly) · bump `packages/agents/src/prompts/daily-brief.ts` + `weekly.ts` versions · Modify `packages/agents/test/datapack.test.ts` (or add `feedback-pack.test.ts`).
- [ ] Daily pack per-project: `feedback: { yesterday: {bug,feature,question,praise,other}, notable: [{kind, message ≤140 chars, severity}] ≤3 (severity desc, then latest) }`. Weekly pack: 7d counts + trend vs prior week.
- [ ] Prompt bump (`daily-brief-2026-07-16`): "mention notable feedback (bugs first) in the brief when present; suggest an action". Same for weekly.
- [ ] Tests: hand-built `feedback_items` → pack numbers exact; empty project → zeros (no crash).

### B verify (2 × Opus): **abuse lens** (limits/honeypot/size/revocation/cross-key/cross-org — try to bypass each) + **data lens** (event↔mirror consistency, analytics vs independent SQL, pack numbers). → refute → fix.

---

## Workstream C — Connections Vault + GHL removal  *(phase7.js stage 2 — after B)*

### Task C0 — LEAD: migration 0008
- [ ] `project_credentials`: `id uuid pk`, `org_id → orgs`, `project_id → projects`, `provider text CHECK in ('anthropic','openai','twilio','higgsfield','custom')`, `label text NOT NULL`, `ciphertext text NOT NULL` (AES-256-GCM via `packages/db/src/keys.ts` `encryptSecret` under `INGEST_SECRET_ENC_KEY`), `last4 text NOT NULL`, `created_at timestamptz default now()`, `revoked_at timestamptz`. Index `(org_id, project_id) where revoked_at is null`.

### Task C1 — Vault server core (Opus 4.8 — security-critical)
**Files:** Create `apps/web/lib/server/credentials.ts` · Create `apps/web/app/api/projects/[projectId]/credentials/route.ts` (POST create, GET list) + `credentials/[credId]/route.ts` (DELETE revoke) · Create `apps/web/test/credentials/*.test.ts`.
- [ ] `createCredential(orgId, projectId, {provider, label, secret})` → encrypt → insert → return `{id, provider, label, last4}` ONLY. `listCredentials` → masked rows ONLY (`sk-…{last4}` display derived client-side from last4). `revokeCredential` → set `revoked_at`. `getDecryptedCredential(orgId, projectId, credId)` → internal server use ONLY (future co-pilot runners); **never imported by any route that returns it**.
- [ ] Hard rules: plaintext never in ANY response, log line, or error message; Zod (`secret` min 8 max 4096, `label` ≤60); missing `INGEST_SECRET_ENC_KEY` → typed 503 `vault_unavailable`; cross-org/project → 404.
- [ ] Tests: create→list shows masked only (deep-scan the JSON for the secret string — must be absent); decrypt round-trip equals input; revoke → gone from list; cross-org 404; oversize 400; missing env → 503.

### Task C2 — Connections tab UI + GHL removal (Sonnet 5)
**Files:** Modify `apps/web/app/projects/[projectId]/page.tsx` (add "Connections" tab) · Create `apps/web/components/ConnectionsTab.tsx` ·
DELETE `apps/web/lib/server/integrations/ghl.ts`, `apps/web/app/api/projects/[projectId]/integrations/ghl/**`, `apps/web/test/ghl/**` · Modify `apps/web/components/SnippetTabs.tsx` (strip all 7 GHL refs; replace with generic "SDK + signed webhooks connect anything" copy).
- [ ] Tab: provider cards (Anthropic · OpenAI · Twilio · Higgsfield · Custom) with masked `<input type="password">` + label field → save → masked chip list (`provider · label · ····last4 · added date`) + revoke (confirm dialog). Copy: "Keys are entered by you, encrypted at rest (AES-256-GCM), never shown again, revocable."
- [ ] The OWNER types keys — no import/paste automation of secrets anywhere.
- [ ] Typecheck proves no dangling GHL imports; grep `-i ghl` in apps/web returns zero.

### C verify (Opus security skeptic): repo-wide plaintext-leak hunt (grep the test secret through every response/log path), crypto misuse check vs keys.ts, revocation actually excludes from list, GHL fully gone (imports, tests, snippets, routes). → refute → fix.

---

## Workstream D — Liquid-glass consistency sweep  *(phase7.js stage 3 — after C)*

### Task D0 — LEAD: vendor design references (disk-light — [[disk-space-critical]])
- [ ] Sparse-fetch ONLY the relevant style guides from `github.com/VoltAgent/awesome-design-md` (glassmorphism/dark/brand palette files) into `docs/design/` via raw-file curl (NO full clone in the repo). Record source+commit in `docs/design/README.md`.

### Task D1 — Glass sweep + activation banners (Sonnet 5)
**Files:** Modify `apps/web/app/{money,bookings,briefs,ask,growth,learn,clients}/**` page/component styling ONLY (no logic) + `apps/web/components/` shared bits they use.
- [ ] Apply the Quiet Glass kit everywhere the pre-glass screens drift: `card`/`glass-strong` surfaces, `accent-num` hero per screen, `tnum` numbers, COLORS-only palette (royal/cyan/semantic), consistent radii/blur/spacing, reduced-motion respected.
- [ ] Empty-key activation banners: Briefs/Ask/Growth/Learn agent surfaces get a calm inline banner when `ANTHROPIC_API_KEY` is unset ("Add ANTHROPIC_API_KEY in .env to activate — everything else keeps working"), Learn adds the same for `VOYAGE_API_KEY`. Server passes a boolean; NEVER read env client-side.
- [ ] No behavioural changes: vitest suite must stay green untouched.

### Task D2 — Browser design verify (Opus 4.8)
- [ ] Drive the dev server: screenshot every screen (Command Center, Projects+detail tabs, Analytics rail, Money, Bookings, Briefs, Ask, Growth, Learn, Clients, Setup) at desktop + 375px; check contrast (WCAG AA on text), palette discipline (no stray brights), consistent chrome; file findings → refute → fix.

---

## Workstream E — Final gate & close-out (LEAD, personally)
- [ ] Reseed → auto-rollups (#29 proof) → `pnpm -r test` + pytest full pass → numbers spot-checked vs SQL.
- [ ] Browser E2E tour incl. NEW: post feedback via the widget snippet → see it in Analytics→Feedback + tomorrow-brief pack; enter a dummy credential → masked list → revoke; confirm GHL gone from Setup.
- [ ] `docs/DECISIONS.md` Phase-7 entries (feedback design, vault design, GHL removal rationale, verify-wave results) · memory update · mark tasks #34/#35/#36.

---

## Team roster & model mix

| Agent | Model | Effort | Why |
|---|---|---|---|
| A1 custom section | Sonnet 5 | high | tight pinned contract, mechanical |
| A2 convo-ai review | Opus 4.8 | high | judgment over 1,100 unverified lines |
| A3 verify ×8 / refute / fix | Opus 4.8 | high | adversarial correctness |
| B1 feedback core | Opus 4.8 | high | public abuse surface + taxonomy |
| B2 feedback analytics | Sonnet 5 | high | contracted UI+SQL |
| B3 briefs integration | Sonnet 5 | medium | pack plumbing + tests |
| B/C verifies, refutes, fixers | Opus 4.8 | high | security + correctness |
| C1 vault server | Opus 4.8 | high | secrets handling |
| C2 vault UI + GHL removal | Sonnet 5 | high | contracted UI + deletion |
| D1 glass sweep | Sonnet 5 | high | style-only sweep |
| D2 browser verify | Opus 4.8 | high | design judgment |

## Escalation protocol (owner requirement)
Every brief ends with: *"If you are blocked, torn between interpretations, or the contract seems
wrong against reality: DO NOT improvise. End your run immediately with a line starting
`BLOCKED: <precise question + the options you see>`."* The workflow surfaces any `BLOCKED:` report
in its result; the lead answers and resumes the workflow (`resumeFromRunId`) — completed agents
replay from cache, the blocked one re-runs with the answer injected. Verify/refute stages catch
"did something the lead wouldn't do"; the lead gates every stage boundary.

## Sequencing & collision map
`A (now) → [lead: B0+C0 migrations, D0 vendor] → phase7.js: B → C → D → E (lead)`
Shared files forcing this order: `AnalyticsWorkspace.tsx` (A verifies ↔ B2 adds rail entry) ·
`SnippetTabs.tsx`/Setup (B1 adds feedback card ↔ C2 strips GHL) · `projects/[projectId]/page.tsx`
(C2 adds Connections tab) · `seed/generators.ts` (A2 owns question-capture ↔ B1 appends feedback events) ·
D touches every screen ⇒ strictly last.

## Risks & mitigations
- **Transient API/limit outages** (hit us twice): every stage is a separate resumable workflow; on failure, resume — cached agents replay free.
- **Local Postgres connection exhaustion** (seen during analytics: `53300 too many clients`): lead restarts the dev server/pools before phase7.js launch; verifiers use single short-lived connections.
- **Public feedback endpoint abuse**: dual rate limit + size cap + honeypot + least-privilege key kind + revocation; verified adversarially before ship.
