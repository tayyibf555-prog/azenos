"""Azen OS Python SDK — fire-and-forget event tracking (spec §6.2).

Mirrors ``@azen/os-sdk`` (the Node SDK): a tiny HMAC-signing client whose methods
never raise and retry with backoff. See :class:`azen_os.AzenOS`.
"""

from .client import (
    AzenOS,
    Response,
    Timeout,
    TrackFailure,
    TrackResult,
    TrackSuccess,
    Transport,
)
from .signing import compute_signature, sign_body

__all__ = [
    "AzenOS",
    "TrackSuccess",
    "TrackFailure",
    "TrackResult",
    "Transport",
    "Response",
    "Timeout",
    "sign_body",
    "compute_signature",
]

__version__ = "0.1.0"
