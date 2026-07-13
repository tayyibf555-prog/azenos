"""AzenOS client tests — never-raises + retry/backoff (§P6-SDK-PY).

A fake transport records requests and returns scripted responses, so there is no
network and no ``requests`` dependency at test time. We assert: a 2xx returns a
success result; a 5xx/429 is retried up to max_retries; a 4xx is NOT retried; a
raising transport is swallowed into a failure result (never propagates); the
idempotency key is stable across retries; and the signature header is attached.
"""

import json

from azen_os import AzenOS, Response, TrackFailure, TrackSuccess


class FakeTransport:
    def __init__(self, responses):
        self._responses = list(responses)
        self.calls = []

    def __call__(self, url, headers, body, timeout):
        self.calls.append({"url": url, "headers": headers, "body": body})
        nxt = self._responses.pop(0)
        if isinstance(nxt, Exception):
            raise nxt
        return nxt


def make_client(responses, **kw):
    t = FakeTransport(responses)
    client = AzenOS(
        "azn_pk_test",
        "azn_sk_test",
        base_url="https://example.test/",
        transport=t,
        backoff_base_s=0.0,  # no real waiting in tests
        **kw,
    )
    return client, t


def ok(accepted=1, duplicates=0):
    return Response(200, {"accepted": accepted, "duplicates": duplicates})


def test_track_success_returns_result_object():
    client, t = make_client([ok(accepted=1)])
    res = client.track("booking.created", data={"service": "Checkup"})
    assert isinstance(res, TrackSuccess)
    assert res.ok is True
    assert res.accepted == 1
    assert len(t.calls) == 1
    # signed by default (hmac)
    assert "x-azen-signature" in t.calls[0]["headers"]
    # the wire body is the event envelope
    sent = json.loads(t.calls[0]["body"])
    assert sent["type"] == "booking.created"
    assert sent["data"] == {"service": "Checkup"}
    assert "idempotency_key" in sent


def test_retries_on_5xx_then_succeeds():
    client, t = make_client([Response(500, {"error": "boom"}), ok()], max_retries=3)
    res = client.track("custom.metric", data={"key": "x", "value": 1})
    assert isinstance(res, TrackSuccess)
    assert len(t.calls) == 2  # one retry


def test_retries_on_429_then_succeeds():
    client, t = make_client(
        [Response(429, {"error": "rate"}, {"retry-after": "0"}), ok()], max_retries=3
    )
    res = client.track("custom.metric", data={"key": "x", "value": 1})
    assert isinstance(res, TrackSuccess)
    assert len(t.calls) == 2


def test_does_not_retry_on_4xx():
    client, t = make_client([Response(400, {"error": "bad_request"})], max_retries=3)
    res = client.track("booking.created")
    assert isinstance(res, TrackFailure)
    assert res.ok is False
    assert res.status == 400
    assert res.error == "bad_request"
    assert len(t.calls) == 1  # no retry on a client error


def test_exhausts_retries_and_returns_failure_never_raises():
    client, t = make_client([Response(503, {}), Response(503, {}), Response(503, {})], max_retries=2)
    res = client.track("booking.created")
    assert isinstance(res, TrackFailure)
    assert res.status == 503
    assert len(t.calls) == 3  # initial + 2 retries


def test_raising_transport_is_swallowed():
    calls = {"n": 0}

    def on_error(failure):
        calls["n"] += 1

    client, t = make_client([RuntimeError("network down")], max_retries=0, on_error=on_error)
    res = client.track("booking.created")
    assert isinstance(res, TrackFailure)
    assert "network down" in res.error
    assert calls["n"] == 1  # on_error fired once


def test_idempotency_key_stable_across_retries():
    client, t = make_client([Response(500, {}), ok()], max_retries=3)
    client.track("booking.created", idempotency_key="fixed-key-123")
    keys = [json.loads(c["body"])["idempotency_key"] for c in t.calls]
    assert keys == ["fixed-key-123", "fixed-key-123"]


def test_token_auth_mode_sends_token_header():
    client, t = make_client([ok()], auth_mode="token")
    client.track("booking.created")
    assert t.calls[0]["headers"].get("x-azen-token") == "azn_sk_test"
    assert "x-azen-signature" not in t.calls[0]["headers"]


def test_conversation_heartbeat_metric_helpers():
    client, t = make_client([ok(), ok(), ok()])
    client.conversation(channel="webchat", resolution="resolved", intent="booking")
    client.heartbeat(agent_id="a1", status="ok")
    client.metric("leads_today", 12)
    types = [json.loads(c["body"])["type"] for c in t.calls]
    assert types == ["llm.conversation", "agent.heartbeat", "custom.metric"]
    conv = json.loads(t.calls[0]["body"])["data"]
    assert conv["channel"] == "webchat"
    assert conv["resolution"] == "resolved"
    metric = json.loads(t.calls[2]["body"])["data"]
    assert metric == {"key": "leads_today", "value": 12}
