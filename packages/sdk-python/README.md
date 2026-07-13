# azen-os (Python SDK)

Fire-and-forget event tracking for [Azen OS](../../README.md) — spec §6.2. Mirrors
the Node SDK (`@azen/os-sdk`): every method returns a result object and **never
raises**, requests are retried with exponential backoff + jitter, and HMAC
signing is byte-identical to the canonical `@azen/events/signing` (guarded by a
pinned cross-language vector in `tests/test_signing.py`).

## Install

```bash
pip install ./packages/sdk-python        # editable during development: pip install -e .
```

The only runtime dependency is `requests` (used by the default HTTP transport).
Signing and event-building are pure stdlib; you can inject a custom `transport`
to avoid `requests` entirely.

## Usage (spec §6.2 example)

```python
from azen_os import AzenOS

os_client = AzenOS(
    key="azn_pk_live_...",       # project public key (routes the request)
    secret="azn_sk_live_...",    # project secret (signs the request)
    base_url="https://os.azen.ai",
    auth_mode="hmac",            # or "token" for no-code callers
    max_retries=3,
    timeout=5.0,
)

# A booking your system just took:
res = os_client.track(
    "booking.created",
    data={"service": "Checkup", "starts_at": "2026-07-14T10:00:00Z"},
    subject={"kind": "customer", "name": "Zoë"},
    value_pence=8500,
    minutes_saved=15,
)
if not res.ok:
    print("azen ingest failed:", res.error)   # never raises — inspect res.ok

# Conversation, heartbeat, and gauge sugar:
os_client.conversation(channel="webchat", resolution="resolved", intent="booking")
os_client.heartbeat(agent_id="receptionist-bot", status="ok")
os_client.metric("leads_today", 12)
```

`track()` returns `TrackSuccess(ok=True, accepted, duplicates)` or
`TrackFailure(ok=False, error, status)`. It is fire-and-forget: a transport error,
timeout, or non-2xx response yields a `TrackFailure` rather than an exception.

## curl equivalent

The SDK POSTs the JSON event envelope to `/api/ingest/<public_key>` with an HMAC
signature header `t=<unix_seconds>,v1=HMAC-SHA256(secret, "<t>.<rawBody>")`:

```bash
PUBLIC_KEY="azn_pk_live_..."
SECRET="azn_sk_live_..."
BODY='{"type":"booking.created","occurred_at":"2026-07-14T09:30:00Z","idempotency_key":"booking-123","data":{"service":"Checkup","starts_at":"2026-07-14T10:00:00Z"}}'
TS=$(date +%s)
SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $2}')

curl -sS -X POST "https://os.azen.ai/api/ingest/$PUBLIC_KEY" \
  -H "content-type: application/json" \
  -H "x-azen-signature: t=$TS,v1=$SIG" \
  -d "$BODY"
```

No-code callers that cannot sign use the token header instead
(`auth_mode="token"`), which sends `x-azen-token: <secret>` and no signature.

## Test

```bash
cd packages/sdk-python
python3 -m pytest
```

`tests/test_signing.py` pins a signature vector produced by the canonical TS
signer and asserts a byte-for-byte match, so the Python and Node implementations
can never drift. `tests/test_client.py` covers the never-raises contract and the
retry/backoff behaviour with an injected fake transport (no network).
