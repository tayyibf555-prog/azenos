# @azen/os-sdk

Send events to Azen OS — tiny, zero-dependency, fire-and-forget with retry
(spec §6.2). Node ≥ 18 (uses the global `fetch` and `node:crypto`).

Every method resolves to a `TrackResult` and **never throws** — a failed
delivery is a return value, not an exception, so instrumentation can never
crash the system it observes.

## Install

Inside this monorepo it is already wired up as a workspace package:

```jsonc
// package.json
{ "dependencies": { "@azen/os-sdk": "workspace:*" } }
```

(When published: `pnpm add @azen/os-sdk` / `npm i @azen/os-sdk`.)

## Quick start

```ts
import { AzenOS } from '@azen/os-sdk'
const os = new AzenOS({ key: process.env.AZEN_KEY, secret: process.env.AZEN_SECRET })

await os.track('booking.created', {
  subject: { kind: 'customer', id: 'cus_123', name: 'Jane D' },
  actor: { kind: 'ai_agent', id: 'receptionist-v2', name: 'AI Receptionist' },
  data: { service: 'Checkup', starts_at: '2026-07-14T10:00:00Z', channel: 'voice' },
  valuePence: 8500,
  minutesSaved: 12,
  idempotencyKey: 'call_789:booking',
})
```

`key` is the project public key (`azn_pk_...`, part of the ingest URL);
`secret` is the project secret (`azn_sk_...`) shown once at key creation.

## Constructor options

| Option       | Type                       | Default                | Notes |
| ------------ | -------------------------- | ---------------------- | ----- |
| `key`        | `string`                   | — (required)           | Project public key; the endpoint is `${baseUrl}/api/ingest/${key}`. |
| `secret`     | `string`                   | — (required)           | Signs requests (hmac) or is sent verbatim (token). |
| `baseUrl`    | `string`                   | `https://os.azen.ai`   | Trailing slashes are stripped. |
| `authMode`   | `"hmac" \| "token"`        | `"hmac"`               | See [Token mode](#token-mode). |
| `maxRetries` | `number`                   | `3`                    | Retries **after** the first attempt (3 → up to 4 attempts). |
| `timeoutMs`  | `number`                   | `5000`                 | Per-attempt timeout, aborted via `AbortController`. |
| `fetch`      | `(url, init) => Promise<Response>` | `globalThis.fetch` | Injectable for tests / custom transports. |
| `onError`    | `(failure) => void`        | —                      | Fires **once per call** with the final failure. |

## Methods

All event methods return `Promise<TrackResult>`:

```ts
type TrackResult =
  | { ok: true; accepted: number; duplicates: number }
  | { ok: false; status?: number; error: string }
```

`duplicates` counts events the server had already stored under the same
`idempotency_key` — a retried delivery is a duplicate, never an error.

### `track(type, options?)`

Sends one event. `type` is any of the 41 taxonomy types (autocompleted) or a
`custom.*` string — unknown types are accepted server-side and remapped to
`custom.*`, never dropped.

| Option           | Type                        | Notes |
| ---------------- | --------------------------- | ----- |
| `data`           | `Record<string, unknown>`   | Type-specific payload (see `@azen/events` taxonomy). Extra keys are kept. |
| `subject`        | `{ kind, id?, name? }`      | Who/what the event is about. |
| `actor`          | `{ kind: "ai_agent" \| "human" \| "system", id?, name? }` | Who did it. |
| `occurredAt`     | `Date \| string`            | Date or ISO-8601 string; defaults to now. |
| `idempotencyKey` | `string`                    | Defaults to a fresh UUID, generated **once** and reused across retries. |
| `valuePence`     | `number`                    | Integer pence — one of the two ROI atoms. |
| `minutesSaved`   | `number`                    | The other ROI atom. |
| `currency`       | `string`                    | 3-letter ISO code; server defaults to `gbp`. |

### `trackBatch(events)`

One POST whose body is a JSON **array** of events (`{ type, ...trackOptions }`
each). Hard cap **100 events**: a larger batch returns
`{ ok: false, error: "batch_too_large: ..." }` without touching the network.
An empty array short-circuits to `{ ok: true, accepted: 0, duplicates: 0 }`.

```ts
await os.trackBatch([
  { type: 'lead.created', data: { name: 'Sam', source: 'webchat' } },
  { type: 'booking.created', data: { starts_at: '2026-07-14T10:00:00Z' } },
])
```

### `conversation(options)`

Sugar for `llm.conversation`. Camel-cased fields are mapped onto the taxonomy
payload (`conversationId` → `conversation_id`, `durationSeconds` →
`duration_seconds`, `transcriptRef` → `transcript_ref`); envelope extras
(`subject`, `actor`, `occurredAt`, `idempotencyKey`, `valuePence`,
`minutesSaved`, `currency`) ride along unchanged.

```ts
await os.conversation({
  channel: 'voice',                 // 'voice' | 'webchat' | 'whatsapp' | 'sms' | 'email'
  resolution: 'resolved',           // 'resolved' | 'escalated' | 'abandoned'
  conversationId: 'conv_42',
  turns: 6,
  durationSeconds: 190,
  intent: 'book_appointment',
  summary: 'Booked a checkup for Tuesday',
  sentiment: 'positive',            // 'positive' | 'neutral' | 'negative'
  minutesSaved: 9,
})
```

### `heartbeat(options)`

Sugar for `agent.heartbeat` — lets the dashboard show an agent as alive.

```ts
await os.heartbeat({
  agentId: 'receptionist-v2',       // required
  name: 'AI Receptionist',
  version: '2.1.0',
  purpose: 'books appointments',
  status: 'ok',                     // 'ok' | 'degraded' | 'down'
})
```

### `metric(key, value, options?)`

Sugar for arbitrary custom gauges: sends `custom.metric` with data
`{ key, value }`. `options` accepts every `track` option except `data`.

```ts
await os.metric('chairs_filled', 7)
```

### `flush()`

No-op today — resolves immediately. It exists so callers can already write
`await os.flush()` before process exit; if the SDK ever buffers events, the
call site won't change.

## Retry semantics

| Response                  | Behaviour |
| ------------------------- | --------- |
| `2xx`                     | Success — returns `{ ok: true, accepted, duplicates }`. |
| `429`                     | Retried. Waits `Retry-After` (seconds) when the header is present, else backoff. |
| Other `4xx`               | **Terminal** — no retry, returns `{ ok: false, status, error }`. |
| `5xx`                     | Retried with backoff. |
| Network error / timeout   | Retried with backoff. Each attempt is aborted after `timeoutMs` via `AbortController`. |

- Attempts = `1 + maxRetries` (default `3` retries → up to 4 attempts).
- Backoff before retry *n* (0-based): `250ms · 2^n` plus full jitter
  (`Math.random() · 250ms · 2^n`) — so retry 1 waits 250–500ms, retry 2
  500–1000ms, retry 3 1000–2000ms.
- The `idempotency_key` is generated once per call, so server-side dedup
  collapses retries into a single stored event.
- Each attempt is re-signed with a fresh timestamp so a long retry tail never
  falls outside the server's ±300s replay window.
- `onError` fires once, with the final failure, after retries are exhausted
  (or immediately on a terminal failure). The same object is the resolved
  value, so polling the return value and using the callback are equivalent.
- No method ever throws — even a synchronously-throwing `fetch` or a throwing
  `onError` callback resolves to `{ ok: false, ... }`.

## Auth

### HMAC (default)

Every request carries:

```
X-Azen-Signature: t=<unix_seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<rawBody>")>
User-Agent: azen-os-sdk/0.1.0
Content-Type: application/json
```

The server rejects timestamps outside ±300s (replay protection).

### Token mode

For no-code callers that can't sign (e.g. GHL webhook actions), a project key
can be issued with `auth_mode = 'token'`. Construct the client with
`authMode: 'token'` and the SDK sends the secret as a header instead of
signing:

```
X-Azen-Token: <secret>
```

Token mode only works for keys created in token mode — an hmac key will
reject it (and vice versa). Prefer HMAC anywhere you control the code.

## curl equivalent (manual signing)

What the SDK does under the hood — byte-identical body and signature:

```bash
AZEN_KEY="azn_pk_..."       # public key
AZEN_SECRET="azn_sk_..."    # secret

BODY='{"type":"custom.ping","occurred_at":"2026-07-12T10:00:00Z","idempotency_key":"ping-1","data":{}}'
TS=$(date +%s)
SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$AZEN_SECRET" | awk '{print $NF}')

curl -sS "https://os.azen.ai/api/ingest/$AZEN_KEY" \
  -H "content-type: application/json" \
  -H "x-azen-signature: t=$TS,v1=$SIG" \
  --data "$BODY"
# → {"accepted":1,"duplicates":0,"rejected":[]}
```

The signed string is `"$TS.$BODY"` and `$BODY` must be sent byte-for-byte as
signed — re-serialising the JSON invalidates the signature. Token-mode keys
replace the signature header with `-H "x-azen-token: $AZEN_SECRET"`.
