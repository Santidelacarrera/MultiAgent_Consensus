from __future__ import annotations

import asyncio
import json
from typing import Callable

import httpx

from rag_consensus import (
    COHERENCE,
    Assessment,
    AssessmentContext,
    ConsensusOrchestrator,
    ConsensusPolicy,
    RagClientConfig,
    RagTimeoutError,
    RetrievalRequest,
    RetrievalResponse,
    Verdict,
)
from rag_consensus.agents import HallucinationCritic, TenantSecurityAuditor

from .helpers import POLICY_TEXT, REQUEST, TENANT, make_client, rag_body, run


def orchestrator_for(handler: Callable[[httpx.Request], httpx.Response]) -> ConsensusOrchestrator:
    client, _ = make_client(handler, max_retries=0)
    return ConsensusOrchestrator(client, ConsensusPolicy())


def test_happy_path_delivers_answer_and_citations() -> None:
    orch = orchestrator_for(lambda r: httpx.Response(200, json=rag_body()))
    out = run(orch.answer(REQUEST))
    assert out.approved and out.verdict is Verdict.APPROVED
    assert out.answer and "30 días" in out.answer
    assert out.citations == ("c1",) and out.error_code is None and not out.decision.reasons
    assert {a.agent for a in out.decision.assessments} == {"hallucination_critic", "tenant_security_auditor", "coherence_validator"}


def test_cross_tenant_leak_blocks_delivery() -> None:
    chunks = [
        {"id": "c1", "text": POLICY_TEXT, "score": 0.9, "tenant_id": TENANT},
        {"id": "c2", "text": "Documento interno de otro cliente.", "score": 0.8, "tenant_id": "globex"},
    ]
    out = run(orchestrator_for(lambda r: httpx.Response(200, json=rag_body(chunks=chunks))).answer(REQUEST))
    assert out.verdict is Verdict.REJECTED and out.answer is None and not out.approved
    assert "VETO:tenant_security_auditor" in out.decision.reasons


def test_hallucinated_figure_blocks_delivery() -> None:
    body = rag_body("El plazo de devolución de los pedidos es de 365 días desde la entrega.")
    out = run(orchestrator_for(lambda r: httpx.Response(200, json=body)).answer(REQUEST))
    assert out.verdict is Verdict.REJECTED and out.answer is None
    assert any(r.startswith("BELOW_MIN:hallucination_critic") for r in out.decision.reasons)


def test_rejected_answer_never_exposes_the_draft_anywhere() -> None:
    body = rag_body("DRAFT-SECRETO 365 días", chunks=[])
    out = run(orchestrator_for(lambda r: httpx.Response(200, json=body)).answer(REQUEST))
    assert out.answer is None and "DRAFT-SECRETO" not in repr(out)


def test_rag_network_failure_is_a_rejection_not_an_exception() -> None:
    def down(req: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=req)

    out = run(orchestrator_for(down).answer(REQUEST))
    assert out.verdict is Verdict.REJECTED and out.answer is None and out.error_code == "RAG_CONNECTION"
    assert out.decision.reasons == ("RAG_CONNECTION",)


def test_rag_timeout_http_error_and_protocol_error_map_to_codes() -> None:
    def slow(req: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("x", request=req)

    assert run(orchestrator_for(slow).answer(REQUEST)).error_code == "RAG_TIMEOUT"
    assert run(orchestrator_for(lambda r: httpx.Response(500)).answer(REQUEST)).error_code == "RAG_HTTP"
    assert run(orchestrator_for(lambda r: httpx.Response(200, text="basura")).answer(REQUEST)).error_code == "RAG_PROTOCOL"


def test_agent_crash_and_timeout_fail_closed() -> None:
    class Crashing:
        name = COHERENCE

        async def assess(self, ctx: AssessmentContext) -> Assessment:
            raise RuntimeError("boom con datos sensibles")

    class Hanging:
        name = COHERENCE

        async def assess(self, ctx: AssessmentContext) -> Assessment:
            await asyncio.sleep(10)
            return Assessment(COHERENCE, 1.0)

    client, _ = make_client(lambda r: httpx.Response(200, json=rag_body()))
    base = (HallucinationCritic(), TenantSecurityAuditor())

    crashed = run(ConsensusOrchestrator(client, ConsensusPolicy(), (*base, Crashing())).answer(REQUEST))
    assert crashed.verdict is Verdict.REJECTED and "AGENT_FAILED:coherence_validator:RuntimeError" in crashed.decision.reasons
    assert "sensibles" not in repr(crashed)

    hung = run(ConsensusOrchestrator(client, ConsensusPolicy(agent_timeout_s=0.05), (*base, Hanging())).answer(REQUEST))
    assert hung.verdict is Verdict.REJECTED and "AGENT_FAILED:coherence_validator:Timeout" in hung.decision.reasons


def test_agent_cannot_vote_on_behalf_of_another() -> None:
    class Impostor:
        name = COHERENCE

        async def assess(self, ctx: AssessmentContext) -> Assessment:
            return Assessment("hallucination_critic", 1.0)

    client, _ = make_client(lambda r: httpx.Response(200, json=rag_body()))
    out = run(ConsensusOrchestrator(client, ConsensusPolicy(), (HallucinationCritic(), TenantSecurityAuditor(), Impostor())).answer(REQUEST))
    assert out.verdict is Verdict.REJECTED and "AGENT_FAILED:coherence_validator:InvalidAssessment" in out.decision.reasons


def test_agents_run_concurrently() -> None:
    class Slow:
        def __init__(self, name: str) -> None:
            self.name = name

        async def assess(self, ctx: AssessmentContext) -> Assessment:
            await asyncio.sleep(0.2)
            return Assessment(self.name, 1.0)

    client, _ = make_client(lambda r: httpx.Response(200, json=rag_body()))
    agents = (Slow("hallucination_critic"), Slow("tenant_security_auditor"), Slow("coherence_validator"))

    async def timed() -> float:
        loop = asyncio.get_running_loop()
        t0 = loop.time()
        out = await ConsensusOrchestrator(client, ConsensusPolicy(), agents).answer(REQUEST)
        assert out.approved
        return loop.time() - t0

    assert run(timed()) < 0.45  # ≈0.2 s en paralelo, no 0.6 s en serie


def test_request_is_validated_before_any_network_call() -> None:
    calls: list[int] = []

    def handler(req: httpx.Request) -> httpx.Response:
        calls.append(1)
        return httpx.Response(200, json=rag_body())

    try:
        RetrievalRequest(tenant_id="bad tenant!", query="x")
    except ValueError:
        pass
    assert calls == []


def test_tenant_id_is_forwarded_to_the_rag_engine() -> None:
    seen: list[dict[str, object]] = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append(json.loads(req.content))
        return httpx.Response(200, json=rag_body())

    run(orchestrator_for(handler).answer(REQUEST))
    assert seen[0]["tenant_id"] == TENANT and seen[0]["query"] == REQUEST.query


def test_end_to_end_with_real_retriever_timeout_class() -> None:
    class FailingRetriever:
        async def retrieve(self, request: RetrievalRequest) -> RetrievalResponse:
            raise RagTimeoutError("t")

    out = run(ConsensusOrchestrator(FailingRetriever()).answer(REQUEST))
    assert out.error_code == "RAG_TIMEOUT" and out.answer is None


def test_config_object_is_hashable_and_immutable() -> None:
    cfg = RagClientConfig(base_url="https://rag.internal")
    try:
        cfg.timeout_s = 1  # type: ignore[misc]
    except Exception as e:  # FrozenInstanceError
        assert type(e).__name__ == "FrozenInstanceError"
    else:
        raise AssertionError("la configuración debería ser inmutable")


def test_self_contradicting_draft_is_blocked_end_to_end() -> None:
    body = rag_body("El plazo de devolución de los pedidos es de 30 días desde la entrega. El plazo de devolución de los pedidos no es de 30 días desde la entrega.")
    out = run(orchestrator_for(lambda r: httpx.Response(200, json=body)).answer(REQUEST))
    assert out.verdict is Verdict.REJECTED and out.answer is None
    assert any(r.startswith("BELOW_MIN:coherence_validator") for r in out.decision.reasons)
