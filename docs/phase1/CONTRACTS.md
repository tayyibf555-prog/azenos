# Phase 1 build contracts — READ FULLY BEFORE WRITING CODE

This document is the binding interface spec for Phase 1 (ingestion +
projects). It was authored by the lead session after re-reading spec §5, §6,
§12–§15. Where this doc and your instincts disagree, THIS DOC WINS. Where
this doc and AZEN_OS_SPEC.md disagree, this doc wins too (deviations are
deliberate and recorded in docs/DECISIONS.md).

## Ground rules (all workstreams)

- TypeScript strict. Zod at every boundary. Money = integer pence. UTC
  `timestamptz` in the DB; Europe/London for day boundaries — use
  `londonTodayUTC()` from `@azen/db`, never hand-roll.
- Relative imports are EXTENSIONLESS (`./foo`, never `./foo.js`).
- No new dependencies. No edits to package.json, pnpm-lock.yaml, tsconfig,
  turbo.json, migrations/, or packages/db/src/schema/**. If you believe you
  need one, STOP and say so in your final report instead of doing it.
- Never run `pnpm install`, `next dev`, `next build`, or any git command.
  Verify with `pnpm --filter <pkg> typecheck` and `pnpm --filter <pkg> test`.
- Local Postgres runs at 127.0.0.1:54329 (db `azen_os`), already migrated and
  seeded. `.env` at repo root is loaded automatically when you import
  `@azen/db` (its client loads the root .env). Tests that need the DB: create
  your own throwaway org (+client/project/key) with `crypto.randomUUID()`
  ids, and delete everything you created in `afterAll` (delete order:
  webhook_deliveries → events → bookings → insights → ingest_rate_counters →
  project_keys → project_integrations → projects → contacts → clients →
  users → organizations). NEVER mutate the demo org
  (`DEMO_ORG_ID` from `@azen/db`).
- Comments: only for constraints the code can't express. Match the existing
  codebase's style (read a few files first).
- Server code may import `@azen/db`, `@azen/db/keys`, `@azen/events`,
  `@azen/events/signing`. NEVER import `@azen/db/keys` or
  `@azen/events/signing` from client components (node:crypto).

## Auth model (dashboard routes)

Every dashboard API route resolves the org via `requireOrgId()` from
`apps/web/lib/server/org.ts` (already written) and scopes EVERY query by
`orgId`. Wrap handlers in `withErrorHandling` from `lib/server/http.ts`.
Errors: `{ error: string }` JSON. 400 invalid input (include zod issue
summary), 404 not-found-in-this-org, 401 handled by the wrapper.

## Signing protocol (already implemented — DO NOT reimplement server-side)

`@azen/events/signing`:
- Header `X-Azen-Signature: t=<unix_seconds>,v1=<hex hmac-sha256(secret, "<t>.<rawBody>")>`
- `signBody(secret, rawBody, ts?) → string`, `verifySignature(secret,
  rawBody, header, {toleranceS?, nowS?}) → {ok:true,timestamp} |
  {ok:false, reason:"malformed"|"stale"|"mismatch"}`. Window ±300s.
- Token fallback (no-code callers, §6.3): header `X-Azen-Token: <secret>`,
  verified with `verifySecretAgainstHash` from `@azen/db/keys`; only when
  `project_keys.auth_mode = 'token'`.
- Key material helpers (`@azen/db/keys`): `generateKeyPair()`,
  `generateSecret()` (rotation), `decryptSecret(ciphertext)`,
  `verifySecretAgainstHash(candidate, hash)`.

## Ingest endpoint (workstream B) — `POST /api/ingest/[publicKey]`

File: `apps/web/app/api/ingest/[publicKey]/route.ts` (+ helpers under
`apps/web/lib/server/ingest/`). `export const runtime = "nodejs"`.

Pipeline, in order (each step a small named function in lib/server/ingest/):

1. **Size cap**: reject > 262,144 bytes (check content-length header AND
   `Buffer.byteLength(raw)`) → 413 `{error:"payload_too_large"}`.
2. **Key lookup** by `public_key` (single indexed select, join projects for
   org). Unknown or `revoked_at IS NOT NULL` → 401 `{error:"unauthorized"}`.
   No delivery log row for unknown keys (org unknowable) — console.error only.
3. **Auth**: `auth_mode='hmac'` → `verifySignature(decryptSecret(...), raw,
   req.headers["x-azen-signature"])`; `'token'` → constant-time hash compare
   of `x-azen-token`. Fail → 401 generic body, delivery row `rejected` with
   the real reason in `error` (server-side detail only, §15).
4. **Rate limit**: limit = `project_keys.rate_limit_per_10s`. If
   `UPSTASH_REDIS_REST_URL` + token set → Upstash REST `INCR`/`EXPIRE` fixed
   10s window via plain `fetch` (no SDK). Else Postgres fallback: window
   start = `to_timestamp(floor(epoch/10)*10)`, one atomic
   `INSERT ... ON CONFLICT (project_key_id, window_start) DO UPDATE SET
   count = ingest_rate_counters.count + 1 RETURNING count` on
   `ingest_rate_counters`. Over limit → 429 `{error:"rate_limited"}` +
   `Retry-After` header (seconds to window end), delivery row `rejected`,
   error `rate_limited`, raw NOT kept. Opportunistically delete stale
   windows (< now - 60s) — fire-and-forget, not on the response path.
5. **Parse**: `JSON.parse` fail → 400 `{error:"invalid_json"}`, delivery
   `rejected`, RAW KEPT (dead-letter). Body shapes accepted: single event
   object, bare array, or `{events:[...]}`. > 100 events → 400
   `{error:"batch_too_large"}`, raw kept.
6. **Validate/normalize**: `parseEvent(e)` from `@azen/events` per event.
   Unknown types are already remapped to `custom.*` by the taxonomy — they
   are ACCEPTED. Hard failures (bad envelope / known-type bad data) go to
   `rejected: [{index, reason}]` (reason = first zod issue, terse).
7. **Store**: single multi-row `INSERT ... ON CONFLICT ON CONSTRAINT
   events_dedup_uq DO NOTHING RETURNING id, idempotency_key, type` — set
   `orgId`, `projectId` from the key row; `source`: `'sdk'` for hmac keys,
   `'ghl'` for token keys; `raw` = the original (pre-normalization) event
   JSON; envelope fields from the normalized event (`occurred_at`,
   actor/subject, data, value_pence, currency, minutes_saved). Duplicates =
   attempted − returned (per-key mapping via returned idempotency_keys).
8. **Mirror**: for each INSERTED (not duplicate) `booking.*` event call
   `mirrorBookingEvents(db, rows)` — implemented in
   `packages/db/src/mirror.ts` (exported from `@azen/db` root).
   AUTHORITATIVE SPEC: replicate exactly what the seed's mirroring in
   `packages/db/src/seed/index.ts` does for the same events (it is the
   reference implementation, and its output is what Phase 1 ships against).
   Real bookings columns (packages/db/src/schema/bookings.ts): `invitee`
   jsonb (subject info), `startsAt`/`endsAt`, `status`, `externalId` text
   (carries the booking-id convention — lifecycle events reference the
   created event via `data.booking_id`), `sourceEventId` uuid (the events
   row id), `raw` jsonb (event data), kind `client_end_customer`, source
   `client_system`. Lifecycle events (`cancelled`/`rescheduled`/
   `completed`/`no_show`) update the row matched by
   `(project_id, external_id = data.booking_id)`; no match → skip silently.
   (Earlier revisions of this section named nonexistent columns
   `externalRef`/`service`/`endCustomerName` — corrected 2026-07-12; the
   seed always was the tie-breaker.)
9. **Delivery log**: ONE row per HTTP request in `webhook_deliveries`:
   status `accepted` (≥1 inserted), `duplicate` (all dupes), `rejected`
   (auth/parse fail or ALL events rejected). httpStatus, latencyMs
   (performance.now delta), eventId = first inserted id, `raw` kept ONLY
   for status `rejected`, `error` = terse summary (≤500 chars). Mixed
   accept+reject: status `accepted`, error carries `"n rejected: ..."`.
10. **React** (AFTER response via `runAfterResponse` from
    `lib/server/after.ts`): (a) update `project_keys.last_used_at`;
    (b) error-streak alerts: if any inserted event is `system.error`, load
    enabled `alert_rules` kind `error_streak` for this project (or org-wide
    `project_id IS NULL`), condition `{event_type, count, window_minutes}`;
    count matching events in window; if count ≥ threshold AND
    (`last_fired_at` older than `cooldown_minutes`) → insert `insights` row
    (kind `anomaly`, confidence `high`, status `new`, title
    `"<project>: <n> <type> events in <window>m"`, summary listing latest
    messages, `evidence` = `{event_ids:[...]}`, `createdByKind:'agent'`) and
    update `last_fired_at`. WhatsApp delivery is Phase 3 — the insight row
    IS the Phase 1 artifact.
11. **Respond** (before step 10 runs): 200
    `{accepted: n, duplicates: n, rejected: [{index, reason}]}`. Target
    < 300ms: steps 2–9 must be O(1) queries (one select, one insert, one
    counter upsert, one delivery insert, mirror only when bookings present).

Also implement (same workstream, they reuse the pipeline internals):
- `POST /api/projects/[projectId]/test-event` — org-checked via
  `requireOrgId`; loads the project's active key, decrypts the secret,
  builds `{type:"custom.azen_test", occurred_at: now ISO, idempotency_key:
  "test:<uuid>", data:{note:"Sent from the Setup tab"}}`, constructs a signed
  `Request` and calls the ingest route handler DIRECTLY (import { POST } —
  no network hop), returns the ingest response plus `{eventType:
  "custom.azen_test"}`. Token-mode keys send the token header instead.
- `POST /api/deliveries/[deliveryId]/replay` — org-checked; delivery must
  have `raw`; re-runs pipeline steps 5–10 (skip size/auth/rate), writes a
  NEW delivery row (`error: "replay of <original id>"`), returns the same
  response shape. 409 `{error:"nothing_to_replay"}` if no raw.

Unit/integration tests (`apps/web/test/ingest/*.test.ts`, vitest, real local
DB): happy path accept; duplicate resend → `duplicates:1`, delivery row
`duplicate`; tampered signature → 401 + delivery `rejected`; stale timestamp
→ 401; token-mode auth accept + wrong token 401; unknown event type →
accepted as `custom.*`; known type with invalid data → in `rejected[]`, raw
kept on delivery row; `booking.created` mirrors a bookings row;
`booking.cancelled` flips its status; oversize → 413; batch of 100+ → 400;
rate limit: set key limit to 3, 4th request → 429 with Retry-After; replay
of a rejected delivery succeeds after fixing; test-event handler inserts.
Use unique publicKeys (`azn_pk_test_<uuid>`), clean up per Ground Rules.

## Dashboard API (workstream C) — all under `apps/web/app/api/`

Dynamic segment name is `[projectId]` / `[deliveryId]` / `[clientId]`
EVERYWHERE (Next requires consistent param names). All org-scoped, wrapped,
zod-validated (schemas in `apps/web/lib/server/schemas.ts`; shared query
helpers in `apps/web/lib/server/queries.ts`).

- `GET /api/overview` → `{mrrPence, activeClients, liveProjects,
  eventsTotal, clientBookingsThisMonth}` — MRR = sum active subscriptions'
  `amount_pence_monthly`; clientBookingsThisMonth = bookings kind
  `client_end_customer` with `starts_at` ≥ London month start
  (`londonMonthStartUTC(0)`).
- `GET /api/ticker?afterId=<uuid>&limit=30` → `{events:[{id, type,
  occurredAt, receivedAt, projectId, projectName, projectSlug, subjectName,
  valuePence, minutesSaved}]}` newest-first by `received_at` (org-wide;
  join projects; projectName "Agency" when project_id null). `afterId`:
  return only events with received_at strictly newer than that event's
  (for incremental polls).
- `GET /api/clients` → `{clients:[{id, name, status, industrySlug,
  projectCount, createdAt}]}`; `POST /api/clients` `{name, industrySlug?,
  status?}` → 201 `{client}` (slug: reuse existing industries rows by slug;
  unknown slug → create industries row named from slug).
- `GET /api/projects` → `{projects:[{id, name, slug, status, health, type,
  stack, retainerPenceMonthly, client:{id,name}, publicKey, lastEventAt,
  eventsToday}]}` — lastEventAt = max(occurred_at) via one lateral/grouped
  query (NOT N+1); eventsToday = count where occurred_at ≥ londonTodayUTC().
- `POST /api/projects` body `{name, type, stack?, description?,
  retainerPenceMonthly?, clientId}` XOR `{..., newClient:{name,
  industrySlug?}}` → creates client if needed, slugifies name (append
  `-2`, `-3` on collision), `status:'building'`, generates key pair
  (`generateKeyPair()` from `@azen/db/keys`, auth_mode `hmac` unless
  `stack==='ghl'` → `token`), inserts `project_keys` row → 201 `{project,
  key:{publicKey, secret, authMode}}`. THE ONLY RESPONSE EVER CONTAINING
  `secret`, besides rotate/revoke below.
- `GET /api/projects/[projectId]` → `{project, client, keys:[{id,
  publicKey, authMode, rateLimitPer10s, createdAt, revokedAt, lastUsedAt,
  label}], eventTypesSeen:[{type, count, lastAt}]}` (distinct types, one
  GROUP BY).
- `PATCH /api/projects/[projectId]` `{status?, health?, description?,
  retainerPenceMonthly?, retainerActive?}` → `{project}`.
- `POST /api/projects/[projectId]/keys/rotate` → new secret on the SAME
  public key (`generateSecret()`, update hash+ciphertext) → `{publicKey,
  secret}`. Old secret is invalid immediately (no grace — §6.1).
- `POST /api/projects/[projectId]/keys/revoke` → sets `revoked_at` on the
  active key AND creates a fresh key pair (new URL, §6.1) → `{publicKey,
  secret, authMode}`.
- `GET /api/projects/[projectId]/events?type&q&from&to&limit=50&cursor` →
  `{events:[...full event rows...], nextCursor}`. Keyset pagination ordered
  `occurred_at DESC, id DESC`; cursor = base64 of `${occurredAt.toISOString()}|${id}`.
  `type` exact match; `from`/`to` ISO dates on occurred_at; `q` → `data::text
  ILIKE '%q%' OR subject->>'name' ILIKE OR type ILIKE`. Cap limit at 200.
- `GET /api/projects/[projectId]/deliveries?limit=50` →
  `{deliveries:[{id, status, httpStatus, latencyMs, error, receivedAt,
  hasRaw}]}` newest first (hasRaw = raw is not null; never return raw
  itself — it can contain end-customer data).

Tests (`apps/web/test/api/*.test.ts`): projects list shape + lastEventAt
correct for a throwaway project with 2 events at known times; create
project → key returned once, project_keys row hashed+encrypted (assert
secret_hash = sha256 of returned secret); rotate invalidates old secret
(verifySecretAgainstHash false for old after rotate); events pagination
returns stable pages with no overlap/gap across a 3-page walk; ticker
afterId incremental fetch. Direct handler invocation (import route module,
call `GET(new Request(url))` with params where needed).

## Node SDK (workstream A) — `packages/sdk-node`

Zero runtime dependencies. Node ≥ 18 (global fetch). Skeleton
(package.json/tsconfig/vitest.config) exists — do not touch package.json.
`@azen/events` is a devDependency: `import type` ONLY in src/ (runtime
imports allowed in test/).

```ts
import { AzenOS } from "@azen/os-sdk";
const os = new AzenOS({ key, secret, baseUrl?, authMode? = "hmac",
  maxRetries? = 3, timeoutMs? = 5000, fetch?, onError? });
await os.track("booking.created", { data, subject?, actor?, occurredAt?,
  idempotencyKey?, valuePence?, minutesSaved?, currency? });  // → TrackResult
await os.trackBatch([...]);            // single POST, array body, ≤100
await os.conversation({...});          // sugar → llm.conversation
await os.heartbeat({ agentId, name?, version?, purpose?, status? });
await os.metric(key, value, opts?);    // → type "custom.metric", data {key, value}
await os.flush();                      // no-op today (API stability)
```

- `track` NEVER throws (fire-and-forget, §6.2): returns
  `{ok:true, accepted, duplicates} | {ok:false, status?, error}`; `onError`
  callback fires on final failure.
- Endpoint: `${baseUrl}/api/ingest/${key}` (baseUrl default
  `https://os.azen.ai`, strip trailing slash).
- `occurredAt` accepts Date | ISO string, defaults now. `idempotencyKey`
  auto-uuid — generated ONCE per track call, stable across retries.
- Signing: own HMAC impl via `node:crypto`, header format IDENTICAL to
  `@azen/events/signing` (`t=<s>,v1=<hex>`); token mode sends
  `X-Azen-Token` instead. `User-Agent: azen-os-sdk/0.1.0`.
- Retries: 429 + 5xx + network errors; exp backoff 250ms·2^n + full jitter;
  respect Retry-After if present; timeout via AbortController per attempt.
- 4xx (except 429) = terminal, no retry.
- Tests: signature cross-verified with `verifySignature` from
  `@azen/events/signing` (this is MANDATORY — drift protection); retry/backoff
  with injected fake fetch (fake timers); idempotency key stable across
  retries; batch body shape; timeout abort; README.md with the §6.2 example,
  every method, retry semantics, and a curl equivalent.

## UI (workstream D) — `apps/web/app/**` + `components/**`

Read `app/page.tsx`, `app/layout.tsx`, `app/login/page.tsx` first and match
the existing dark aesthetic (bg #0b0e14 family). Create `app/globals.css`
with CSS custom-property tokens + small utility classes (.card, .btn,
.btn-primary, .input, .table, .badge, .tab, .dot) — plain CSS, no
frameworks, no CSS-in-JS deps. Layout: fixed sidebar (220px) — logo
"Azen OS", nav: Command Center `/`, Clients `/clients`, Projects
`/projects`, then Money/Bookings/Briefs/Growth/Learn/Ask as disabled rows
with a phase chip ("P4", "P3"…). Keep the demo-mode banner. Server
components query the DB directly for initial data (via `@azen/db` +
`requireOrgId()`); client components poll the JSON APIs (plain
`fetch` + `useEffect`, no SWR). All API shapes are in the
Dashboard API section above — code against them exactly.

Pages:
1. `/` Command Center: hero stat cards (from /api/overview server-side:
   MRR, active clients, live projects, events total, "systems booked N
   appointments for clients this month") + **live ticker** client component
   (poll `/api/ticker` every 2.5s with afterId incremental; rows: relative
   time, type badge colored by category, project name, subject/value
   summary; subtle fade-in on new rows; cap 50 rows client-side; pause
   button).
2. `/projects`: card grid from server query (shape of GET /api/projects):
   name, client, status pill, health dot, type, retainer (£/mo), events
   today, lastEventAt as relative time — red "silent Nd" badge when > 24h
   AND status is live. "+ New project" button.
3. `/projects/new`: client-component form (name, client select from
   /api/clients + "new client" inline text input toggle, type select from
   the project_type enum values, stack select, retainer £ input converted
   to pence). Submit → POST /api/projects → on success render the
   **key-reveal screen** (this replaces the form — do NOT navigate away
   silently): big warning "shown once", copy-to-clipboard blocks for
   endpoint URL (`${location.origin}/api/ingest/<publicKey>`) and secret,
   then snippet tabs (Node SDK / curl / GHL) pre-filled with the real key +
   endpoint (secret only as `AZEN_SECRET=...` placeholder line), and a
   "Go to project →" link.
4. `/projects/[projectId]` with `?tab=overview|events|setup` (default
   overview). Header: name, client, status pill, health dot, retainer.
   Disabled tabs Metrics/Conversations/Agents/Insights with phase chips.
   - **Overview**: counts-by-type last 7 days (server query, small table),
     total events, first/last event timestamps, "ROI headline lands in
     Phase 2" placeholder card.
   - **Events**: client component. Filter bar: type select (from
     eventTypesSeen), free-text search, from/to date inputs, Apply +
     Reset. Table rows: occurred_at (Europe/London format), type badge,
     subject name, compact data summary (first ~3 keys), value (£ when
     value_pence), expandable row showing pretty-printed full JSON (incl.
     raw). "Load more" keyset pagination via nextCursor. Auto-refresh
     toggle (5s, only fetches newest via from=lastSeen).
   - **Setup**: endpoint URL copy block; key panel (publicKey, auth mode
     badge, rate limit, created, lastUsedAt); buttons: "Send test event"
     (POST test-event → toast with result, then trigger events refresh),
     "Rotate secret" (confirm modal explaining old secret dies now → new
     secret reveal-once block), "Revoke & re-issue" (scarier modal — URL
     changes → full new key reveal); snippet tabs (Node/curl/GHL) with real
     publicKey; **event-type checklist**: all 41 taxonomy types grouped by
     category (import `EVENT_TYPES` from `@azen/events` — server component
     passes it down), green check when in eventTypesSeen, count + lastAt on
     hover/inline; **delivery log** table (status chip, http, latency, time,
     error truncated w/ title tooltip, Replay button when status is
     rejected/failed AND hasRaw → POST replay → toast + refresh); **live
     first-event listener**: when project has zero events, show pulsing
     "waiting for first event…" chip polling /api/projects/:id/events?limit=1
     every 2s; flips to green "first event received ✓" when one lands.
5. `/clients`: table (name, status badge, industry, #projects, created) +
   "New client" modal form → POST /api/clients.

Components (in `apps/web/components/`, small & dependency-free): `Ticker`,
`EventsTable`, `JsonView` (pre + syntax-lite), `CopyBlock`, `SnippetTabs`,
`StatusPill`, `HealthDot`, `Tabs`, `Modal`, `Toast` (context-free, simple),
`RelativeTime` (client, re-renders each 30s). Buttons must be `<button>`,
inputs labelled. Empty states for every list ("No events yet — send one
from the Setup tab").

Formatting: London timezone via `Intl.DateTimeFormat("en-GB", {timeZone:
"Europe/London", ...})`; money via a shared `formatPence` in
`apps/web/lib/format.ts` (£ with commas, pence dropped when 0).

No tests required; MUST pass `pnpm --filter @azen/web typecheck`.

## File ownership (hard boundaries — do not cross)

- A (SDK): `packages/sdk-node/{src,test,README.md}`
- B (ingest): `apps/web/app/api/ingest/**`,
  `apps/web/app/api/projects/[projectId]/test-event/**`,
  `apps/web/app/api/deliveries/**`, `apps/web/lib/server/ingest/**`,
  `apps/web/test/ingest/**`, `packages/db/src/mirror.ts` (+ its export line
  appended to `packages/db/src/index.ts` — the ONLY shared-file edit B may
  make)
- C (dashboard API): `apps/web/app/api/{overview,ticker,clients,projects}/**`
  EXCEPT `projects/[projectId]/test-event`, `apps/web/lib/server/{queries,schemas}.ts`,
  `apps/web/test/api/**`
- D (UI): `apps/web/app/{page.tsx,layout.tsx,globals.css}`,
  `apps/web/app/{projects,clients,coming-soon}/**` (pages only, NOT app/api),
  `apps/web/components/**`, `apps/web/lib/format.ts`
- Already owned by the lead (read, never edit): `packages/events/src/signing.ts`,
  `packages/db/src/keys.ts`, `apps/web/lib/server/{org,after,http}.ts`,
  `apps/web/lib/supabase.ts`, all schema/migrations/seed files.
