from __future__ import annotations

import json

import httpx
import pytest

from rag_consensus import (
    ConfigurationError,
    RagClientConfig,
    RagConnectionError,
    RagHttpError,
    RagProtocolError,
    RagTimeoutError,
    RetrievalRequest,
)

from .helpers import REQUEST, make_client, rag_body, run


def ok(request: httpx.Request) -> httpx.Response:
    return httpx.Response(200, json=rag_body())


def test_sends_tenant_query_and_params_and_parses_response() -> None:
    seen: dict[str, object] = {}

    def handler(req: httpx.Request) -> httpx.Response:
        seen["url"] = str(req.url)
        seen["body"] = json.loads(req.content)
        seen["auth"] = req.headers.get("authorization")
        return httpx.Response(200, json=rag_body())

    client, _ = make_client(handler, api_key="s3cret", retrieve_path="/api/retrieve")
    req = RetrievalRequest("acme", "plazo de devolución", top_k=7, filters={"lang": "es", "year": 2026}, min_score=0.4)
    resp = run(client.retrieve(req))
    assert seen["url"] == "https://rag.internal/api/retrieve"
    assert seen["body"] == {"tenant_id": "acme", "query": "plazo de devolución", "top_k": 7, "filters": {"lang": "es", "year": 2026}, "min_score": 0.4}
    assert seen["auth"] == "Bearer s3cret"
    assert resp.tenant_id == "acme" and resp.chunks[0].id == "c1" and resp.chunks[0].tenant_id == "acme"
    assert "30 días" in resp.draft_answer


def test_accepts_documented_aliases() -> None:
    body = {"answer": "x", "chunks": [{"chunk_id": "k", "content": "t", "score": 1}]}
    client, _ = make_client(lambda r: httpx.Response(200, json=body))
    resp = run(client.retrieve(REQUEST))
    assert resp.draft_answer == "x" and resp.chunks[0].id == "k" and resp.chunks[0].tenant_id is None


def test_retries_transient_http_then_succeeds_with_exponential_backoff() -> None:
    calls = {"n": 0}

    def handler(req: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(503) if calls["n"] < 3 else httpx.Response(200, json=rag_body())

    client, sleeps = make_client(handler, max_retries=2, backoff_s=0.5)
    run(client.retrieve(REQUEST))
    assert calls["n"] == 3 and sleeps == [0.5, 1.0]


def test_honors_retry_after_capped() -> None:
    calls = {"n": 0}

    def handler(req: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(429, headers={"retry-after": "9999"}) if calls["n"] == 1 else httpx.Response(200, json=rag_body())

    client, sleeps = make_client(handler)
    run(client.retrieve(REQUEST))
    assert sleeps == [5.0]


def test_retries_exhausted_raises_http_error_without_leaking_body() -> None:
    client, _ = make_client(lambda r: httpx.Response(502, text="internal secret trace"), max_retries=1)
    with pytest.raises(RagHttpError) as ei:
        run(client.retrieve(REQUEST))
    assert ei.value.status_code == 502 and "secret" not in str(ei.value)


def test_client_errors_are_not_retried() -> None:
    calls = {"n": 0}

    def handler(req: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(403, text="forbidden")

    client, _ = make_client(handler, max_retries=3)
    with pytest.raises(RagHttpError) as ei:
        run(client.retrieve(REQUEST))
    assert ei.value.status_code == 403 and calls["n"] == 1


def test_timeout_after_retries() -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("slow", request=req)

    client, sleeps = make_client(handler, max_retries=2)
    with pytest.raises(RagTimeoutError):
        run(client.retrieve(REQUEST))
    assert len(sleeps) == 2


def test_connection_error_after_retries() -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=req)

    client, _ = make_client(handler, max_retries=1)
    with pytest.raises(RagConnectionError):
        run(client.retrieve(REQUEST))


def test_transient_failure_then_recovery() -> None:
    calls = {"n": 0}

    def handler(req: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] == 1:
            raise httpx.ConnectError("reset", request=req)
        return httpx.Response(200, json=rag_body())

    client, _ = make_client(handler)
    assert run(client.retrieve(REQUEST)).chunks


@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(200, text="<html>no es json</html>"),
        httpx.Response(200, json=["lista"]),
        httpx.Response(200, json={"chunks": []}),
        httpx.Response(200, json={"draft_answer": 5, "chunks": []}),
        httpx.Response(200, json={"draft_answer": "x"}),
        httpx.Response(200, json={"draft_answer": "x", "chunks": [{"id": "a", "text": "t", "score": "alto"}]}),
        httpx.Response(200, json={"draft_answer": "x", "chunks": [{"id": "a", "text": "t", "score": True}]}),
        httpx.Response(200, json={"draft_answer": "x", "chunks": [{"id": "", "text": "t", "score": 1}]}),
        httpx.Response(200, json={"draft_answer": "x", "chunks": [{"id": "a", "text": "t", "score": 1, "tenant_id": 7}]}),
        httpx.Response(200, json={"draft_answer": "x", "chunks": [{"id": "a", "text": "t", "score": 1, "metadata": []}]}),
        httpx.Response(200, json={"draft_answer": "x", "chunks": ["no-objeto"]}),
        httpx.Response(200, json={"draft_answer": "x", "chunks": [], "tenant_id": 3}),
    ],
)
def test_protocol_violations_are_rejected(response: httpx.Response) -> None:
    client, _ = make_client(lambda r: response)
    with pytest.raises(RagProtocolError):
        run(client.retrieve(REQUEST))


def test_oversized_response_is_rejected() -> None:
    client, _ = make_client(ok, max_response_bytes=50)
    with pytest.raises(RagProtocolError):
        run(client.retrieve(REQUEST))


def test_redirects_are_not_followed() -> None:
    client, _ = make_client(lambda r: httpx.Response(302, headers={"location": "https://evil.example"}))
    with pytest.raises(RagHttpError) as ei:
        run(client.retrieve(REQUEST))
    assert ei.value.status_code == 302


def test_api_key_never_appears_in_repr() -> None:
    cfg = RagClientConfig(base_url="https://rag.internal", api_key="topsecret")
    assert "topsecret" not in repr(cfg) and "topsecret" not in str(cfg)


@pytest.mark.parametrize(
    "kwargs",
    [
        {"base_url": "http://rag.internal"},  # HTTP en red
        {"base_url": "ftp://rag"},
        {"base_url": "https://user:pw@rag.internal"},
        {"base_url": "https://rag.internal", "retrieve_path": "v1/retrieve"},
        {"base_url": "https://rag.internal", "timeout_s": 0},
        {"base_url": "https://rag.internal", "max_retries": 9},
        {"base_url": "https://rag.internal", "verify_tls": False},
        {"base_url": ""},
    ],
)
def test_insecure_or_invalid_configuration_is_rejected(kwargs: dict[str, object]) -> None:
    with pytest.raises(ConfigurationError):
        RagClientConfig(**kwargs)  # type: ignore[arg-type]


def test_http_is_allowed_on_loopback_and_when_explicit() -> None:
    RagClientConfig(base_url="http://localhost:8080")
    RagClientConfig(base_url="http://127.0.0.1:8080")
    RagClientConfig(base_url="http://rag.svc.cluster.local", allow_insecure_http=True)


@pytest.mark.parametrize(
    "kwargs",
    [
        {"tenant_id": "", "query": "x"},
        {"tenant_id": "../etc", "query": "x"},
        {"tenant_id": "a b", "query": "x"},
        {"tenant_id": "acme", "query": "   "},
        {"tenant_id": "acme", "query": "x" * 5000},
        {"tenant_id": "acme", "query": "x", "top_k": 0},
        {"tenant_id": "acme", "query": "x", "top_k": 51},
        {"tenant_id": "acme", "query": "x", "min_score": 1.5},
        {"tenant_id": "acme", "query": "x", "min_score": float("nan")},
    ],
)
def test_request_validation(kwargs: dict[str, object]) -> None:
    with pytest.raises(ValueError):
        RetrievalRequest(**kwargs)  # type: ignore[arg-type]
