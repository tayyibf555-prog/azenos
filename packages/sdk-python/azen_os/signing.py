"""HMAC request signing — spec §6.2.

    X-Azen-Signature: t=<unix_seconds>,v1=HMAC-SHA256(secret, f"{t}.{rawBody}")

Deliberately re-implements ``@azen/events/signing`` (TypeScript) so this SDK
stays a thin, pure-stdlib module. ``tests/test_signing.py`` pins a vector
produced by the canonical TS signer and asserts a byte-for-byte match, so the
two implementations can never drift across languages.

The signed string is ``f"{timestamp}.{raw_body}"`` encoded as UTF-8; the secret
is UTF-8 too. Multi-byte payloads (£, emoji, accents) therefore hash to the
same bytes the Node signer produces.
"""

from __future__ import annotations

import hashlib
import hmac
import time

SIGNATURE_HEADER = "x-azen-signature"
TOKEN_HEADER = "x-azen-token"
SIGNING_VERSION = "v1"
DEFAULT_TOLERANCE_S = 300


def compute_signature(secret: str, timestamp: int, raw_body: str) -> str:
    """Return the lowercase hex HMAC-SHA256 of ``f"{timestamp}.{raw_body}"``."""
    message = f"{timestamp}.{raw_body}".encode("utf-8")
    return hmac.new(secret.encode("utf-8"), message, hashlib.sha256).hexdigest()


def sign_body(secret: str, raw_body: str, timestamp: int | None = None) -> str:
    """Full header value for a request: ``t=<ts>,v1=<hex>``.

    ``timestamp`` defaults to the current unix time in **seconds** (matching the
    Node SDK), so a fresh signature is produced per attempt.
    """
    if timestamp is None:
        timestamp = int(time.time())
    return f"t={timestamp},{SIGNING_VERSION}={compute_signature(secret, timestamp, raw_body)}"
