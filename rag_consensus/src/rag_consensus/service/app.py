"""Answer Gate como servicio HTTP.

Rutas públicas (las reenvía el edge-gateway firmadas; el tenant sale SÓLO de la firma):
    POST /v1/rag/query                 → recupera en ContextRAG_Engine y entrega sólo si el comité aprueba
    POST /v1/consensus/run             → igual, con el contrato de "ejecución" del gateway (persistida)
    GET  /v1/consensus/runs/{run_id}   → resultado de una ejecución (acotado al tenant)
Ruta interna (servicio-a-servicio, token + X-Tenant-Id; la usa NexusFlow):
    POST /v1/consensus                 → revisa un borrador y sus pasajes ya recuperados (sin consultar al motor)
Sondas: GET /healthz (liveness) · GET /readyz (Redis)
"""
from __future__ import annotations

import hmac
import logging
import re
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ValidationError
from redis.asyncio import Redis

from ..audit import AuditSink, LoggingAuditSink
from ..client import RagClient, RetrievalPort
from ..config import AGENT_NAMES, RagClientConfig
from ..errors import RagHttpError
from ..models import MAX_TOP_K, TENANT_RE, Chunk, GuardedAnswer, RetrievalRequest, RetrievalResponse, Verdict
from ..orchestrator import ConsensusOrchestrator
from . import guard
from .schemas import ConsensusRunIn, RagQueryIn, ReviewIn
from .settings import ServiceSettings
from .stores import MemoryStore, RedisStore, ReplayCache, RunRecord, RunStore

log = logging.getLogger("rag_consensus.service")

_STATUS_BY_ERROR = {"RAG_TIMEOUT": 504, "RAG_CONNECTION": 502, "RAG_HTTP": 502, "RAG_PROTOCOL": 502, "AUDIT_FAILED": 503}
_RUN_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


class TenantRoutedRetriever:
    """Consulta a ContextRAG_Engine con la clave del tenant (en el motor, cada clave está ligada a UN tenant)."""

    def __init__(self, settings: ServiceSettings, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self._s, self._transport = settings, transport
        self._clients: dict[str, RagClient] = {}

    def _client(self, tenant_id: str) -> RagClient:
        c = self._clients.get(tenant_id)
        if c is None:
            key = self._s.tenant_rag_keys.get(tenant_id)
            if key is None:
                raise RagHttpError(403, "tenant sin credenciales para el motor RAG")  # fail-closed
            cfg = RagClientConfig(
                base_url=self._s.contextrag_url,
                api_key=key,
                timeout_s=self._s.contextrag_timeout_s,
                allow_insecure_http=self._s.contextrag_allow_insecure_http,
            )
            c = self._clients[tenant_id] = RagClient(cfg, transport=self._transport)
        return c

    async def retrieve(self, request: RetrievalRequest) -> RetrievalResponse:
        return await self._client(request.tenant_id).retrieve(request)

    async def aclose(self) -> None:
        for c in self._clients.values():
            await c.aclose()


class StaticRetriever:
    """Devuelve una respuesta ya recuperada: permite revisar un borrador ajeno con el mismo comité y auditoría."""

    def __init__(self, response: RetrievalResponse) -> None:
        self._response = response

    async def retrieve(self, request: RetrievalRequest) -> RetrievalResponse:
        return self._response


def _json(status: int, body: dict[str, Any], request_id: str) -> JSONResponse:
    return JSONResponse(body, status_code=status, headers={"X-Request-Id": request_id})


def _error(status: int, code: str, request_id: str, **extra: Any) -> JSONResponse:
    return _json(status, {"error": code, "request_id": request_id, **extra}, request_id)


def create_app(
    settings: ServiceSettings,
    *,
    store: RunStore | None = None,
    replay: ReplayCache | None = None,
    retriever: RetrievalPort | None = None,
    audit: AuditSink | None = None,
    transport: httpx.AsyncBaseTransport | None = None,
) -> FastAPI:
    redis: Redis | None = None
    if store is None or replay is None:
        if settings.redis_url:
            redis = Redis.from_url(settings.redis_url)
            shared: RedisStore | MemoryStore = RedisStore(redis, run_ttl_s=settings.run_ttl_s)
        else:
            shared = MemoryStore(run_ttl_s=settings.run_ttl_s)
        store = store or shared
        replay = replay or shared
    runs: RunStore = store
    seen: ReplayCache = replay
    routed = TenantRoutedRetriever(settings, transport)
    gate_retriever: RetrievalPort = retriever or routed
    sink = audit or LoggingAuditSink()
    orchestrator = ConsensusOrchestrator(gate_retriever, settings.policy, audit=sink)

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        yield
        await routed.aclose()
        if redis is not None:
            await redis.aclose()

    app = FastAPI(title="Answer Gate (consensus-service)", version="1.0.0", docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)

    # ------------------------------------------------------------------ autenticación

    async def read_body(request: Request, rid: str) -> bytes | JSONResponse:
        declared = request.headers.get("content-length")
        if declared and declared.isdigit() and int(declared) > settings.max_body_bytes:
            return _error(413, "payload_too_large", rid)
        body = await request.body()
        return _error(413, "payload_too_large", rid) if len(body) > settings.max_body_bytes else body

    async def guard_identity(request: Request, body: bytes) -> guard.GuardIdentity | None:
        ident = guard.verify(request.headers, request.method, request.url.path, body, settings.guard_signing_key)
        if ident is None or not await seen.first_seen(ident.tenant, ident.request_id):
            return None  # respuesta genérica: no se distingue falta de firma, manipulación o replay
        return ident

    def parse(model: type[BaseModel], body: bytes, rid: str) -> BaseModel | JSONResponse:
        try:
            return model.model_validate_json(body)
        except ValidationError as e:
            return _error(422, "invalid_request", rid, fields=sorted({".".join(str(p) for p in err["loc"]) for err in e.errors()})[:10])

    # ------------------------------------------------------------------ núcleo

    async def answer_for(tenant: str, query: str, top_k: int) -> GuardedAnswer:
        return await orchestrator.answer(RetrievalRequest(tenant_id=tenant, query=query, top_k=top_k))

    def outcome(rid: str, tenant: str, ans: GuardedAnswer) -> tuple[int, dict[str, Any]]:
        if ans.error_code:
            return _STATUS_BY_ERROR.get(ans.error_code, 502), {"error": "retrieval_unavailable" if ans.error_code != "AUDIT_FAILED" else "audit_unavailable", "request_id": rid}
        body: dict[str, Any] = {"request_id": rid, "tenant_id": tenant, "verdict": ans.verdict.value, "gate_request_id": ans.request_id}
        if ans.verdict is Verdict.APPROVED:
            body.update(answer=ans.answer, citations=list(ans.citations))
        else:
            body.update(answer=None, error="answer_blocked")  # sin códigos internos de regla: sólo en la auditoría
        return 200, body

    def top_k_or_error(top_k: int, rid: str) -> JSONResponse | None:
        if top_k > MAX_TOP_K:
            return _error(422, "invalid_request", rid, reason="top_k_exceeds_engine_limit", max=MAX_TOP_K)
        return None

    # ------------------------------------------------------------------ rutas públicas (firmadas por el guard)

    @app.post("/v1/rag/query")
    async def rag_query(request: Request) -> JSONResponse:
        rid = request.headers.get("x-request-id") or uuid.uuid4().hex
        body = await read_body(request, rid)
        if isinstance(body, JSONResponse):
            return body
        ident = await guard_identity(request, body)
        if ident is None:
            return _error(401, "untrusted_caller", rid)
        rid = ident.request_id
        parsed = parse(RagQueryIn, body, rid)
        if isinstance(parsed, JSONResponse):
            return parsed
        assert isinstance(parsed, RagQueryIn)
        if parsed.filters:
            return _error(422, "invalid_request", rid, reason="filters_not_supported")  # ignorarlos ampliaría los resultados
        if (err := top_k_or_error(parsed.top_k, rid)) is not None:
            return err
        status, payload = outcome(rid, ident.tenant, await answer_for(ident.tenant, parsed.query, parsed.top_k))
        return _json(status, payload, rid)

    @app.post("/v1/consensus/run")
    async def consensus_run(request: Request) -> JSONResponse:
        rid = request.headers.get("x-request-id") or uuid.uuid4().hex
        body = await read_body(request, rid)
        if isinstance(body, JSONResponse):
            return body
        ident = await guard_identity(request, body)
        if ident is None:
            return _error(401, "untrusted_caller", rid)
        rid = ident.request_id
        parsed = parse(ConsensusRunIn, body, rid)
        if isinstance(parsed, JSONResponse):
            return parsed
        assert isinstance(parsed, ConsensusRunIn)
        if parsed.agents and set(parsed.agents) != set(AGENT_NAMES):
            return _error(422, "invalid_request", rid, reason="agents_must_be_the_full_committee", committee=list(AGENT_NAMES))
        extra = set(parsed.context) - {"top_k"}
        if extra:
            return _error(422, "invalid_request", rid, reason="unsupported_context_key", keys=sorted(extra)[:5])
        raw_k = parsed.context.get("top_k", 5)
        if isinstance(raw_k, bool) or not isinstance(raw_k, int) or raw_k < 1:
            return _error(422, "invalid_request", rid, reason="invalid_top_k")
        if (err := top_k_or_error(raw_k, rid)) is not None:
            return err

        ans = await answer_for(ident.tenant, parsed.task, raw_k)
        run_id = uuid.uuid4().hex
        status, payload = outcome(rid, ident.tenant, ans)
        failed = ans.error_code is not None
        await runs.put(
            RunRecord(run_id=run_id, tenant_id=ident.tenant, status="failed" if failed else "completed",
                      verdict=None if failed else ans.verdict.value, answer=ans.answer, citations=ans.citations,
                      error=payload.get("error"))
        )
        payload.update(run_id=run_id, status="failed" if failed else "completed", rounds=1, committee=list(AGENT_NAMES))
        return _json(status, payload, rid)

    @app.get("/v1/consensus/runs/{run_id}")
    async def consensus_get(request: Request, run_id: str) -> JSONResponse:
        rid = request.headers.get("x-request-id") or uuid.uuid4().hex
        ident = await guard_identity(request, b"")
        if ident is None:
            return _error(401, "untrusted_caller", rid)
        rid = ident.request_id
        rec = await runs.get(ident.tenant, run_id) if _RUN_ID.fullmatch(run_id) else None
        if rec is None:
            return _error(404, "not_found", rid)  # otro tenant ⇒ mismo 404: no se revela la existencia
        return _json(200, {"request_id": rid, "run_id": rec.run_id, "tenant_id": rec.tenant_id, "status": rec.status,
                           "verdict": rec.verdict, "answer": rec.answer, "citations": list(rec.citations),
                           **({"error": rec.error} if rec.error else {})}, rid)

    # ------------------------------------------------------------------ ruta interna (NexusFlow)

    @app.post("/v1/consensus")
    async def review(request: Request) -> JSONResponse:
        rid = request.headers.get("x-request-id") or uuid.uuid4().hex
        if not settings.service_token:
            return _error(503, "route_disabled", rid)
        supplied = request.headers.get("authorization", "")
        expected = f"Bearer {settings.service_token}"
        tenant = request.headers.get("x-tenant-id", "")
        if not hmac.compare_digest(supplied.encode(), expected.encode()) or not TENANT_RE.fullmatch(tenant):
            return _error(401, "untrusted_caller", rid)
        body = await read_body(request, rid)
        if isinstance(body, JSONResponse):
            return body
        parsed = parse(ReviewIn, body, rid)
        if isinstance(parsed, JSONResponse):
            return parsed
        assert isinstance(parsed, ReviewIn)

        chunks: list[Chunk] = []
        for i, p in enumerate(parsed.passages, start=1):
            idx = p.index or i
            chunks.append(Chunk(
                id=f"{p.doc_id}:{idx}" if p.doc_id else f"passage:{idx}", text=p.text, score=p.score,
                tenant_id=p.tenant_id or tenant, source=p.source,
                metadata={"index": idx, "doc_id": p.doc_id, "section": p.section,
                          "tenant_source": "passage" if p.tenant_id else "caller_asserted"},
            ))
        draft = parsed.draft_answer.strip()
        response = RetrievalResponse(draft_answer=draft or "", chunks=tuple(chunks), tenant_id=tenant)
        orch = ConsensusOrchestrator(StaticRetriever(response), settings.policy, audit=sink)
        ans = await orch.answer(RetrievalRequest(tenant_id=tenant, query=parsed.question, top_k=min(max(len(chunks), 1), MAX_TOP_K)))
        if ans.error_code:
            return _error(503, "review_unavailable", rid)
        reasons = list(ans.decision.reasons)
        out: dict[str, Any] = {"request_id": rid, "verdict": "approved" if ans.verdict is Verdict.APPROVED else "rejected",
                               "reasons": reasons, "score": ans.decision.aggregate_score, "citations": list(ans.citations)}
        if ans.verdict is Verdict.APPROVED:
            out["answer"] = ans.answer
        return _json(200, out, rid)

    # ------------------------------------------------------------------ sondas

    @app.get("/healthz")
    async def healthz() -> dict[str, str]:
        return {"status": "ok", "service": "consensus-service"}

    @app.get("/readyz")
    async def readyz() -> JSONResponse:
        ok = await runs.ping()
        return JSONResponse({"status": "ready" if ok else "store_unavailable"}, status_code=200 if ok else 503)

    return app


def app_factory() -> FastAPI:  # pragma: no cover - entrada de uvicorn (--factory)
    import os

    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"), format="%(message)s")
    return create_app(ServiceSettings.from_env(os.environ))
