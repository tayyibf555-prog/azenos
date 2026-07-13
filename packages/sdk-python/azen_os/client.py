"""Fire-and-forget Azen OS event client — spec §6.2.

Mirrors ``@azen/os-sdk`` (the Node SDK) semantics: every method resolves to a
result object and **never raises**; requests are retried with exponential
backoff + jitter; HMAC signing is byte-identical to ``@azen/events/signing`` (via
:mod:`azen_os.signing`, cross-checked in ``tests/test_signing.py``).

Transport is injectable so the client can be unit-tested with no network and so a
runtime without ``requests`` still fails gracefully (returning a failure result)
instead of raising. The default transport lazily imports ``requests`` (declared
in ``pyproject.toml``).
"""

from __future__ import annotations

import json
import random
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable, Optional, Union

from .signing import SIGNATURE_HEADER, TOKEN_HEADER, sign_body

DEFAULT_BASE_URL = "https://os.azen.ai"
USER_AGENT = "azen-os-sdk-python/0.1.0"
DEFAULT_BACKOFF_BASE_S = 0.25
MAX_BATCH_SIZE = 100


# ── result objects (mirror the Node TrackResult union) ────────────────────────
@dataclass
class TrackSuccess:
    accepted: int
    duplicates: int
    ok: bool = True


@dataclass
class TrackFailure:
    error: str
    status: Optional[int] = None
    ok: bool = False


TrackResult = Union[TrackSuccess, TrackFailure]


# ── injectable transport ──────────────────────────────────────────────────────
@dataclass
class Response:
    """Minimal HTTP response the client understands (transport-agnostic)."""

    status_code: int
    json_body: Any = None
    headers: Optional[dict] = None


Transport = Callable[[str, dict, str, float], Response]


class Timeout(Exception):
    """Raised by a transport to signal a per-attempt timeout (mapped, not leaked)."""


def _requests_transport(url: str, headers: dict, body: str, timeout: float) -> Response:
    import requests  # lazily imported so the dep only bites the HTTP path

    try:
        resp = requests.post(
            url, data=body.encode("utf-8"), headers=headers, timeout=timeout
        )
    except requests.Timeout as exc:  # normalise to the SDK's Timeout
        raise Timeout(str(exc)) from exc
    try:
        parsed = resp.json()
    except ValueError:
        parsed = None
    return Response(resp.status_code, parsed, dict(resp.headers))


class AzenOS:
    """Fire-and-forget event client. Every public method returns a result object
    and never raises."""

    def __init__(
        self,
        key: str,
        secret: str,
        *,
        base_url: str = DEFAULT_BASE_URL,
        auth_mode: str = "hmac",
        max_retries: int = 3,
        timeout: float = 5.0,
        transport: Optional[Transport] = None,
        on_error: Optional[Callable[[TrackFailure], None]] = None,
        backoff_base_s: float = DEFAULT_BACKOFF_BASE_S,
    ) -> None:
        self._url = f"{base_url.rstrip('/')}/api/ingest/{key}"
        self._secret = secret
        self._auth_mode = auth_mode
        self._max_retries = max(0, int(max_retries))
        self._timeout = timeout
        self._transport: Transport = transport or _requests_transport
        self._on_error = on_error
        self._backoff_base_s = backoff_base_s

    # ── public API ────────────────────────────────────────────────────────────
    def track(
        self,
        type: str,
        *,
        data: Optional[dict] = None,
        subject: Optional[dict] = None,
        actor: Optional[dict] = None,
        occurred_at: Union[datetime, str, None] = None,
        idempotency_key: Optional[str] = None,
        value_pence: Optional[int] = None,
        minutes_saved: Optional[float] = None,
        currency: Optional[str] = None,
    ) -> TrackResult:
        try:
            event = self._build_event(
                type,
                data=data,
                subject=subject,
                actor=actor,
                occurred_at=occurred_at,
                idempotency_key=idempotency_key,
                value_pence=value_pence,
                minutes_saved=minutes_saved,
                currency=currency,
            )
            return self._post(json.dumps(event, separators=(",", ":")))
        except Exception as exc:  # pragma: no cover - defensive; never raises
            return self._fail(TrackFailure(error=_message(exc)))

    def track_batch(self, events: list) -> TrackResult:
        """Single POST with a JSON-array body, hard-capped at 100 events."""
        try:
            if len(events) > MAX_BATCH_SIZE:
                return self._fail(
                    TrackFailure(
                        error=f"batch_too_large: {len(events)} events (max {MAX_BATCH_SIZE})"
                    )
                )
            if not events:
                return TrackSuccess(accepted=0, duplicates=0)
            wire = []
            for ev in events:
                ev = dict(ev)
                etype = ev.pop("type")
                wire.append(self._build_event(etype, **ev))
            return self._post(json.dumps(wire, separators=(",", ":")))
        except Exception as exc:  # pragma: no cover - defensive
            return self._fail(TrackFailure(error=_message(exc)))

    def conversation(
        self,
        *,
        channel: str,
        resolution: str,
        conversation_id: Optional[str] = None,
        turns: Optional[int] = None,
        duration_seconds: Optional[float] = None,
        intent: Optional[str] = None,
        summary: Optional[str] = None,
        topics: Optional[list] = None,
        sentiment: Optional[str] = None,
        transcript_ref: Optional[str] = None,
        **envelope: Any,
    ) -> TrackResult:
        """Sugar for ``llm.conversation`` events."""
        return self.track(
            "llm.conversation",
            data=_compact(
                {
                    "conversation_id": conversation_id,
                    "channel": channel,
                    "turns": turns,
                    "duration_seconds": duration_seconds,
                    "intent": intent,
                    "resolution": resolution,
                    "summary": summary,
                    "topics": topics,
                    "sentiment": sentiment,
                    "transcript_ref": transcript_ref,
                }
            ),
            **envelope,
        )

    def heartbeat(
        self,
        *,
        agent_id: str,
        name: Optional[str] = None,
        version: Optional[str] = None,
        purpose: Optional[str] = None,
        status: Optional[str] = None,
        **envelope: Any,
    ) -> TrackResult:
        """Sugar for ``agent.heartbeat`` events."""
        return self.track(
            "agent.heartbeat",
            data=_compact(
                {
                    "agent_id": agent_id,
                    "name": name,
                    "version": version,
                    "purpose": purpose,
                    "status": status,
                }
            ),
            **envelope,
        )

    def metric(self, key: str, value: float, **envelope: Any) -> TrackResult:
        """Sugar for arbitrary gauges: ``custom.metric`` with data ``{key, value}``."""
        return self.track("custom.metric", data={"key": key, "value": value}, **envelope)

    # ── internals ─────────────────────────────────────────────────────────────
    def _build_event(
        self,
        type: str,
        *,
        data: Optional[dict] = None,
        subject: Optional[dict] = None,
        actor: Optional[dict] = None,
        occurred_at: Union[datetime, str, None] = None,
        idempotency_key: Optional[str] = None,
        value_pence: Optional[int] = None,
        minutes_saved: Optional[float] = None,
        currency: Optional[str] = None,
    ) -> dict:
        return _compact(
            {
                "type": type,
                "occurred_at": _to_iso(occurred_at),
                # Generated once per call (never per attempt) so the server's
                # idempotency dedup collapses retries into one stored event.
                "idempotency_key": idempotency_key or uuid.uuid4().hex,
                "actor": actor,
                "subject": subject,
                "data": data or {},
                "value_pence": value_pence,
                "currency": currency,
                "minutes_saved": minutes_saved,
            }
        )

    def _post(self, raw_body: str) -> TrackResult:
        failure = TrackFailure(error="no attempt made")
        retry_after_s: Optional[float] = None

        for attempt in range(self._max_retries + 1):
            if attempt > 0:
                base = self._backoff_base_s * (2 ** (attempt - 1))
                time.sleep(retry_after_s if retry_after_s is not None else base + random.random() * base)
            retry_after_s = None

            try:
                resp = self._transport(
                    self._url, self._headers_for(raw_body), raw_body, self._timeout
                )
            except Timeout:
                failure = TrackFailure(error=f"timed out after {self._timeout}s")
                continue
            except Exception as exc:
                failure = TrackFailure(error=_message(exc))
                continue

            if 200 <= resp.status_code < 300:
                return _parse_success(resp)

            failure = TrackFailure(
                status=resp.status_code, error=_error_from(resp)
            )
            if resp.status_code != 429 and resp.status_code < 500:
                return self._fail(failure)
            if resp.status_code == 429:
                retry_after_s = _retry_after_s(resp)

        return self._fail(failure)

    def _headers_for(self, raw_body: str) -> dict:
        headers = {
            "content-type": "application/json",
            "user-agent": USER_AGENT,
        }
        if self._auth_mode == "token":
            headers[TOKEN_HEADER] = self._secret
        else:
            # Signed per attempt so a long retry tail never pushes the timestamp
            # outside the server's ±300s replay window.
            headers[SIGNATURE_HEADER] = sign_body(self._secret, raw_body)
        return headers

    def _fail(self, failure: TrackFailure) -> TrackFailure:
        if self._on_error is not None:
            try:
                self._on_error(failure)
            except Exception:
                # track() never raises — a throwing callback must not escape.
                pass
        return failure


# ── helpers ───────────────────────────────────────────────────────────────────
def _compact(d: dict) -> dict:
    """Drop None-valued keys (the wire omits absent envelope fields)."""
    return {k: v for k, v in d.items() if v is not None}


def _to_iso(value: Union[datetime, str, None]) -> str:
    if value is None:
        return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    return value


def _parse_success(resp: Response) -> TrackSuccess:
    body = resp.json_body if isinstance(resp.json_body, dict) else {}
    return TrackSuccess(
        accepted=_number(body.get("accepted")),
        duplicates=_number(body.get("duplicates")),
    )


def _number(v: Any) -> int:
    return int(v) if isinstance(v, (int, float)) else 0


def _error_from(resp: Response) -> str:
    body = resp.json_body
    if isinstance(body, dict):
        err = body.get("error")
        if isinstance(err, str) and err:
            return err
    return f"HTTP {resp.status_code}"


def _retry_after_s(resp: Response) -> Optional[float]:
    header = (resp.headers or {}).get("retry-after") or (resp.headers or {}).get(
        "Retry-After"
    )
    if header is None:
        return None
    try:
        seconds = float(header)
    except (TypeError, ValueError):
        return None
    return seconds if seconds >= 0 else None


def _message(exc: Exception) -> str:
    return str(exc) or exc.__class__.__name__
