"""Orquestador: RAG → comité de agentes → consenso fail-closed → entrega."""
from __future__ import annotations

import asyncio
import logging
import uuid
from typing import Sequence

from .agents import AssessmentContext, CoherenceValidator, CommitteeAgent, HallucinationCritic, TenantSecurityAuditor
from .client import RetrievalPort
from .config import ConsensusPolicy
from .consensus import decide, rejected
from .errors import RagError
from .models import AgentFailure, Assessment, GuardedAnswer, RetrievalRequest, Verdict

log = logging.getLogger("rag_consensus.orchestrator")


def default_committee(policy: ConsensusPolicy) -> tuple[CommitteeAgent, ...]:
    return (HallucinationCritic(), TenantSecurityAuditor(allow_untagged_chunks=policy.allow_untagged_chunks), CoherenceValidator())


class ConsensusOrchestrator:
    """Nunca devuelve el borrador salvo que el comité lo apruebe por unanimidad y sin vetos.

    Los errores del motor RAG (red, timeout, HTTP, protocolo) NO se propagan: producen un `GuardedAnswer` REJECTED
    con `error_code`, de modo que ningún llamador pueda entregar por descuido una respuesta sin validar.
    """

    def __init__(self, retriever: RetrievalPort, policy: ConsensusPolicy | None = None, agents: Sequence[CommitteeAgent] | None = None) -> None:
        self._retriever = retriever
        self._policy = policy or ConsensusPolicy()
        self._agents: tuple[CommitteeAgent, ...] = tuple(agents) if agents is not None else default_committee(self._policy)

    async def answer(self, request: RetrievalRequest) -> GuardedAnswer:
        request_id = uuid.uuid4().hex
        try:
            response = await self._retriever.retrieve(request)
        except RagError as e:
            log.warning("request=%s rag=%s → REJECTED", request_id, e.code)
            return GuardedAnswer(request_id, Verdict.REJECTED, None, rejected(e.code), error_code=e.code)

        ctx = AssessmentContext(request, response)
        results = await asyncio.gather(*(self._run(agent, ctx) for agent in self._agents))
        assessments = [r for r in results if isinstance(r, Assessment)]
        failures = [r for r in results if isinstance(r, AgentFailure)]
        decision = decide(assessments, failures, self._policy)

        log.info("request=%s verdict=%s score=%.2f reasons=%s", request_id, decision.verdict.value, decision.aggregate_score, ",".join(decision.reasons) or "-")
        if decision.verdict is not Verdict.APPROVED:
            return GuardedAnswer(request_id, Verdict.REJECTED, None, decision)
        return GuardedAnswer(request_id, Verdict.APPROVED, response.draft_answer, decision, citations=tuple(c.id for c in response.chunks))

    async def _run(self, agent: CommitteeAgent, ctx: AssessmentContext) -> Assessment | AgentFailure:
        try:
            result = await asyncio.wait_for(agent.assess(ctx), timeout=self._policy.agent_timeout_s)
        except asyncio.TimeoutError:
            return AgentFailure(agent.name, "Timeout")
        except Exception as e:  # noqa: BLE001 — frontera: un agente defectuoso debe rechazar, no tumbar al orquestador
            return AgentFailure(agent.name, type(e).__name__)
        if not isinstance(result, Assessment) or result.agent != agent.name:
            return AgentFailure(agent.name, "InvalidAssessment")  # un agente no puede votar en nombre de otro
        return result
