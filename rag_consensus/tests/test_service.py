from __future__ import annotations

import hashlib
import importlib
import json
import sys
import time
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import Any, Protocol

import httpx
import pytest
from fastapi.testclient import TestClient

from rag_consensus import InMemoryAuditSink, Verdict
from rag_consensus.service import guard
from rag_consensus.service.app import create_app
from rag_consensus.service.settings import ServiceSettings
from rag_consensus.service.stores import MemoryStore

from .helpers import POLICY_TEXT, TENANT, fragment, rag_body

KEY = b"k" * 40
TOKEN = "t" * 32


def make_settings(**over: Any) -> ServiceSettings:
    base: dict[str, Any] = dict(
        guard_signing_key=KEY, contextrag_url="http://rag.test", tenant_rag_keys={"acme": "key-acme", "globex": "key-globex"},
        contextrag_allow_insecure_http=True, service_token=TOKEN,
    )
    base.update(over)
    return ServiceSettings(**base)


class Rag:
    """RAG simulado por transporte HTTP; registra lo que recibe."""

    def __init__(self, handler: Callable[[httpx.Request], httpx.Response] | None = None) -> None:
        self.calls: list[httpx.Request] = []
        self._handler = handler

    def __call__(self, req: httpx.Request) -> httpx.Response:
        self.calls.append(req)
        if self._handler:
            return self._handler(req)
        tenant = json.loads(req.content)["tenant_id"]
        return httpx.Response(200, json=rag_body(tenant=tenant), headers={"X-Request-Id": "engine-req-1"})


def build(rag: Rag | None = None, **settings_over: Any) -> tuple[TestClient, Rag, InMemoryAuditSink, MemoryStore]:
    rag = rag or Rag()
    sink, store = InMemoryAuditSink(), MemoryStore()
    app = create_app(make_settings(**settings_over), store=store, replay=store, audit=sink, transport=httpx.MockTransport(rag))
    return TestClient(app), rag, sink, store


class Resp(Protocol):
    """Lo que las pruebas usan de una respuesta (el TestClient puede devolver httpx o httpx2 según la versión)."""

    @property
    def status_code(self) -> int: ...

    @property
    def text(self) -> str: ...

    def json(self) -> Any: ...


def signed(client: TestClient, method: str, path: str, body: dict[str, Any] | None = None, *, tenant: str = "acme",
           rid: str | None = None, ts: int | None = None, key: bytes = KEY, raw: bytes | None = None) -> Resp:
    payload = raw if raw is not None else (json.dumps(body).encode() if body is not None else b"")
    rid = rid or uuid.uuid4().hex
    stamp = str(ts if ts is not None else int(time.time()))
    headers = {"x-tenant-id": tenant, "x-request-id": rid, "x-guard-timestamp": stamp,
               "x-guard-signature": guard.sign(key, tenant, rid, stamp, method, path, payload), "content-type": "application/json"}
    resp: Resp = client.request(method, path, content=payload, headers=headers)
    return resp


# ------------------------------------------------------------------ firma del guard

def test_verify_accepts_a_valid_signature_and_rejects_every_tampering() -> None:
    body, rid, ts = b'{"a":1}', "r-1", str(int(time.time()))
    sig = guard.sign(KEY, "acme", rid, ts, "POST", "/v1/rag/query", body)
    h = {"X-Tenant-Id": "acme", "X-Request-Id": rid, "X-Guard-Timestamp": ts, "X-Guard-Signature": sig}
    ok = guard.verify(h, "POST", "/v1/rag/query", body, KEY)
    assert ok is not None and ok.tenant == "acme" and ok.request_id == rid
    assert guard.verify(h, "POST", "/v1/rag/query", b'{"a":2}', KEY) is None  # cuerpo alterado
    assert guard.verify(h, "POST", "/v1/other", body, KEY) is None  # ruta distinta
    assert guard.verify(h, "GET", "/v1/rag/query", body, KEY) is None  # método distinto
    assert guard.verify({**h, "X-Tenant-Id": "globex"}, "POST", "/v1/rag/query", body, KEY) is None  # tenant alterado
    assert guard.verify(h, "POST", "/v1/rag/query", body, b"x" * 40) is None  # otra clave
    assert guard.verify({**h, "X-Guard-Signature": "v1=" + "0" * 64}, "POST", "/v1/rag/query", body, KEY) is None
    assert guard.verify({**h, "X-Guard-Signature": sig[3:]}, "POST", "/v1/rag/query", body, KEY) is None  # sin prefijo
    for missing in ("X-Tenant-Id", "X-Request-Id", "X-Guard-Timestamp", "X-Guard-Signature"):
        assert guard.verify({k: v for k, v in h.items() if k != missing}, "POST", "/v1/rag/query", body, KEY) is None


@pytest.mark.parametrize("offset", [-61, 61, 10_000])
def test_verify_enforces_the_clock_window(offset: int) -> None:
    ts = str(int(time.time()) + offset)
    rid = "r-2"
    h = {"x-tenant-id": "acme", "x-request-id": rid, "x-guard-timestamp": ts, "x-guard-signature": guard.sign(KEY, "acme", rid, ts, "POST", "/p", b"")}
    assert guard.verify(h, "POST", "/p", b"", KEY) is None
    assert guard.verify(h, "POST", "/p", b"", KEY, max_skew_seconds=100_000) is not None
    assert guard.verify({**h, "x-guard-timestamp": "abc"}, "POST", "/p", b"", KEY) is None


def test_verify_rejects_malformed_tenant_even_if_correctly_signed() -> None:
    ts, rid = str(int(time.time())), "r-3"
    for tenant in ("../etc", "a b", "x" * 200):
        h = {"x-tenant-id": tenant, "x-request-id": rid, "x-guard-timestamp": ts, "x-guard-signature": guard.sign(KEY, tenant, rid, ts, "POST", "/p", b"")}
        assert guard.verify(h, "POST", "/p", b"", KEY) is None


def _edge_gateway_signing() -> Any:
    for cand in (Path("/home/user/santidelacarrera/shadowapi_guard/edge-gateway/src"), Path(__file__).parents[3].parent / "ShadowAPI_Guard/edge-gateway/src"):
        if (cand / "edge_gateway" / "signing.py").exists():
            sys.path.insert(0, str(cand))
            try:
                return importlib.import_module("edge_gateway.signing")
            except ImportError:  # el paquete exige dependencias (pydantic, fastapi…)
                return None
            finally:
                sys.path.remove(str(cand))
    return None


def test_contract_with_the_real_edge_gateway_signing_module() -> None:
    """Firma con el módulo REAL del gateway y verifica con el nuestro (y al revés)."""
    real = _edge_gateway_signing()
    if real is None:
        pytest.skip("edge_gateway.signing no disponible (clona ShadowAPI_Guard/edge-gateway)")
    ts, body = str(int(time.time())), b'{"query":"hola"}'
    sig, sha = real.sign(KEY, "acme", "rid-9", ts, "POST", "/v1/rag/query", body)
    assert sha == hashlib.sha256(body).hexdigest()
    assert guard.sign(KEY, "acme", "rid-9", ts, "POST", "/v1/rag/query", body) == sig
    h = {"x-tenant-id": "acme", "x-request-id": "rid-9", "x-guard-timestamp": ts, "x-guard-signature": sig}
    assert guard.verify(h, "POST", "/v1/rag/query", body, KEY) is not None
    assert real.verify_guard_request(h, "POST", "/v1/rag/query", body, KEY) == "acme"


# ------------------------------------------------------------------ /v1/rag/query

def test_rag_query_returns_only_the_approved_answer_and_audits_the_signed_tenant() -> None:
    client, rag, sink, _ = build()
    r = signed(client, "POST", "/v1/rag/query", {"query": "¿Cuál es el plazo de devolución de los pedidos?", "top_k": 3})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["verdict"] == "APPROVED" and "30 días" in body["answer"] and body["tenant_id"] == "acme"
    assert body["citations"] == ["politicas.md:1"]
    # el motor recibió la clave y el tenant del tenant firmado (nunca otro)
    sent = rag.calls[0]
    assert sent.headers["x-api-key"] == "key-acme" and sent.headers["x-tenant"] == "acme"
    assert json.loads(sent.content) == {"tenant_id": "acme", "query": "¿Cuál es el plazo de devolución de los pedidos?", "top_k": 3}
    [rec] = sink.records
    assert (rec.tenant_id, rec.verdict, rec.engine_request_id) == ("acme", Verdict.APPROVED, "engine-req-1")


def test_tenant_comes_only_from_the_signature_never_from_the_body() -> None:
    client, rag, _, _ = build()
    body_with_tenant = {"query": "plazo", "tenant_id": "globex"}
    assert signed(client, "POST", "/v1/rag/query", body_with_tenant).status_code == 422  # extra="forbid"
    r = signed(client, "POST", "/v1/rag/query", {"query": "plazo de devolución"}, tenant="globex")
    assert r.status_code == 200 and r.json()["tenant_id"] == "globex"
    assert rag.calls[-1].headers["x-api-key"] == "key-globex"


def test_committee_rejection_blocks_the_answer_and_hides_rule_codes() -> None:
    def hallucinating(req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=rag_body(draft="El plazo de devolución de los pedidos es de 365 días desde la entrega. [1]"))

    client, _, sink, _ = build(Rag(hallucinating))
    r = signed(client, "POST", "/v1/rag/query", {"query": "¿plazo de devolución de los pedidos?"})
    assert r.status_code == 200
    body = r.json()
    assert body["verdict"] == "REJECTED" and body["answer"] is None and body["error"] == "answer_blocked"
    assert "365" not in r.text and "BELOW_MIN" not in r.text and "VETO" not in r.text
    assert sink.records[0].verdict is Verdict.REJECTED and sink.records[0].reasons  # el detalle queda sólo en la auditoría


def test_response_for_another_tenant_from_the_engine_is_blocked() -> None:
    client, _, _, _ = build(Rag(lambda req: httpx.Response(200, json=rag_body(tenant="globex"))))
    body = signed(client, "POST", "/v1/rag/query", {"query": "plazo de devolución"}).json()
    assert body["verdict"] == "REJECTED" and body["answer"] is None


@pytest.mark.parametrize(
    "status,expected",
    [(503, 502), (500, 502), (403, 502)],
)
def test_engine_failures_map_to_a_generic_502_without_leaking_details(status: int, expected: int) -> None:
    client, _, sink, _ = build(Rag(lambda req: httpx.Response(status, json={"error": "database_unavailable", "detail": "secreto interno"}, headers={"X-Request-Id": "e-1"})))
    r = signed(client, "POST", "/v1/rag/query", {"query": "plazo"})
    assert r.status_code == expected and r.json()["error"] == "retrieval_unavailable" and "secreto" not in r.text
    assert sink.records[0].error_code == "RAG_HTTP" and sink.records[0].tenant_id == "acme"


def test_engine_timeout_is_504_and_connection_failure_is_502() -> None:
    def slow(req: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("x", request=req)

    def down(req: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("x", request=req)

    assert signed(build(Rag(slow))[0], "POST", "/v1/rag/query", {"query": "q"}).status_code == 504
    assert signed(build(Rag(down))[0], "POST", "/v1/rag/query", {"query": "q"}).status_code == 502


def test_tenant_without_engine_credentials_fails_closed() -> None:
    client, rag, _, _ = build()
    r = signed(client, "POST", "/v1/rag/query", {"query": "q"}, tenant="initech")
    assert r.status_code == 502 and rag.calls == []


@pytest.mark.parametrize("body", [{"query": "q", "filters": {"a": "b"}}, {"query": "q", "top_k": 21}, {"query": ""}, {"top_k": 3}, {"query": "q", "x": 1}])
def test_unsupported_or_invalid_requests_are_422_not_silently_adapted(body: dict[str, Any]) -> None:
    client, rag, _, _ = build()
    assert signed(client, "POST", "/v1/rag/query", body).status_code == 422
    assert rag.calls == []


# ------------------------------------------------------------------ autenticación

def test_unsigned_tampered_stale_and_replayed_requests_get_the_same_generic_401() -> None:
    client, rag, _, _ = build()
    body = {"query": "plazo"}
    unsigned = client.post("/v1/rag/query", json=body, headers={"x-tenant-id": "acme"})
    forged = signed(client, "POST", "/v1/rag/query", body, key=b"z" * 40)
    stale = signed(client, "POST", "/v1/rag/query", body, ts=int(time.time()) - 3600)
    first = signed(client, "POST", "/v1/rag/query", body, rid="same-id")
    replay = signed(client, "POST", "/v1/rag/query", body, rid="same-id")
    assert first.status_code == 200
    for r in (unsigned, forged, stale, replay):
        assert r.status_code == 401 and r.json()["error"] == "untrusted_caller" and set(r.json()) == {"error", "request_id"}
    assert len(rag.calls) == 1  # nada de lo no autenticado llegó al motor


def test_signature_does_not_transfer_to_another_path_or_body() -> None:
    client, _, _, _ = build()
    ts, rid, body = str(int(time.time())), "r-x", json.dumps({"query": "plazo"}).encode()
    sig = guard.sign(KEY, "acme", rid, ts, "POST", "/v1/rag/query", body)
    h = {"x-tenant-id": "acme", "x-request-id": rid, "x-guard-timestamp": ts, "x-guard-signature": sig, "content-type": "application/json"}
    assert client.post("/v1/consensus/run", content=body, headers=h).status_code == 401
    assert client.post("/v1/rag/query", content=b'{"query":"otra"}', headers=h).status_code == 401


def test_oversized_bodies_are_rejected() -> None:
    client, _, _, _ = build(max_body_bytes=200)
    assert signed(client, "POST", "/v1/rag/query", {"query": "x" * 500}).status_code == 413


# ------------------------------------------------------------------ /v1/consensus/run y /runs/{id}

def test_consensus_run_persists_and_is_scoped_to_the_tenant() -> None:
    client, _, _, _ = build()
    r = signed(client, "POST", "/v1/consensus/run", {"task": "¿Cuál es el plazo de devolución de los pedidos?", "max_rounds": 5})
    assert r.status_code == 200, r.text
    run = r.json()
    assert run["status"] == "completed" and run["verdict"] == "APPROVED" and run["rounds"] == 1 and "30 días" in run["answer"]
    got = signed(client, "GET", f"/v1/consensus/runs/{run['run_id']}")
    assert got.status_code == 200 and got.json()["answer"] == run["answer"] and got.json()["tenant_id"] == "acme"
    other = signed(client, "GET", f"/v1/consensus/runs/{run['run_id']}", tenant="globex")
    assert other.status_code == 404 and other.json()["error"] == "not_found"
    assert signed(client, "GET", "/v1/consensus/runs/inexistente").status_code == 404
    assert signed(client, "GET", "/v1/consensus/runs/..%2Fetc").status_code == 404


def test_consensus_run_blocked_answer_is_stored_without_the_draft() -> None:
    client, _, _, store = build(Rag(lambda req: httpx.Response(200, json=rag_body(draft="Cifra inventada de 999 días. [1]"))))
    run = signed(client, "POST", "/v1/consensus/run", {"task": "¿plazo de devolución de los pedidos?"}).json()
    assert run["verdict"] == "REJECTED" and run["answer"] is None
    stored = signed(client, "GET", f"/v1/consensus/runs/{run['run_id']}").json()
    assert stored["answer"] is None and "999" not in json.dumps(stored)


def test_consensus_run_validates_agents_and_context() -> None:
    client, _, _, _ = build()
    committee = ["hallucination_critic", "tenant_security_auditor", "coherence_validator"]
    assert signed(client, "POST", "/v1/consensus/run", {"task": "q", "agents": committee}).status_code == 200
    assert signed(client, "POST", "/v1/consensus/run", {"task": "q", "agents": ["coherence_validator"]}).json()["reason"] == "agents_must_be_the_full_committee"
    assert signed(client, "POST", "/v1/consensus/run", {"task": "q", "context": {"top_k": 3}}).status_code == 200
    assert signed(client, "POST", "/v1/consensus/run", {"task": "q", "context": {"top_k": 99}}).status_code == 422
    assert signed(client, "POST", "/v1/consensus/run", {"task": "q", "context": {"otra": "cosa"}}).json()["reason"] == "unsupported_context_key"
    assert signed(client, "POST", "/v1/consensus/run", {"task": "q", "context": {"top_k": True}}).status_code == 422
    assert signed(client, "POST", "/v1/consensus/run", {"task": "q", "max_rounds": 99}).status_code == 422


def test_consensus_run_engine_failure_is_a_failed_run_not_an_exception() -> None:
    client, _, _, _ = build(Rag(lambda req: httpx.Response(503, json={"error": "database_unavailable"})))
    r = signed(client, "POST", "/v1/consensus/run", {"task": "q"})
    assert r.status_code == 502 and r.json()["status"] == "failed" and r.json()["error"] == "retrieval_unavailable"


# ------------------------------------------------------------------ /v1/consensus (NexusFlow)

def review(client: TestClient, body: dict[str, Any], *, tenant: str | None = "acme", token: str | None = TOKEN) -> Resp:
    headers: dict[str, str] = {}
    if token is not None:
        headers["authorization"] = f"Bearer {token}"
    if tenant is not None:
        headers["x-tenant-id"] = tenant
    resp: Resp = client.post("/v1/consensus", json=body, headers=headers)
    return resp


def test_review_contract_for_nexusflow_approved_and_rejected() -> None:
    client, rag, sink, _ = build()
    ok = review(client, {"question": "¿Cuál es el plazo de devolución de los pedidos?",
                         "draft_answer": "El plazo de devolución de los pedidos es de 30 días desde la entrega. [1]",
                         "passages": [fragment()]})
    assert ok.status_code == 200, ok.text
    body = ok.json()
    assert body["verdict"] == "approved" and "30 días" in body["answer"] and body["reasons"] == [] and body["score"] >= 0.8
    bad = review(client, {"question": "¿plazo de devolución de los pedidos?", "draft_answer": "Son 400 días desde la entrega. [1]", "passages": [fragment()]}).json()
    assert bad["verdict"] == "rejected" and "answer" not in bad and bad["reasons"]
    assert rag.calls == []  # revisar no consulta al motor
    assert [r.tenant_id for r in sink.records] == ["acme", "acme"]


def test_review_detects_foreign_tenant_passages_and_requires_auth() -> None:
    client, _, _, _ = build()
    foreign = {**fragment(), "tenant_id": "globex"}
    body = review(client, {"question": "plazo de devolución de los pedidos", "draft_answer": "El plazo de devolución de los pedidos es de 30 días. [1]", "passages": [foreign]}).json()
    assert body["verdict"] == "rejected" and "VETO:tenant_security_auditor" in body["reasons"]
    ok = {"question": "q", "draft_answer": "x", "passages": []}
    assert review(client, ok, token=None).status_code == 401
    assert review(client, ok, token="x" * 32).status_code == 401
    assert review(client, ok, tenant=None).status_code == 401
    assert review(client, ok, tenant="../etc").status_code == 401
    assert review(client, {"question": "q"}).status_code == 422


def test_review_route_is_disabled_without_a_service_token() -> None:
    client, _, _, _ = build(service_token=None)
    assert review(client, {"question": "q", "draft_answer": "x", "passages": []}).status_code == 503


# ------------------------------------------------------------------ sondas y superficie

def test_probes_and_no_openapi_surface() -> None:
    client, _, _, _ = build()
    assert client.get("/healthz").json() == {"status": "ok", "service": "consensus-service"}
    assert client.get("/readyz").json() == {"status": "ready"}
    for path in ("/docs", "/redoc", "/openapi.json", "/admin", "/v1/other"):
        assert client.get(path).status_code == 404


# ------------------------------------------------------------------ configuración

def test_settings_fail_closed_on_missing_or_weak_configuration() -> None:
    from rag_consensus import ConfigurationError

    good = {"GUARD_SIGNING_KEY": "k" * 32, "CONTEXTRAG_URL": "http://rag:8000", "CONTEXTRAG_TENANT_KEYS_JSON": '{"acme":"key"}'}
    assert ServiceSettings.from_env(good).tenant_rag_keys == {"acme": "key"}
    for patch in ({"GUARD_SIGNING_KEY": "short"}, {"CONTEXTRAG_URL": ""}, {"CONTEXTRAG_TENANT_KEYS_JSON": "{}"}, {"CONTEXTRAG_TENANT_KEYS_JSON": "no json"},
                  {"CONTEXTRAG_TENANT_KEYS_JSON": '{"../x":"k"}'}, {"CONTEXTRAG_TENANT_KEYS_JSON": '{"acme":""}'}, {"SERVICE_TOKEN": "corto"}):
        with pytest.raises(ConfigurationError):
            ServiceSettings.from_env({**good, **patch})
    assert "k" * 32 not in repr(ServiceSettings.from_env(good))  # los secretos no aparecen en repr
