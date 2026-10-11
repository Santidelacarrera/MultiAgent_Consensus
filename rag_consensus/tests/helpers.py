from __future__ import annotations

import asyncio
from typing import Any, Callable, Coroutine, TypeVar

import httpx

from rag_consensus import Chunk, RagClient, RagClientConfig, RetrievalRequest, RetrievalResponse

T = TypeVar("T")


def run(coro: Coroutine[Any, Any, T]) -> T:
    return asyncio.run(coro)


TENANT = "acme"
REQUEST = RetrievalRequest(tenant_id=TENANT, query="¿Cuál es el plazo de devolución de los pedidos?", top_k=3)

POLICY_TEXT = "El plazo de devolución de los pedidos es de 30 días desde la entrega. Los reembolsos se procesan en 5 días laborables."


def chunk(cid: str = "c1", text: str = POLICY_TEXT, tenant: str | None = TENANT, score: float = 0.9, **meta: object) -> Chunk:
    return Chunk(id=cid, text=text, score=score, tenant_id=tenant, source="politicas.md", metadata=meta)


def response(draft: str = "El plazo de devolución de los pedidos es de 30 días desde la entrega.", chunks: tuple[Chunk, ...] | None = None, tenant: str | None = TENANT) -> RetrievalResponse:
    return RetrievalResponse(draft_answer=draft, chunks=(chunk(),) if chunks is None else chunks, tenant_id=tenant)


def fragment(index: int = 1, text: str = POLICY_TEXT, doc_id: str = "politicas.md", score: float = 0.9) -> dict[str, Any]:
    return {"index": index, "score": score, "doc_id": doc_id, "source": doc_id, "section": "Devoluciones", "page": None, "start": 0, "end": len(text), "text": text}


def rag_body(
    draft: str | None = "El plazo de devolución de los pedidos es de 30 días desde la entrega. [1]",
    fragments: list[dict[str, Any]] | None = None,
    tenant: str = TENANT,
    status: str = "ok",
) -> dict[str, Any]:
    """Respuesta con la forma REAL de POST /api/v1/retrieve de ContextRAG_Engine."""
    frs = [fragment()] if fragments is None else fragments
    return {
        "status": status if frs else "no_results",
        "tenant_id": tenant,
        "query": REQUEST.query,
        "fragments": frs,
        "draft_answer": draft,
        "draft_verified": False,
        "latency_ms": 3.2,
    }


Handler = Callable[[httpx.Request], httpx.Response]


def make_client(handler: Handler, **cfg: Any) -> tuple[RagClient, list[float]]:
    """Cliente con transporte simulado y `sleep` instantáneo (devuelve las esperas solicitadas)."""
    sleeps: list[float] = []

    async def fake_sleep(s: float) -> None:
        sleeps.append(s)

    config = RagClientConfig(base_url=cfg.pop("base_url", "https://rag.internal"), **cfg)
    return RagClient(config, transport=httpx.MockTransport(handler), sleep=fake_sleep), sleeps
