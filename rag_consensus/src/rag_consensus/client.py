"""Cliente HTTP asíncrono hacia el endpoint de recuperación de ContextRAG_Engine.

Contrato asumido (configurable con `RagClientConfig.retrieve_path`):

    POST {base_url}{retrieve_path}
    → {"tenant_id": str, "query": str, "top_k": int, "filters"?: {...}, "min_score"?: float}
    ← {"tenant_id"?: str,
       "draft_answer": str            (alias admitido: "answer"),
       "chunks": [{"id": str, "text": str, "score": number, "tenant_id"?: str,
                   "source"?: str, "metadata"?: {...}}]}      (alias: "chunk_id", "content")

Cualquier desviación se rechaza con `RagProtocolError`; no se "arregla" la respuesta en silencio.
"""
from __future__ import annotations

import asyncio
import json
import logging
import math
from types import TracebackType
from typing import Awaitable, Callable, Mapping, Protocol

import httpx

from .config import RagClientConfig
from .errors import RagConnectionError, RagHttpError, RagProtocolError, RagTimeoutError
from .models import Chunk, RetrievalRequest, RetrievalResponse

log = logging.getLogger("rag_consensus.client")

_RETRYABLE_STATUS = frozenset({429, 502, 503, 504})
_MAX_CHUNKS = 200
_MAX_RETRY_AFTER_S = 5.0

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
            headers["authorization"] = f"Bearer {config.api_key}"
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
                resp = await self._http.post(cfg.url, json=request.to_payload())
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
                    raise RagHttpError(resp.status_code)  # 4xx/5xx no reintentables: no se filtra el cuerpo
                last_timeout = False
                retry_after = _retry_after(resp.headers)
                log.warning("rag HTTP %d (intento %d/%d)", resp.status_code, attempt + 1, attempts)
                if attempt == attempts - 1:
                    raise RagHttpError(resp.status_code, "reintentos agotados")
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

        draft = body.get("draft_answer", body.get("answer"))
        if not isinstance(draft, str):
            raise RagProtocolError("falta 'draft_answer' (string)")
        raw_chunks = body.get("chunks")
        if not isinstance(raw_chunks, list) or len(raw_chunks) > _MAX_CHUNKS:
            raise RagProtocolError("'chunks' debe ser una lista (≤ 200)")
        tenant = body.get("tenant_id")
        if tenant is not None and not isinstance(tenant, str):
            raise RagProtocolError("'tenant_id' debe ser string")

        chunks = tuple(_parse_chunk(c, i) for i, c in enumerate(raw_chunks))
        return RetrievalResponse(draft_answer=draft, chunks=chunks, tenant_id=tenant)


def _parse_chunk(raw: object, index: int) -> Chunk:
    if not isinstance(raw, dict):
        raise RagProtocolError(f"chunks[{index}] no es un objeto")
    cid = raw.get("id", raw.get("chunk_id"))
    text = raw.get("text", raw.get("content"))
    score = raw.get("score")
    if not isinstance(cid, str) or not cid:
        raise RagProtocolError(f"chunks[{index}].id inválido")
    if not isinstance(text, str):
        raise RagProtocolError(f"chunks[{index}].text inválido")
    if isinstance(score, bool) or not isinstance(score, (int, float)) or not math.isfinite(score):
        raise RagProtocolError(f"chunks[{index}].score inválido")
    tenant = raw.get("tenant_id")
    source = raw.get("source")
    meta = raw.get("metadata", {})
    if tenant is not None and not isinstance(tenant, str):
        raise RagProtocolError(f"chunks[{index}].tenant_id inválido")
    if source is not None and not isinstance(source, str):
        raise RagProtocolError(f"chunks[{index}].source inválido")
    if not isinstance(meta, dict):
        raise RagProtocolError(f"chunks[{index}].metadata inválido")
    return Chunk(id=cid, text=text, score=float(score), tenant_id=tenant, source=source, metadata=dict(meta))


def _retry_after(headers: Mapping[str, str]) -> float | None:
    value = headers.get("retry-after")
    if value is None:
        return None
    try:
        seconds = float(value)
    except ValueError:
        return None
    return min(max(seconds, 0.0), _MAX_RETRY_AFTER_S) if math.isfinite(seconds) else None
