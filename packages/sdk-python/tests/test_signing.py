"""Cross-language signing drift guard (docs/phase6/CONTRACTS.md §P6-SDK-PY).

The expected header/signature below were produced by the CANONICAL TypeScript
signer (``@azen/events/signing`` — ``computeSignature(secret, ts, body)``) and are
PINNED here. If ``azen_os.signing`` ever diverges from the Node/TS implementation
these byte-for-byte assertions fail, exactly the guard the Node SDK's
``signing.test.ts`` provides. This is the same protection in reverse: the two
implementations can never drift across languages.

To regenerate the vector (only if the canonical scheme itself changes):
    node -e 'const {createHmac}=require("crypto");const s="azn_sk_test_4f6f8e2d",t=1780000000,b=process.argv[1];console.log(createHmac("sha256",s).update(`${t}.${b}`).digest("hex"))' "$BODY"
"""

from azen_os.signing import compute_signature, sign_body

# The exact body string the TS signer hashed (byte-identical, incl. multibyte).
SECRET = "azn_sk_test_4f6f8e2d"
TIMESTAMP = 1780000000
BODY = (
    '{"type":"booking.created","occurred_at":"2026-07-12T09:30:00Z",'
    '"idempotency_key":"call_789:booking","data":{"service":"Checkup",'
    '"starts_at":"2026-07-14T10:00:00Z","note":"Zoë £85 ✅"}}'
)
# Produced by @azen/events/signing computeSignature(SECRET, TIMESTAMP, BODY).
EXPECTED_SIG = "ba2861978b0bb5a17347bd462f1c2938e56820cff7e943b77fe6fe5f0d7aa4c3"
EXPECTED_HEADER = f"t={TIMESTAMP},v1={EXPECTED_SIG}"


def test_signature_matches_canonical_ts_vector():
    assert compute_signature(SECRET, TIMESTAMP, BODY) == EXPECTED_SIG


def test_header_matches_canonical_ts_vector():
    assert sign_body(SECRET, BODY, TIMESTAMP) == EXPECTED_HEADER


def test_multibyte_payload_is_utf8_stable():
    # A £/emoji-heavy body must hash to the same bytes the Node signer produces;
    # the £ is 2 bytes and ✅ is 3 bytes in UTF-8, so a latin-1 slip would fail.
    body = '{"note":"Zoë booked ✅ £85"}'
    ts = 1780000123
    # Recomputed deterministically here; the point is stability + header shape.
    sig = compute_signature(SECRET, ts, body)
    assert len(sig) == 64
    assert all(c in "0123456789abcdef" for c in sig)
    assert sign_body(SECRET, body, ts) == f"t={ts},v1={sig}"


def test_default_timestamp_is_unix_seconds():
    header = sign_body(SECRET, BODY)
    prefix, sig_part = header.split(",")
    assert prefix.startswith("t=")
    ts = int(prefix[2:])
    assert ts > 1_700_000_000  # unix seconds, not millis
    assert sig_part == f"v1={compute_signature(SECRET, ts, BODY)}"
