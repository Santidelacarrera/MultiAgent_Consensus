"""Orquestador: RAG → comité de agentes → consenso fail-closed → entrega."""
from __future__ import annotations

import asyncio
import logging
import uuid
from dataclasses import dataclass
from typing import Sequence

from .audit import AuditSink, LoggingAuditSink, build_record
from .agents import AssessmentContext, CoherenceValidator, CommitteeAgent, HallucinationCritic, TenantSecurityAuditor
from .client import RetrievalPort
from .config import ConsensusPolicy
from .consensus import decide, rejected
from .errors import RagError, RagHttpError
from .models import AgentFailure, Assessment, ConsensusDecision, GuardedAnswer, RetrievalRequest, Verdict

log = logging.getLogger("rag_consensus.orchestrator")


@dataclass(frozen=True, slots=True)
class _Engine:
    """Datos de correlación con ContextRAG_Engine para la auditoría."""

    request_id: str | None = None
    error: str | None = None
    http_status: int | None = None


def default_committee(policy: ConsensusPolicy) -> tuple[CommitteeAgent, ...]:
    return (HallucinationCritic(), TenantSecurityAuditor(allow_untagged_chunks=policy.allow_untagged_chunks), CoherenceValidator())


class ConsensusOrchestrator:
    """Nunca devuelve el borrador salvo que el comité lo apruebe por unanimidad y sin vetos.

    Los errores del motor RAG (red, timeout, HTTP, protocolo) NO se propagan: producen un `GuardedAnswer` REJECTED
    con `error_code`, de modo que ningún llamador pueda entregar por descuido una respuesta sin validar.
    """

    def __init__(
        self,
        retriever: RetrievalPort,
        policy: ConsensusPolicy | None = None,
        agents: Sequence[CommitteeAgent] | None = None,
        audit: AuditSink | None = None,
    ) -> None:
        self._retriever = retriever
        self._audit: AuditSink = audit or LoggingAuditSink()
        self._policy = policy or ConsensusPolicy()
        self._agents: tuple[CommitteeAgent, ...] = tuple(agents) if agents is not None else default_committee(self._policy)

    async def answer(self, request: RetrievalRequest) -> GuardedAnswer:
        request_id = uuid.uuid4().hex
        try:
            response = await self._retriever.retrieve(request)
        except RagError as e:
            log.warning("request=%s tenant=%s rag=%s → REJECTED", request_id, request.tenant_id, e.code)
            decision = rejected(e.code)
            http = e if isinstance(e, RagHttpError) else None
            engine = _Engine(e.engine_request_id, http.engine_error if http else None, http.status_code if http else None)
            return self._finalize(request, request_id, decision, None, (), e.code, engine)

        ctx = AssessmentContext(request, response)
        results = await asyncio.gather(*(self._run(agent, ctx) for agent in self._agents))
        assessments = [r for r in results if isinstance(r, Assessment)]
        failures = [r for r in results if isinstance(r, AgentFailure)]
        decision = decide(assessments, failures, self._policy)
        approved = response.draft_answer if decision.verdict is Verdict.APPROVED else None
        return self._finalize(request, request_id, decision, approved, tuple(c.id for c in response.chunks), None, _Engine(response.engine_request_id))

    def _finalize(
        self,
        request: RetrievalRequest,
        request_id: str,
        decision: ConsensusDecision,
        answer: str | None,
        chunk_ids: tuple[str, ...],
        error_code: str | None,
        engine: "_Engine",
    ) -> GuardedAnswer:
        """Audita SIEMPRE antes de entregar: si no se puede dejar traza, no sale la respuesta (fail-closed)."""
        record = build_record(request_id=request_id, tenant_id=request.tenant_id, decision=decision, error_code=error_code, chunk_ids=chunk_ids,
            engine_request_id=engine.request_id, engine_error=engine.error, engine_http_status=engine.http_status,
        )
        try:
            self._audit.emit(record)
        except Exception as e:  # noqa: BLE001 — el destino de auditoría es externo
            log.error("request=%s tenant=%s audit sink falló (%s) → REJECTED", request_id, request.tenant_id, type(e).__name__)
            failed = ConsensusDecision(Verdict.REJECTED, decision.aggregate_score, decision.assessments, decision.failures, (*decision.reasons, "AUDIT_FAILED"))
            return GuardedAnswer(request_id, Verdict.REJECTED, None, failed, error_code="AUDIT_FAILED")
        log.info("request=%s tenant=%s verdict=%s score=%.2f", request_id, request.tenant_id, decision.verdict.value, decision.aggregate_score)
        if decision.verdict is not Verdict.APPROVED or answer is None:
            return GuardedAnswer(request_id, Verdict.REJECTED, None, decision, error_code=error_code)
        return GuardedAnswer(request_id, Verdict.APPROVED, answer, decision, citations=chunk_ids)

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
