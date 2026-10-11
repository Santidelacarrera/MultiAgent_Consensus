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

from .helpers import REQUEST, fragment, make_client, rag_body, run


def ok(request: httpx.Request) -> httpx.Response:
    return httpx.Response(200, json=rag_body())


def test_default_route_is_api_v1_retrieve_with_exact_contract() -> None:
    seen: list[httpx.Request] = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append(req)
        if (req.method, req.url.path) != ("POST", "/api/v1/retrieve"):
            return httpx.Response(404)  # cualquier otra ruta/método falla ruidosamente
        return httpx.Response(200, json=rag_body())

    client, _ = make_client(handler, api_key="s3cret")
    resp = run(client.retrieve(RetrievalRequest("acme", "plazo de devolución", top_k=7)))
    req = seen[0]
    assert str(req.url) == "https://rag.internal/api/v1/retrieve" and req.method == "POST"
    # el servicio usa extra="forbid": el cuerpo contiene EXACTAMENTE estos tres campos
    assert json.loads(req.content) == {"tenant_id": "acme", "query": "plazo de devolución", "top_k": 7}
    # autenticación y tenant por cabecera, como exige ContextRAG_Engine
    assert req.headers["x-api-key"] == "s3cret" and req.headers["x-tenant"] == "acme"
    assert "authorization" not in req.headers
    assert resp.tenant_id == "acme" and resp.status == "ok" and not resp.synthesized_abstention


def test_fragments_are_mapped_to_chunks_stamped_with_the_response_tenant() -> None:
    frs = [fragment(1, "Texto uno.", "a.md", 0.9), fragment(2, "Texto dos.", "b.md", 0.5)]
    client, _ = make_client(lambda r: httpx.Response(200, json=rag_body(fragments=frs)))
    resp = run(client.retrieve(REQUEST))
    assert [c.id for c in resp.chunks] == ["a.md:1", "b.md:2"]
    assert all(c.tenant_id == "acme" and c.metadata["tenant_source"] == "response" for c in resp.chunks)
    assert resp.chunks[1].metadata["index"] == 2 and resp.chunks[1].score == 0.5 and resp.chunks[0].source == "a.md"


def test_null_draft_becomes_an_explicit_abstention() -> None:
    client, _ = make_client(lambda r: httpx.Response(200, json=rag_body(draft=None, fragments=[])))
    resp = run(client.retrieve(REQUEST))
    assert resp.status == "no_results" and resp.synthesized_abstention and resp.draft_answer.startswith("No se encontró")


def test_custom_api_key_header_is_supported() -> None:
    seen: list[httpx.Request] = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append(req)
        return httpx.Response(200, json=rag_body())

    client, _ = make_client(handler, api_key="k", api_key_header="X-Custom-Key")
    run(client.retrieve(REQUEST))
    assert seen[0].headers["x-custom-key"] == "k" and "x-api-key" not in seen[0].headers


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
        httpx.Response(200, json={"fragments": []}),  # sin status/tenant
        httpx.Response(200, json={**rag_body(), "status": "raro"}),
        httpx.Response(200, json={k: v for k, v in rag_body().items() if k != "tenant_id"}),  # sin tenant: no verificable
        httpx.Response(200, json={**rag_body(), "tenant_id": ""}),
        httpx.Response(200, json={**rag_body(), "draft_answer": 5}),
        httpx.Response(200, json={**rag_body(), "fragments": "x"}),
        httpx.Response(200, json={**rag_body(), "fragments": ["no-objeto"]}),
        httpx.Response(200, json=rag_body(fragments=[{**fragment(), "score": "alto"}])),
        httpx.Response(200, json=rag_body(fragments=[{**fragment(), "score": True}])),
        httpx.Response(200, content=json.dumps(rag_body(fragments=[{**fragment(), "score": float("nan")}]), allow_nan=True).encode()),  # NaN literal
        httpx.Response(200, json=rag_body(fragments=[{**fragment(), "index": 0}])),
        httpx.Response(200, json=rag_body(fragments=[{**fragment(), "index": "1"}])),
        httpx.Response(200, json=rag_body(fragments=[{**fragment(), "doc_id": ""}])),
        httpx.Response(200, json=rag_body(fragments=[{**fragment(), "text": None}])),
        httpx.Response(200, json=rag_body(fragments=[{**fragment(), "source": 3}])),
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
        {"base_url": "https://rag.internal", "retrieve_path": "api/v1/retrieve"},
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
        {"tenant_id": "acme", "query": "x", "top_k": 21},  # el servicio admite como máximo 20
    ],
)
def test_request_validation(kwargs: dict[str, object]) -> None:
    with pytest.raises(ValueError):
        RetrievalRequest(**kwargs)  # type: ignore[arg-type]


def test_engine_request_id_is_captured_and_sanitized() -> None:
    good, _ = make_client(lambda r: httpx.Response(200, json=rag_body(), headers={"X-Request-Id": "7f9c2c8e-1b1e-4c52-9a53-0f6f3f1d2a11"}))
    assert run(good.retrieve(REQUEST)).engine_request_id == "7f9c2c8e-1b1e-4c52-9a53-0f6f3f1d2a11"
    hostile, _ = make_client(lambda r: httpx.Response(200, json=rag_body(), headers={"X-Request-Id": "x" * 200}))
    assert run(hostile.retrieve(REQUEST)).engine_request_id is None  # demasiado largo ⇒ se ignora
    none, _ = make_client(lambda r: httpx.Response(200, json=rag_body()))
    assert run(none.retrieve(REQUEST)).engine_request_id is None


def test_http_errors_carry_engine_request_id_and_safe_error_code_only() -> None:
    body = {"error": "database_unavailable", "request_id": "r-1", "detail": "stack trace con datos sensibles"}
    client, _ = make_client(lambda r: httpx.Response(503, json=body, headers={"X-Request-Id": "r-1"}), max_retries=0)
    with pytest.raises(RagHttpError) as ei:
        run(client.retrieve(REQUEST))
    assert (ei.value.status_code, ei.value.engine_request_id, ei.value.engine_error) == (503, "r-1", "database_unavailable")
    assert "sensibles" not in str(ei.value)
    odd, _ = make_client(lambda r: httpx.Response(403, json={"error": "<script>alert(1)</script>"}), max_retries=0)
    with pytest.raises(RagHttpError) as e2:
        run(odd.retrieve(REQUEST))
    assert e2.value.engine_error is None  # un "código" que no es un identificador seguro se descarta
