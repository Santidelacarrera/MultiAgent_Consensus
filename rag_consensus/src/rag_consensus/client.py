"""Cliente HTTP asíncrono hacia `POST /api/v1/retrieve` de ContextRAG_Engine.

Contrato (verificado contra contextrag/api/retrieval.py del servicio):

    POST {base_url}{retrieve_path}                      (por defecto /api/v1/retrieve)
    Cabeceras:  X-API-Key: <clave ligada a un tenant>,  X-Tenant: <tenant_id>
    Cuerpo:     {"tenant_id": str, "query": str (1..4000), "top_k": int (1..20)}      (campos extra ⇒ 422)
    200:        {"status": "ok" | "no_results", "tenant_id": str, "query": str,
                 "fragments": [{"index": int (1-based), "score": float, "doc_id": str, "source": str,
                                "section": str, "page": int | null, "start": int, "end": int, "text": str}],
                 "draft_answer": str | null, "draft_verified": false, "latency_ms": float}
    Errores:    401 clave inválida · 403 tenant no autorizado · 422 cuerpo inválido · 429 límite · 503 BD no disponible

Los fragmentos NO llevan `tenant_id` propio: el servicio filtra por tenant en la búsqueda y con RLS en la auditoría, y
declara el tenant a nivel de respuesta. Este cliente estampa ese tenant en cada `Chunk` para que el comité pueda
verificarlo contra el solicitado. Cualquier desviación del contrato se rechaza con `RagProtocolError`.
"""
from __future__ import annotations

import asyncio
import json
import logging
import math
import re
from types import TracebackType
from typing import Awaitable, Callable, Mapping, Protocol

import httpx

from .config import RagClientConfig
from .errors import RagConnectionError, RagHttpError, RagProtocolError, RagTimeoutError
from .models import NO_ANSWER_TEXT, Chunk, RetrievalRequest, RetrievalResponse

log = logging.getLogger("rag_consensus.client")

_RETRYABLE_STATUS = frozenset({429, 502, 503, 504})
_MAX_CHUNKS = 200
_MAX_RETRY_AFTER_S = 5.0
_SAFE_ID = re.compile(r"^[A-Za-z0-9._:\-]{1,64}$")
_SAFE_CODE = re.compile(r"^[a-z][a-z0-9_]{0,63}$")

Sleep = Callable[[float], Awaitable[None]]


class RetrievalPort(Protocol):
    """Puerto que consume el orquestador (facilita sustituir el cliente en tests)."""

    async def retrieve(self, request: RetrievalRequest) -> RetrievalResponse: ...


class RagClient:
    def __init__(
        self,
        config: RagClientConfig,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
        sleep: Sleep = asyncio.sleep,
    ) -> None:
        headers = {"accept": "application/json", "user-agent": "multiagent-consensus/rag-client"}
        if config.api_key:
            headers[config.api_key_header] = config.api_key
        self._config = config
        self._sleep = sleep
        self._http = httpx.AsyncClient(
            headers=headers,
            timeout=config.timeout_s,
            verify=config.verify_tls,
            follow_redirects=False,  # evita reenviar el bearer a otro host
            transport=transport,
        )

    async def __aenter__(self) -> "RagClient":
        return self

    async def __aexit__(self, et: type[BaseException] | None, e: BaseException | None, tb: TracebackType | None) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        await self._http.aclose()

    # ------------------------------------------------------------------

    async def retrieve(self, request: RetrievalRequest) -> RetrievalResponse:
        """Consulta el motor RAG. Lanza únicamente subclases de `RagError`."""
        response = await self._post_with_retries(request)
        return self._parse(response, request)

    async def _post_with_retries(self, request: RetrievalRequest) -> httpx.Response:
        cfg = self._config
        last_timeout = False
        attempts = cfg.max_retries + 1
        for attempt in range(attempts):
            retry_after: float | None = None
            try:
                resp = await self._http.post(cfg.url, json=request.to_payload(), headers={"X-Tenant": request.tenant_id})
            except httpx.TimeoutException:
                last_timeout = True
                log.warning("rag timeout (intento %d/%d)", attempt + 1, attempts)
            except (httpx.TransportError, httpx.InvalidURL) as e:
                last_timeout = False
                log.warning("rag error de transporte %s (intento %d/%d)", type(e).__name__, attempt + 1, attempts)
                if isinstance(e, httpx.InvalidURL):
                    raise RagConnectionError("URL del motor RAG inválida") from None
            else:
                if resp.status_code < 300:
                    return resp
                if resp.status_code not in _RETRYABLE_STATUS:
                    raise _http_error(resp)  # 4xx/5xx no reintentables: no se filtra el cuerpo
                last_timeout = False
                retry_after = _retry_after(resp.headers)
                log.warning("rag HTTP %d (intento %d/%d)", resp.status_code, attempt + 1, attempts)
                if attempt == attempts - 1:
                    raise _http_error(resp, "reintentos agotados")
            if attempt < attempts - 1:
                await self._sleep(retry_after if retry_after is not None else cfg.backoff_s * (2**attempt))
        if last_timeout:
            raise RagTimeoutError(f"sin respuesta tras {attempts} intento(s)")
        raise RagConnectionError(f"no se pudo conectar tras {attempts} intento(s)")

    # ------------------------------------------------------------------

    def _parse(self, resp: httpx.Response, request: RetrievalRequest) -> RetrievalResponse:
        raw = resp.content
        if len(raw) > self._config.max_response_bytes:
            raise RagProtocolError("respuesta demasiado grande")
        try:
            body = json.loads(raw)
        except ValueError:
            raise RagProtocolError("la respuesta no es JSON") from None
        if not isinstance(body, dict):
            raise RagProtocolError("la respuesta debe ser un objeto JSON")

        status = body.get("status")
        if status not in ("ok", "no_results"):
            raise RagProtocolError("'status' debe ser 'ok' o 'no_results'")
        tenant = body.get("tenant_id")
        if not isinstance(tenant, str) or not tenant:
            raise RagProtocolError("falta 'tenant_id' en la respuesta")  # sin él no se puede verificar el aislamiento
        raw_fragments = body.get("fragments")
        if not isinstance(raw_fragments, list) or len(raw_fragments) > _MAX_CHUNKS:
            raise RagProtocolError("'fragments' debe ser una lista (≤ 200)")
        draft = body.get("draft_answer")
        if draft is not None and not isinstance(draft, str):
            raise RagProtocolError("'draft_answer' debe ser string o null")

        chunks = tuple(_parse_fragment(f, i, tenant) for i, f in enumerate(raw_fragments))
        synthesized = draft is None or not draft.strip()
        return RetrievalResponse(
            draft_answer=NO_ANSWER_TEXT if synthesized else str(draft),
            chunks=chunks,
            tenant_id=tenant,
            status=str(status),
            synthesized_abstention=synthesized,
            engine_request_id=_request_id(resp.headers),
        )


def _parse_fragment(raw: object, position: int, tenant: str) -> Chunk:
    if not isinstance(raw, dict):
        raise RagProtocolError(f"fragments[{position}] no es un objeto")
    index, doc_id, text, score = raw.get("index"), raw.get("doc_id"), raw.get("text"), raw.get("score")
    if isinstance(index, bool) or not isinstance(index, int) or index < 1:
        raise RagProtocolError(f"fragments[{position}].index inválido")
    if not isinstance(doc_id, str) or not doc_id:
        raise RagProtocolError(f"fragments[{position}].doc_id inválido")
    if not isinstance(text, str):
        raise RagProtocolError(f"fragments[{position}].text inválido")
    if isinstance(score, bool) or not isinstance(score, (int, float)) or not math.isfinite(score):
        raise RagProtocolError(f"fragments[{position}].score inválido")
    source, section = raw.get("source"), raw.get("section")
    if source is not None and not isinstance(source, str):
        raise RagProtocolError(f"fragments[{position}].source inválido")
    if section is not None and not isinstance(section, str):
        raise RagProtocolError(f"fragments[{position}].section inválido")
    return Chunk(
        id=f"{doc_id}:{index}",
        text=text,
        score=float(score),
        tenant_id=tenant,  # tenant declarado por el servicio para toda la respuesta
        source=source,
        metadata={"index": index, "doc_id": doc_id, "section": section, "page": raw.get("page"), "start": raw.get("start"), "end": raw.get("end"), "tenant_source": "response"},
    )


def _request_id(headers: Mapping[str, str]) -> str | None:
    value = headers.get("x-request-id")
    return value if value is not None and _SAFE_ID.fullmatch(value) else None


def _http_error(resp: httpx.Response, message: str = "") -> RagHttpError:
    """Error HTTP con el id de petición del motor y su código de error (sólo si son identificadores seguros)."""
    code: str | None = None
    try:
        body = json.loads(resp.content[:4096])
        candidate = body.get("error") if isinstance(body, dict) else None
        if isinstance(candidate, str) and _SAFE_CODE.fullmatch(candidate):
            code = candidate
    except ValueError:
        pass
    return RagHttpError(resp.status_code, message, engine_request_id=_request_id(resp.headers), engine_error=code)


def _retry_after(headers: Mapping[str, str]) -> float | None:
    value = headers.get("retry-after")
    if value is None:
        return None
    try:
        seconds = float(value)
    except ValueError:
        return None
    return min(max(seconds, 0.0), _MAX_RETRY_AFTER_S) if math.isfinite(seconds) else None
