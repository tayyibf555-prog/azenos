# AZEN OS — Agency Business Operating System

> **This document is the master build specification for Claude Code.**
> Read it fully before writing any code. Build in the phase order defined in
> §14. Every phase ships a usable slice. Do not skip the data model or event
> taxonomy sections — everything else depends on them.

---

## 1. Vision

Azen OS is a single operating system for an AI agency (Azen AI, run by Tayyib,
UK/Europe-London timezone) that:

1. **Tracks the agency itself** — clients, leads, bookings (Calendly),
   payments (Stripe + bank transfer), retainers/MRR, project pipeline, and
   profitability.
2. **Tracks every client project in production** — each project the agency
   builds for a client (custom Next.js/Node/Python systems, GHL/no-code
   setups, AI agents) gets a **generated webhook** that streams extensive
   real-world event data back into the OS: every agent run, every
   conversation, every booking made, every payment captured, every error,
   every human-hours-saved signal.
3. **Turns that data into intelligence** — a fleet of Claude Sonnet agents
   produces **daily, weekly, and monthly briefs** (email + WhatsApp), detects
   repetitive work and automation opportunities inside client businesses,
   quantifies ROI per project, and generates **evidence-backed upsell
   proposals** ("your data shows X, here is what we should build next").
4. **Compounds niche knowledge** — a separate learning agent studies each
   client's industry (dental, trades, clinics, …) as data flows in, and
   builds a permanent per-niche knowledge base so the agency gets smarter in
   every vertical it touches.

The end state: Tayyib opens one screen and sees the whole agency; every
morning a brief lands on WhatsApp and email; every month the OS hands him a
data-backed upsell document per client.

**V1 is internal-only** (single owner user). The schema is designed
multi-tenant from day 1 so client-facing portals and team seats can be added
later without a rewrite.

---

## 2. Confirmed context and decisions (from discovery)

| Area | Decision |
|---|---|
| Bookings source | **Calendly** (webhooks: invitee.created / invitee.canceled) |
| Payments | **Stripe** (webhooks) + **manual bank-transfer logging** (UI + CSV import) |
| Current tracking | Nothing consistent — the OS replaces scattered notes/sheets. Import friction must be near-zero. |
| Brief delivery | **Email (primary, rich)** + **WhatsApp (short, punchy)** via Twilio WhatsApp API (SMS fallback comes free with the same integration) |
| Client systems | Custom code (Next.js/Node/Python) **and** GHL/no-code SaaS → webhook layer needs both a tiny SDK and plain HTTPS/native-webhook mapping |
| Revenue model | Build fee + monthly retainer → OS must model one-off revenue AND MRR per client |
| Scale target | Design multi-tenant from day 1; 15–50 projects within 6 months is the sizing assumption |
| Client access | Internal-only v1; portal/shareable reports are Phase 7+ |
| Scope | Full vision planned now, shipped in phases |
| Hosting | Vercel + managed services |
| AI model | Claude Sonnet (latest Sonnet model at build time — check `docs.claude.com/en/docs/about-claude/models` and pin the current Sonnet model ID in one config constant, e.g. `AGENT_MODEL`). The interactive Ask Azen chat (§9.8) gets its own `CHAT_MODEL` constant (also current Sonnet) so chat and fleet can be tuned independently. Embeddings: Voyage AI, pinned via `EMBEDDING_MODEL` (1024 dims). |

**Stack decision (owner delegated): Next.js 15+ (App Router, TypeScript) +
Supabase (Postgres, Auth, Row Level Security, Realtime) + Vercel.**

Rationale: one language end-to-end; Postgres is the right store for an
event/metrics system (JSONB events + materialized rollups); Supabase gives
auth, RLS for future multi-tenancy, and realtime dashboard updates for free;
Vercel gives zero-ops deploys. Supporting services:

- **Anthropic API** — all agent intelligence (Sonnet), via the TypeScript SDK.
- **Voyage AI** — embeddings for the knowledge base (pgvector, 1024 dims;
  `EMBEDDING_MODEL` + `EMBEDDING_DIMS` pinned in config next to `AGENT_MODEL`).
- **Trigger.dev (v3)** — scheduled + long-running agent jobs (daily/weekly/
  monthly briefs, metric rollups). Vercel cron alone times out for
  multi-minute agent runs; Trigger.dev is serverless-friendly and replayable.
  **Committed choice (owner-confirmed 2026-07).** Contingency only if it
  proves unworkable in practice: Supabase pg_cron + Edge Functions (mind Edge
  Function wall-clock limits on multi-minute agent runs) — record any such
  deviation in `docs/DECISIONS.md`.
- **Resend** — transactional email + brief delivery (React Email templates).
- **Twilio** — WhatsApp Business API sender + SMS fallback.
- **Upstash Redis** — rate limiting on public webhook endpoints + lightweight
  queues/dedup.
- **Recharts** (or Tremor) — dashboard charts.
- **Drizzle ORM** — schema-as-code migrations against Supabase Postgres
  (preferred over the Supabase client for complex analytical queries; use the
  Supabase JS client only for auth/realtime).

---

## 3. System architecture (bird's eye)

```
┌────────────────────────────── AZEN OS (Next.js on Vercel) ─────────────────────────────┐
│                                                                                        │
│ UI: Cmd Center │ Clients │ Projects │ Money │ Bookings │ Briefs │ Growth │ Learn │ Ask │
│                                                                                        │
│  /api/ingest/[projectKey]  ←── signed webhooks from every client system               │
│  /api/hooks/calendly       ←── Calendly                                               │
│  /api/hooks/stripe         ←── Stripe                                                 │
│  /api/hooks/ghl            ←── GoHighLevel native webhooks (mapped)                   │
│                                                                                        │
│  Ingestion pipeline: verify → dedup → normalize → store raw → derive metrics → alert  │
│                                                                                        │
└───────────────┬────────────────────────────────────────────────┬───────────────────────┘
                │                                                │
        Supabase Postgres                              Trigger.dev jobs
   (events, metrics, projects,                 ┌───────────────────────────────┐
    clients, money, briefs,                    │ hourly:  metric rollups        │
    insights, knowledge base)                  │ daily:   Daily Brief Agent     │
                │                              │ weekly:  Weekly Synthesizer    │
                │                              │ monthly: Monthly Strategist +  │
        Upstash Redis                          │          Upsell Engine         │
   (rate limits, dedup, queues)                │ weekly:  Industry Learning     │
                                               │ continuous: Opportunity Scout  │
                                               └───────┬───────────────────────┘
                                                       │  Claude Sonnet (Anthropic API)
                                                       ▼
                                        Delivery: Resend (email) + Twilio (WhatsApp/SMS)
```

Data flows one way: **client systems → webhooks → raw events → normalized
metrics → agent analysis → briefs/insights/upsells → Tayyib's inbox and the
dashboard.** Agents never write to raw data; they write to `briefs`,
`insights`, and `knowledge_articles` only.

---

## 4. Data model (Drizzle / Postgres)

Multi-tenant from day 1: everything hangs off `organizations`. V1 has exactly
one organization (Azen AI) and one user (owner), but no table may reference
data without an `org_id`. Enable RLS on all tables; v1 policy is simply
"authenticated user belongs to org".

### 4.1 Core tables

```
organizations   id, name, created_at
users           id (supabase auth uid), org_id, name, email, phone_whatsapp, role ('owner' v1), notification_prefs jsonb
clients         id, org_id, name, company, industry (slug → industries), status
                (lead|discovery|proposal|active|paused|churned), source, emails[],
                phones[], website, notes, ltv_cache, created_at
industries      id, slug (dental|trades|clinics|...), name  — powers the Learning agent
contacts        id, client_id, name, role, email, phone     — people at the client
```

### 4.2 Projects & integrations

```
projects        id, org_id, client_id, name, slug, description,
                type (ai_agent|automation|website|chatbot|voice_agent|crm_setup|custom),
                stack ('custom_code'|'ghl'|'n8n'|'mixed'),
                status (scoping|building|testing|live|paused|completed|cancelled),
                build_fee_pence, retainer_pence_monthly, retainer_active bool,
                start_date, live_date, health (green|amber|red, agent-set),
                goals jsonb  — e.g. [{metric:'bookings_created', target:50, period:'month'}]
project_keys    id, project_id, public_key ('azn_pk_...'), secret ('azn_sk_...', hashed),
                label, created_at, revoked_at   — powers webhook auth; rotatable
project_integrations  id, project_id, provider (stripe|calendly|ghl|custom|twilio|...),
                external_id, config jsonb       — maps native webhooks → project
```

### 4.3 The event spine (most important table in the system)

```
events          id (uuid), org_id, project_id null (org-level events, e.g. agency Calendly, have no project), 
                type (see taxonomy §7), 
                source ('sdk'|'ghl'|'stripe'|'calendly'|'manual'|'import'),
                idempotency_key (unique per project — dedup),
                occurred_at (client-reported), received_at,
                actor jsonb    — {kind:'ai_agent'|'human'|'system', id, name}
                subject jsonb  — {kind:'lead'|'customer'|'booking'|..., id, name}
                data jsonb     — full typed payload per taxonomy
                value_pence bigint null      — money attached to this event
                currency char(3) default 'gbp' — currency of value_pence
                minutes_saved numeric null   — human time this event saved
                raw jsonb      — untouched original payload, always kept
   Indexes: (project_id, type, occurred_at desc), (org_id, occurred_at desc),
            GIN on data. Partition by month if volume demands (note in README, don't premature-build).
```

Every single thing the OS knows about a client business arrives as a row in
`events`. Metrics, briefs, ROI, upsells — all derived from here. **Never
throw away `raw`.**

### 4.4 Metrics & rollups

```
metric_definitions  id, org_id, project_id null (null = global default),
                    key ('bookings_created', 'ai_conversations', ...),
                    name, description, unit ('count'|'pence'|'minutes'|'percent'|'ms'),
                    aggregation ('sum'|'count'|'avg'|'p95'|'last'|'rate'),
                    event_type, value_path (JSONPath into event data), 
                    good_direction ('up'|'down'), is_kpi bool, sort
metric_rollups      project_id, metric_key, period ('hour'|'day'|'week'|'month'),
                    period_start, value numeric, sample_count
                    PK (project_id, metric_key, period, period_start)
```

Rollups are recomputed idempotently by an hourly Trigger.dev job (last 48h
window re-rolled every run, so late events self-heal). Dashboards read
rollups, never scan raw events.

### 4.5 Money

```
payments        id, org_id, client_id, project_id null,
                source ('stripe'|'bank_transfer'|'other'),
                kind ('build_fee'|'retainer'|'deposit'|'other'),
                amount_pence, currency ('gbp' default), status, external_id,
                invoice_ref, paid_at, notes
subscriptions   id, client_id, project_id, stripe_subscription_id null,
                amount_pence_monthly, status, started_at, cancelled_at
                — bank-transfer retainers get a row too (stripe id null) with a
                  monthly 'expected payment' check that flags late payers
expenses        id, org_id, project_id null, category (hosting|api|tools|contractor|other),
                vendor, amount_pence, recurring bool, period, notes
                — enables true per-project margin: retainer minus API/hosting costs
```

### 4.6 Bookings

```
bookings        id, org_id, client_id null, project_id null,
                source ('calendly'|'client_system'|'manual'),
                kind ('discovery'|'kickoff'|'review'|'client_end_customer'),
                invitee jsonb, starts_at, ends_at, status (scheduled|completed|
                cancelled|no_show), external_id, raw jsonb
```

Note the two flavors: **agency bookings** (Tayyib's Calendly) and **client-end
bookings** (a dental patient booked by the client's AI receptionist — arrives
via project webhook as a `booking.created` event AND is mirrored here with
`kind='client_end_customer'` for cross-project booking analytics).

### 4.7 Agent output tables

```
briefs             id, org_id, scope ('agency'|'project'), project_id null,
                   period ('daily'|'weekly'|'monthly'), period_start,
                   headline, body_md, body_whatsapp (≤~900 chars), 
                   data_snapshot jsonb (exact numbers the agent saw — auditability),
                   model, tokens_in, tokens_out, status (generated|sent|failed),
                   sent_email_at, sent_whatsapp_at
insights           id, org_id, project_id, 
                   kind ('automation_opportunity'|'upsell'|'risk'|'win'|'anomaly'|'faq_cluster'),
                   title, body_md, evidence jsonb (event ids + aggregates that prove it),
                   estimated_value_pence null, estimated_hours_saved_monthly null,
                   confidence (low|med|high), status (new|reviewed|actioned|
                   dismissed|converted_to_upsell), created_by ('agent'|'user')
upsell_proposals   id, client_id, project_id null, title, problem_md, proposal_md,
                   evidence jsonb, suggested_price_pence, status
                   (draft|ready|sent|won|lost), insight_ids[]
knowledge_articles id, org_id, industry_id, title, body_md, 
                   sources jsonb (event stats, web citations),
                   kind ('industry_primer'|'weekly_digest'|'pattern'|'playbook'),
                   embedding vector(1024) null  — pgvector, Voyage AI (§12), powers RAG
agent_runs         id, agent ('daily_brief'|'weekly_synth'|'monthly_strategist'|
                   'opportunity_scout'|'industry_learner'|'upsell_engine'),
                   started_at, finished_at, status, model, tokens_in, tokens_out,
                   cost_estimate_pence, error, output_refs jsonb
                   — the OS eats its own dog food: its OWN agents' ROI is tracked
chat_sessions      id, org_id, user_id, title, context jsonb (page context at
                   start, e.g. {project_id}), created_at
chat_messages      id, session_id, role (user|assistant|tool), content_md,
                   tool_calls jsonb (full trace — chat's data_snapshot),
                   model, tokens_in, tokens_out, cost_estimate_pence, created_at
                   — powers Ask Azen (§9.8); spend feeds the AI-cost metric
```

### 4.8 Delivery log & alert rules

```
webhook_deliveries  id, project_key_id, status ('accepted'|'duplicate'|'rejected'|'failed'),
                    http_status, latency_ms, error null, event_id null (set when accepted),
                    raw jsonb null (payload kept for rejected/failed — enables replay, §6.3),
                    received_at
                    — every hit on /api/ingest logged; powers the Setup tab delivery log
alert_rules         id, org_id, project_id null (null = org-wide default),
                    kind ('error_streak'|'event_silence'|'payment_overdue'|'anomaly'|'custom'),
                    condition jsonb — e.g. {event_type:'system.error', count:3, window_minutes:30},
                    channel ('whatsapp'|'email'|'both'), cooldown_minutes, enabled bool
                    — evaluated in the ingest pipeline (§6.3 step 6) and by rollup jobs
```

---

## 5. The OS sections (navigation & screens)

Nine primary sections. Build the layout shell first (sidebar + command-K
palette — the palette doubles as the Ask Azen entry point, §5.9), then
screens in phase order.

### 5.1 Command Center (home)
The one screen that answers "how is the whole agency right now":
- Hero strip: **MRR**, cash collected this month, active projects, project
  health summary (n green / n amber / n red), bookings this week.
- "Today" column: today's Calendly calls, overdue expected payments, new
  insights awaiting review, yesterday-vs-average anomaly flags.
- Latest daily brief inline (the same one that went to WhatsApp/email).
- Live event ticker (Supabase Realtime): events streaming in from all client
  systems — makes the OS feel alive and proves webhooks work. Implement via
  Realtime **broadcast**, not `postgres_changes` — broadcast holds up at high
  event volume.

### 5.2 Clients
List + detail. Detail page = relationship HQ: status pipeline, all projects,
all payments/LTV, all bookings, all briefs/insights/upsell proposals for that
client, notes. LTV and margin computed live.

### 5.3 Projects  ← the heart of the OS
**List view:** every project as a card/row — client, status, health,
retainer, 7-day sparkline of its primary KPI, last-event-received timestamp
(a project that's gone silent gets flagged loudly — silence usually means the
client's system broke).

**Project detail page — tabs:**
1. **Overview** — health, goals vs actuals, ROI headline ("system generated
   £X / saved Y hrs this month vs £Z retainer = N× ROI"), primary KPI charts.
2. **Metrics** — the in-depth board: every metric for this project, custom
   date ranges, day/week/month granularity, compare-to-previous-period. A
   "+ Add metric" button creates a `metric_definitions` row pointing at any
   event type + JSONPath — **custom KPIs per project without code changes.**
3. **Events** — searchable, filterable raw event stream (type, date, actor,
   free-text into JSONB). This is the debugging view AND the trust view.
4. **Conversations** — LLM traffic explorer (see §8): topics people keep
   asking, resolution rates, escalations, FAQ clusters.
5. **Agents** — every AI agent running inside the client's system (registered
   via `agent.heartbeat` events): status, runs, success rate, tokens/cost,
   minutes saved, per-agent ROI.
6. **Insights** — opportunity/risk/win cards for this project from the
   Opportunity Scout, with evidence drill-down.
7. **Setup** — webhook management (§6): keys, endpoint URL, copy-paste snippets,
   test-event button, delivery log, event-type checklist showing what this
   project has/hasn't sent yet.

### 5.4 Money
MRR over time, cash in/out per month, revenue by client, retainer coverage
("retainers cover N% of base costs"), expected-vs-received retainer table,
expense tracking, per-project margin (retainer − attributed API/hosting
costs), overdue flags. Stripe events land automatically; bank transfers get a
fast manual-entry form + CSV import.

### 5.5 Bookings
Agency calendar view (Calendly-fed): upcoming calls, show/no-show/cancel
rates, source of booked calls, discovery→client conversion. Plus a
cross-project view of client-end-customer bookings generated by systems the
agency built ("our systems booked 214 appointments for clients this month" —
a killer agency marketing stat, surfaced on Command Center too).

### 5.6 Briefs
Archive of every daily/weekly/monthly brief, agency-level and per-project,
with the exact `data_snapshot` behind each one. Re-send button. Delivery
status per channel.

### 5.7 Growth (upsells)
Pipeline of `insights` (kind=automation_opportunity/upsell) → review →
convert to `upsell_proposals` → mark sent/won/lost. Each proposal renders as
a clean client-ready document: the problem **in their own data**, the
proposed build, expected ROI, suggested price. Won proposals track revenue
attributed to the OS itself.

### 5.8 Learn
The industry knowledge base: one page per niche (dental, trades, …) with the
primer, weekly digests, patterns, and playbooks the Industry Learning agent
has written, searchable. Over time this becomes the agency's proprietary
niche encyclopedia.

### 5.9 Ask (Ask Azen)
The conversational layer over the whole OS (§9.8). Two surfaces: a command-K
**"Ask" mode** available on every screen (page context — current project or
client — is injected into the session), and a dedicated Ask screen with
session history. Answers stream in, can render small tables/sparklines, and
every number carries a collapsible "how I got this" trace of the tool calls
behind it.

---

## 6. Webhook system (per-project data pipes)

### 6.1 Creating a webhook (the flow Tayyib described)

In **Projects → New Project**: enter name + client + type → OS generates a
key pair and shows a setup screen:

- Endpoint: `https://os.azen.ai/api/ingest/{public_key}` — lock the real
  production ingest domain before the first live client integration; it gets
  hardcoded into client systems.
- Secret: `azn_sk_...` (shown once, stored hashed). **Rotation semantics:**
  the public key is the URL's stable identity and never changes; rotation
  issues a new secret only. Full revocation creates a new key pair — and
  therefore a new endpoint URL the client must update.
- Copy-paste blocks, generated per stack:
  - **Node/Next.js:** `npm i @azen/os-sdk` + 5-line snippet
  - **Python:** `pip install azen-os` + 5-line snippet
  - **GHL / no-code:** the raw URL + header instructions for GHL's native
    webhook actions, plus a field-mapping preset
  - **Plain curl** for anything else
- A **"Send test event"** button and a live "waiting for first event…"
  listener (Realtime) that flips green when the first event lands.

### 6.2 The SDK (`@azen/os-sdk` — build as a package in the monorepo)

Tiny, zero-dependency, fire-and-forget with retry:

```ts
import { AzenOS } from '@azen/os-sdk'
const os = new AzenOS({ key: process.env.AZEN_KEY, secret: process.env.AZEN_SECRET })

await os.track('booking.created', {
  subject: { kind: 'customer', id: 'cus_123', name: 'Jane D' },
  actor: { kind: 'ai_agent', id: 'receptionist-v2', name: 'AI Receptionist' },
  data: { service: 'Checkup', starts_at: '...', channel: 'voice' },
  value_pence: 8500,
  minutes_saved: 12,
  idempotencyKey: 'call_789:booking',
})
```

Also ship `os.conversation(...)` (sugar for `llm.conversation` events),
`os.heartbeat(agent)` and `os.metric(key, value)` for arbitrary custom
gauges. Python mirror: `azen_os` with identical semantics.
The SDK signs each request: `X-Azen-Signature: t=<ts>,v1=HMAC-SHA256(secret, ts + '.' + body)`.

### 6.3 Ingestion endpoint (`/api/ingest/[publicKey]`)

Pipeline, in order — each step small and testable:

1. **Verify** — HMAC signature, timestamp within ±5 min (replay protection).
   GHL/no-code callers that can't sign use a per-project secret header
   (`X-Azen-Token`) as the fallback auth mode, flagged on the key record.
2. **Rate limit** — Upstash, per key (default 100 req/10s, config per project).
3. **Dedup** — `idempotency_key` unique check (Redis fast-path + DB
   constraint). Duplicates get 200 + `{duplicate: true}` — never an error, so
   client retries stay quiet.
4. **Validate & normalize** — Zod schema per event type (§7). Unknown event
   types are ACCEPTED and stored as `custom.*` (never drop data), but flagged
   in the Setup tab so mappings can be added.
5. **Store** — raw + normalized into `events`. Mirror side-effects:
   `booking.*` events mirror into `bookings` (kind='client_end_customer').
   Project-ingest `payment.*` events are client end-customer money: they stay
   in `events`/rollups only and NEVER write the agency `payments` ledger
   (§4.5) — that ledger is fed solely by the org-level Stripe hook and manual
   entry (two-ledger rule, §10).
6. **React** — evaluate `alert_rules` (§4.8; e.g. `system.error` streak →
   immediate WhatsApp ping); enqueue incremental rollup for the affected
   metric keys. Runs *after* the response via Vercel `waitUntil()`
   (`@vercel/functions`); move to Trigger.dev event triggers if reaction work
   ever outgrows the function window.
7. **Respond 200 fast** (<300ms budget; steps 1–5 are synchronous and on the
   clock, step 6 is post-response).

Every delivery is logged to `webhook_deliveries` (§4.8) — surfaced in the
Setup tab so a client integration failing is visible within minutes, not
weeks. Rejected/failed deliveries keep their raw payload and can be replayed
through steps 4–6 from the Setup tab (dead-letter recovery).

### 6.4 Native integrations (mapped into the same event spine)

- **Calendly** → org-level: `booking.created/cancelled` for agency calls.
- **Stripe** → `payment.captured/failed/refunded`, `subscription.*` — routed
  to client/project via `project_integrations` mapping or metadata.
- **GHL** → per-project: map GHL workflow webhooks (contact created,
  appointment booked, pipeline stage changed, form submitted) into taxonomy
  events via a per-project mapping config (`project_integrations.config`).

---

## 7. Event taxonomy (the contract — be exhaustive)

Namespaced `domain.action`. Zod-validated. This taxonomy is the single most
leveraged design surface in the system: every metric, brief, and upsell is
derived from it. Implement ALL of these in v1 schemas even if early projects
only send a few.

**leads/CRM:** `lead.created`, `lead.qualified`, `lead.stage_changed`,
`lead.converted`, `lead.lost`, `form.submitted`
**bookings:** `booking.created`, `booking.rescheduled`, `booking.cancelled`,
`booking.completed`, `booking.no_show`
**money (client's end-customers):** `payment.captured`, `payment.failed`,
`payment.refunded`, `invoice.sent`, `invoice.paid`, `subscription.started`,
`subscription.cancelled`, `quote.sent`, `quote.accepted`
**AI agents inside client systems:** `agent.heartbeat` (registers/updates the
agent: name, version, purpose), `agent.run.started`, `agent.run.completed`
(duration_ms, success, tokens_in/out, cost_pence, minutes_saved),
`agent.run.failed`, `agent.escalated_to_human`, `agent.feedback` (rating)
**LLM conversations (fuel for §8):** `llm.conversation` — one event per
finished conversation: channel (voice|webchat|whatsapp|sms|email), turns,
duration, intent (if the client system classifies), resolution
(resolved|escalated|abandoned), summary (client-side generated, ≤500 chars),
topics[], sentiment, transcript_ref (optional; see §16 privacy)
**comms:** `message.sent`, `message.received`, `email.sent`, `email.opened`,
`call.completed` (duration, outcome), `review.received` (rating, text)
**operations:** `task.completed` (what, by human|ai, minutes_spent),
`workflow.run` (n8n/GHL automation fired: name, success, actions_count),
`document.generated`, `order.created`, `order.fulfilled`
**system health:** `system.error` (severity, component), `system.warning`,
`integration.disconnected`
**catch-all:** `custom.<anything>` with free-form data — accepted, stored,
surfaceable as custom metrics via JSONPath metric definitions.

**Common envelope (every event):** `type`, `occurred_at`, `idempotency_key`,
optional `actor`, `subject`, `data`, `value_pence`, `currency` (default gbp),
`minutes_saved`.
`value_pence` + `minutes_saved` are the ROI atoms — the SDK docs must push
integrators to set them wherever honest numbers exist.

---

## 8. Metrics engine & conversation intelligence

### 8.1 Default KPI pack (auto-seeded for every project)

Seeded from `metric_definitions` global defaults on project creation; each
project can add custom ones from the UI:

- **Volume:** events/day, conversations/day, bookings created, leads created,
  forms submitted, calls handled
- **Money:** revenue attributed (Σ value_pence), payments captured,
  avg transaction value, refund rate
- **AI performance:** agent runs, success rate, escalation rate,
  avg response/resolution duration, tokens & cost/day, cost per resolved
  conversation
- **ROI:** minutes saved (Σ), £-equivalent of time saved (configurable hourly
  rate per project, default £30/h), **ROI multiple = (revenue attributed +
  time-value saved) / (retainer + attributed run costs)** — THE headline
  number on every project page and in every brief
- **Quality:** resolution rate, no-show rate, review rating avg, sentiment mix
- **Health:** error count, error streaks, hours-since-last-event

### 8.2 Custom per-project KPIs
`metric_definitions` row = event_type + JSONPath + aggregation + unit. The UI
"Add metric" form previews the metric live against the last 30 days of
events before saving. This is how "literally every KPI you can think of"
stays possible without schema changes.

### 8.3 Conversation intelligence (what people keep asking)
A Trigger.dev job (daily, per project with llm.conversation traffic) feeds
the day's conversation summaries/topics to Sonnet for clustering:

- Output: `faq_cluster` insights — "34% of conversations this week were
  about pricing for X", "27 people asked about weekend availability (you
  don't offer weekends)", each with example conversation refs + trend vs
  last week.
- Clusters that represent **unautomated repetitive work** (escalated to
  humans, or high-volume topics with no automation) are cross-flagged to the
  Opportunity Scout (§9.4) as automation candidates.

### 8.4 Anomaly detection (cheap, non-AI first)
Rollup job compares each KPI's daily value to its trailing 28-day mean/std;
|z| ≥ 2.5 creates an `anomaly` insight (e.g. "bookings down 60% vs normal
Tuesday"). The Daily Brief agent receives open anomalies as input, so briefs
always lead with what's abnormal, not just what happened.

---

## 9. The agent fleet (Claude Sonnet)

All agents share one runtime pattern — build it once as `lib/agents/runner.ts`:

1. A Trigger.dev job gathers a **deterministic data pack** (SQL over rollups
   + open insights + recent briefs) — agents never query the DB themselves in
   v1; they receive curated JSON. This keeps runs cheap, auditable, and
   reproducible (`data_snapshot` is stored with every brief).
2. One Sonnet call (or a short tool-use loop where specified) with a
   versioned system prompt from `lib/agents/prompts/*.md` — prompts live in
   the repo, reviewed like code.
3. Output is **structured JSON** (use tool/structured outputs, validate with
   Zod, one retry on validation failure) → written to `briefs`/`insights`/
   `knowledge_articles` → delivered.
4. Every run logged to `agent_runs` with tokens + cost estimate. The OS's own
   AI spend is a first-class metric on the Money screen.

Model: `AGENT_MODEL` constant = the current Claude Sonnet model ID (check
docs at build time). Use prompt caching for the static prompt+schema prefix.
All scheduling in **Europe/London**.

### 9.1 Daily Brief Agent — 07:00 daily
**Input:** yesterday's rollups for agency + every live project, deltas vs
7/28-day averages, open anomalies, today's calendar, payments received/
expected, event-silence flags, error streaks.
**Output (JSON):** `headline`, `agency_summary_md`, `projects[]` (one tight
paragraph each — only projects with something worth saying; silent-and-normal
projects get one collapsed line), `needs_attention[]` (ordered, actionable),
`wins[]`, `whatsapp_text` (≤900 chars, punchy, emoji-light, leads with the
single most important thing).
**Delivery:** rich email (React Email template: hero numbers, sparklines,
attention list) + WhatsApp text. Brief stored + shown on Command Center.
**Tone rule (all brief agents):** numbers first, no filler, no "great job
team!" fluff, always compare to baseline, always say *so what* and *do this*.

### 9.2 Weekly Synthesizer — Monday 07:30
**Input:** the 7 daily briefs (headlines + attention items), weekly rollups
vs previous 4 weeks, insights opened/closed this week, conversation clusters,
money week (collected, MRR moves, overdue).
**Output:** week-over-week narrative per project + agency; trends forming
("escalation rate rising 3 weeks straight on X"); scoreboard table (KPI, this
week, last week, 4-wk avg, trend arrow); top 3 priorities for the coming
week; `whatsapp_text`.
The weekly is a **synthesis**, not a longer daily — its job is direction and
trend, and it explicitly references what changed since its own last edition.

### 9.3 Monthly Strategist — 1st of month, 08:00
The flagship. **Input:** monthly rollups (vs prior 3 months), all weekly
briefs, all insights (incl. dismissed — it learns what Tayyib ignores), full
money picture, ROI per project, conversation intelligence digests, industry
knowledge updates.
**Output — three documents per run:**
1. **Owner's monthly report (agency-wide):** what happened, per-project
   deep-dive with ROI multiples, portfolio health, MRR bridge (gained/lost/
   net), where the agency's own time went, strategic recommendations.
2. **Per-client value report (one per active client, internal draft):**
   everything their systems did this month in plain business English —
   bookings made, revenue touched, hours saved, conversations handled, uptime
   — written so ~80% can be pasted into a client email as proof of retainer
   value.
3. **Upsell dossier per client** → feeds §9.5.

### 9.4 Opportunity Scout — continuous (daily scan, per project)
The "where can we add more AI" engine. **Input:** FAQ clusters (§8.3),
escalation patterns, `task.completed` events done by humans repetitively,
error/dropoff patterns, unused taxonomy areas (e.g. project sends bookings
but no payment events → "payment collection isn't automated"), industry
playbooks from the knowledge base ("other dental clients automate recall
reminders").
**Output:** `insights` rows, each with: what was detected, the evidence
(event ids + aggregates), what to build, estimated hours-saved/month,
estimated revenue impact, confidence, suggested price band. Deduplicated
against existing open insights (match on project + fingerprint). High-
confidence finds get a same-day WhatsApp ping; the rest wait for the daily
brief and the Growth screen.

### 9.5 Upsell Engine — monthly (with Strategist) + on-demand button
Converts reviewed/high-confidence insights into `upsell_proposals`: a
client-ready narrative — *"In the last 90 days, 412 conversations hit your
AI receptionist; 118 (29%) asked about invoice payment and 74 escalated to
your staff, costing ≈9 hrs/month. We propose an automated payment-collection
agent. Based on your average transaction of £86, recovering even half of
abandoned payment queries is ≈£5,000/quarter. Build: £X, +£Y/mo retainer."*
Every claim traces to evidence rows — the OS's core sales promise is
**provable upsells**. Status pipeline tracked on the Growth screen; won
value attributed back to the insight that sourced it.

### 9.6 Industry Learning Agent — weekly per active industry
**Input:** the industry's aggregate patterns across all its projects
(booking curves, top FAQ topics, seasonality, conversion metrics — anonymized
across clients), plus web research via Anthropic's native web search tool
(allow tool-use loop here, max ~8 searches/run).
**Output → `knowledge_articles`:**
- On industry first-touch: an **industry primer** (how the business model
  works, key KPIs, terminology, regulations worth knowing, common software).
- Weekly: a **digest** — what our live data shows about this niche, one
  external development worth knowing, one automation pattern worth testing.
- When patterns repeat across ≥2 clients: a **playbook** ("what works in
  dental: recall-reminder agents recover ~X% of lapsed patients").
Articles are embedded (pgvector) so the Scout and Strategist retrieve niche
context via similarity search — this is how the agency "gets more educated
in a niche" in a way that compounds.

### 9.7 Delivery layer
`lib/delivery/`: `sendBriefEmail()` (Resend + React Email), 
`sendWhatsApp()` (Twilio; template messages for outside the 24h session
window — register templates like `daily_brief_v1` during setup. NOTE:
WhatsApp template variables cannot contain newlines, so design templates as
multiple single-line variables/sections, never one multi-line text blob), 
`sendSMS()` fallback if WhatsApp fails twice. All sends recorded on the
brief/insight row. `notification_prefs` on `users` controls channel per
brief type and quiet hours.

### 9.8 Ask Azen — interactive business Q&A (on-demand, not scheduled)

The conversational layer over everything the OS stores: Tayyib asks any
question about the business ("which client made us the most this quarter?",
"how many bookings did Smile Dental's receptionist make last week vs the
week before?", "what's our total AI spend this month?") and gets a grounded,
sourced answer in seconds.

**Model:** `CHAT_MODEL` config constant, pinned to the current Claude Sonnet
model at build time — kept separate from `AGENT_MODEL` so chat and fleet can
be tuned and upgraded independently.

**Access pattern — the one exception to the data-pack rule (§9 intro):**
open-ended Q&A can't be served by pre-curated packs, so Ask Azen runs a
multi-turn tool-use loop (max ~12 tool calls per user turn) over a
**read-only tool belt**:

- `get_business_snapshot()` — clients, projects, statuses, MRR, health
  summary (cheap first call, always available)
- `query_metric_rollups(project?, metric_key, period, range)` — the
  workhorse for "how many / how much / trend" questions
- `search_events(project?, type?, date_range?, text?, limit)` — capped
  result size
- `money_summary(range)`, `list_payments(filters)`, `list_expenses(filters)`
- `list_bookings(filters)`
- `search_briefs_insights(text?, filters?)` — briefs, insights, upsell
  proposals
- `search_knowledge(text)` — pgvector similarity over `knowledge_articles`
  (ships as a stub returning "knowledge base not built yet" until Phase 6)
- `run_sql(query)` — guarded escape hatch for the long tail: dedicated
  read-only Postgres role (`DATABASE_URL_RO`), SELECT-only validation,
  schema whitelist, 5s statement timeout, enforced row LIMIT, org-scoped.
  Acceptable for single-owner internal v1; MUST be revisited before any
  client-facing chat access exists.

**Grounding rules (system prompt):** answer only from tool results; every
number traceable to a tool call; say "no data for that" rather than guess;
format pence as £; Europe/London dates. Each assistant message stores its
full tool-call trace in `chat_messages.tool_calls` (chat's equivalent of
`data_snapshot`), rendered in the UI as a collapsible "how I got this".

**Persistence & cost:** `chat_sessions` / `chat_messages` (§4.7). Tokens and
cost per message are tracked, included in the Money screen's AI-spend metric,
and count against the fleet token budget cap (§13).

**Surfaces (§5.9):** command-K "Ask" mode on every screen with page context
injected (current project/client), plus a dedicated Ask screen with session
history; answers stream and can render small tables and sparklines.
Phase 7+: inbound WhatsApp Q&A (reply to the daily brief with a question)
reuses this same agent.

---

## 10. ROI & "OS proves itself" accounting

Two ledgers, both first-class:

- **Client-system ROI** (per project): Σ`value_pence` + Σ`minutes_saved`
  × hourly-rate vs retainer + attributed costs → the ROI multiple used in
  briefs, value reports and upsells. Show honest confidence: revenue
  *attributed* vs revenue *influenced* are labeled differently.
- **The OS's own ROI**: `agent_runs` cost vs outcomes (upsells won from
  OS-generated insights, retainers defended with value reports). Surfaced on
  Money. If the OS costs £40/month in tokens and sources one £2k upsell, that
  slide writes itself — and it's also the agency's own best case study.

---

## 11. Repo structure (Turborepo monorepo)

```
azen-os/
├── apps/web/                    # Next.js app (UI + API routes)
│   ├── app/(dashboard)/         # command-center, clients, projects, money,
│   │                            # bookings, briefs, growth, learn, ask
│   ├── app/api/ingest/[key]/route.ts
│   ├── app/api/hooks/{stripe,calendly,ghl}/route.ts
│   └── components/              # charts, event-stream, metric-board, brief-card
├── packages/db/                 # Drizzle schema, migrations, seed, query helpers
├── packages/events/             # Event taxonomy: Zod schemas + TS types (single
│                                # source of truth, shared by app + SDK + agents)
├── packages/sdk-node/           # @azen/os-sdk (published or vendored)
├── packages/sdk-python/         # azen-os (mirror of node SDK)
├── packages/agents/             # runner, prompts/*.md, data-pack builders,
│                                # output schemas, delivery
├── packages/emails/             # React Email templates
├── jobs/                        # Trigger.dev task definitions
└── docs/                        # integration guide per stack, taxonomy reference
```

## 12. Environment variables

```
DATABASE_URL, SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
DATABASE_URL_RO                  # read-only role — Ask Azen run_sql (§9.8) only
ANTHROPIC_API_KEY, AGENT_MODEL, CHAT_MODEL
VOYAGE_API_KEY, EMBEDDING_MODEL, EMBEDDING_DIMS
AGENT_BUDGET_PENCE_MONTHLY       # fleet + chat token budget cap (§13)
TRIGGER_SECRET_KEY
RESEND_API_KEY, BRIEF_FROM_EMAIL
TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM, OWNER_WHATSAPP_TO
UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET
CALENDLY_WEBHOOK_SIGNING_KEY, CALENDLY_PAT
APP_URL, INGEST_SIGNING_VERSION=v1
```

## 13. Engineering conventions (Claude Code: follow these)

- TypeScript strict; Zod at every boundary (webhooks, agent outputs, forms).
- Money is integer pence everywhere; timezone Europe/London for all
  scheduling and rollup boundaries; store timestamps as UTC `timestamptz`.
- All rollup/brief jobs idempotent and safely re-runnable for any period.
  `period_start` = the UTC instant of the Europe/London local boundary; tests
  MUST cover the March/October DST transitions.
- Agent fleet + Ask Azen share a monthly token budget
  (`AGENT_BUDGET_PENCE_MONTHLY`): WhatsApp warning at 80%, non-critical runs
  (Scout, Industry Learning) halt at 100% — the daily brief always runs.
- Agent prompts are versioned files, never inline strings; every agent output
  stores its `data_snapshot` (auditable AI).
- Migration-first: never edit schema without a Drizzle migration.
- Tests where they pay: taxonomy schema validation, signature verification,
  rollup math, ROI calculation, one end-to-end ingest test. Vitest.
- Seed script (`pnpm seed:demo`) creates 1 org, 3 demo clients (dental,
  trades, clinic), 4 projects, and ~90 days of realistic synthetic events —
  the entire UI and all agents must be demo-able before any real client is
  wired in. This is also the test harness for briefs.
- A `simulate` CLI (`pnpm simulate --project=X --day`) replays a realistic
  day of events against a local/preview ingest endpoint.

## 14. Build phases (each ships something usable; get sign-off between phases)

**Phase 0 — Foundation (repo + data spine).** Turborepo, Supabase, Drizzle
schema for ALL tables in §4, RLS, auth (single owner login), taxonomy package
with Zod schemas for the full §7 list, seed + simulate scripts. Kick off the
external lead-time items now: Twilio WhatsApp sender + Meta template approval
(gates Phase 3 delivery), secure the npm `@azen` scope + PyPI `azen-os` name
(gates SDK publishing), lock the production ingest domain (§6.1).
*Done when:* `pnpm seed:demo` populates a browsable DB and every event type
validates.

**Phase 1 — Ingestion + Projects.** `/api/ingest` full pipeline (§6.3),
project CRUD, key generation + Setup tab (snippets, test event, live
first-event listener, delivery log), Node SDK, Events tab, event ticker on a
stub Command Center.
*Done when:* a test event sent from an external curl/SDK appears in the UI in
<5s with signature verified, deduped, and mirrored correctly.

**Phase 2 — Metrics engine.** Metric definitions + default KPI pack, hourly
rollup job, project Metrics tab (charts, ranges, compare periods, add-custom-
metric with live preview), Overview tab with goals + ROI headline, anomaly
detector.
*Done when:* seeded projects show correct numbers hand-verified against SQL,
and a custom JSONPath metric can be created from the UI.

**Phase 3 — Daily brief + delivery.** Agent runner, Daily Brief Agent, React
Email template, Resend + Twilio WhatsApp delivery, Briefs screen, Command
Center v1 (hero numbers, today column, inline brief).
*Done when:* for 3 consecutive mornings a correct brief (verified against
data_snapshot) lands by email + WhatsApp at 07:00 London.

**Phase 3b — Ask Azen (business Q&A chat).** The interactive agent (§9.8):
streaming chat route, read-only tool belt over rollups/events/money/bookings/
briefs, guarded SELECT-only `run_sql` on the read-only DB role,
`chat_sessions`/`chat_messages` persistence, command-K Ask mode + Ask screen
(§5.9). `search_knowledge` ships as a stub until Phase 6.
*Done when:* 10 canned questions spanning money, metrics, events, bookings,
and briefs answer correctly against seeded data, streaming in the UI, with
every number verifiable from the stored tool-call trace.

**Phase 4 — Money + Bookings.** Stripe + Calendly webhooks, bank-transfer
entry + CSV import, subscriptions/expected-retainer checks, expenses, Money
screen, Bookings screen (incl. client-end bookings rollup). Client detail
pages with LTV.
*Done when:* MRR, cash-this-month and overdue flags are correct against a
hand-built spreadsheet for the same data.

**Phase 5 — Weekly + Monthly + conversation intelligence.** Weekly
Synthesizer, conversation clustering job, Conversations + Agents tabs,
Monthly Strategist (all three documents), per-client value reports.
*Done when:* a full simulated month produces a monthly report whose numbers
are correct and whose narrative references real week-over-week trends.

**Phase 6 — Opportunity Scout + Upsell Engine + Learn.** Scout job +
Insights tab + Growth pipeline screen, Upsell Engine + proposal documents,
Industry Learning agent + Learn screen + pgvector retrieval (this also swaps
Ask Azen's `search_knowledge` stub for real retrieval), GHL webhook
mapping preset, Python SDK.
*Done when:* the seeded dental project yields ≥3 sensible, evidence-linked
opportunities and one client-ready upsell proposal document.

**Phase 7+ (later, do not build now):** client portal / shareable report
links, team seats, Slack delivery, invoice generation, deeper accounting
(Xero), mobile PWA polish, per-client white-label reports as PDFs.

## 15. Security

- Ingest: HMAC-SHA256 signatures + timestamp window; hashed secrets;
  per-key rate limits; secret rotation (public key stays stable — §6.1) +
  key-pair revocation from the UI; payload size cap (256KB); Stripe/Calendly
  native signature verification.
- App: Supabase Auth (email + TOTP for the owner), RLS on every table,
  service-role key server-side only, secrets only in env.
- RLS reality check: v1 server code reaches Postgres through Drizzle on a
  privileged connection, so the actual enforcement layer is app-level auth.
  RLS policies exist from day 1 but become load-bearing only when
  non-privileged access paths (client portal, team seats) arrive in Phase 7+.
- Ask Azen `run_sql` (§9.8): dedicated read-only Postgres role
  (`DATABASE_URL_RO`) with SELECT-only grants, schema whitelist, 5s statement
  timeout, enforced row LIMIT. Revisit before any client-facing chat access.
- Webhook endpoints return generic errors (no internals), log full detail
  server-side.

## 16. Privacy & data ethics (client businesses' customer data flows here)

- SDK docs instruct integrators to send **summaries and metadata, not full
  transcripts** by default; `transcript_ref` points back to the client
  system rather than copying transcripts in.
- Per-project data-collection config: PII fields can be masked at ingest
  (store hashed subject ids, drop emails/phones) — toggle in Setup tab.
- Retention policy per project (default: raw events 24 months, rollups
  forever). Deletion endpoint per subject id (GDPR requests will reach the
  agency's clients; the agency must be able to comply in minutes).
- Industry Learning aggregates across clients are **anonymized and
  cross-client only in aggregate form** — never client-identifiable in
  knowledge articles.
- Add a short data-processing note template the agency can attach to client
  contracts (docs/ folder).

## 17. What "done" looks like (acceptance narrative)

Tayyib wakes up; a WhatsApp from Azen OS reads: *"3 things: Smile Dental's
receptionist booked 11 patients yesterday (+37% vs avg). Elite Trades'
system threw 6 errors overnight — quote generator is failing, fix needed.
BrightClinic hit its monthly booking goal 9 days early. Full brief in your
inbox."* The email has charts. The Command Center ticker shows live events.
On the 1st of the month, three per-client value reports and two upsell
dossiers are waiting in Growth — one says the dental client's data justifies
a £4k recall-reminder build, with every number traceable to real events.
Mid-afternoon he hits ⌘K and types *"which client made us the most this
quarter, and is their retainer priced right?"* — Ask Azen answers in seconds,
every number backed by a visible query trace. The Learn tab quietly holds an
increasingly good encyclopedia of dental, trades, and clinic automation.
Nothing in the agency lives in a scattered sheet anymore.

## 18. Instructions to Claude Code (read last, remember first)

1. Work phase by phase (§14); within a phase, data model → API → jobs → UI.
2. After each phase, stop and demo (seed data + simulate CLI) before moving on.
3. Never invent event types outside §7 without adding them to the taxonomy
   package first.
4. Check current docs/model IDs at build time (Anthropic models, Trigger.dev
   v3 API, Twilio WhatsApp template flow, Calendly webhook API) rather than
   assuming — pin versions in one place.
5. Keep every agent prompt in `packages/agents/prompts/` and treat prompt
   changes like code changes (reviewable diffs).
6. When something in this spec conflicts with reality (API limits, pricing),
   choose the pragmatic path, note the deviation in `docs/DECISIONS.md`, and
   flag it in your summary.
