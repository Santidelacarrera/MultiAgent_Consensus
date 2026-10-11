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


def rag_body(draft: str = "El plazo de devolución de los pedidos es de 30 días desde la entrega.", chunks: list[dict[str, Any]] | None = None, tenant: str | None = TENANT) -> dict[str, Any]:
    body: dict[str, Any] = {
        "draft_answer": draft,
        "chunks": chunks if chunks is not None else [{"id": "c1", "text": POLICY_TEXT, "score": 0.9, "tenant_id": TENANT, "source": "politicas.md"}],
    }
    if tenant is not None:
        body["tenant_id"] = tenant
    return body


Handler = Callable[[httpx.Request], httpx.Response]


def make_client(handler: Handler, **cfg: Any) -> tuple[RagClient, list[float]]:
    """Cliente con transporte simulado y `sleep` instantáneo (devuelve las esperas solicitadas)."""
    sleeps: list[float] = []

    async def fake_sleep(s: float) -> None:
        sleeps.append(s)

    config = RagClientConfig(base_url=cfg.pop("base_url", "https://rag.internal"), **cfg)
    return RagClient(config, transport=httpx.MockTransport(handler), sleep=fake_sleep), sleeps
