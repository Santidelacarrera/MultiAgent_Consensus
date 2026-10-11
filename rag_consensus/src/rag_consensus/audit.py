"""Auditoría de cada decisión del comité. Los registros llevan identificadores, códigos y números; NUNCA contenido
(ni consulta, ni borrador, ni fragmentos), para poder conservarlos sin ampliar la superficie de datos sensibles."""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Protocol

from .models import ConsensusDecision, Verdict


@dataclass(frozen=True, slots=True)
class AgentAudit:
    agent: str
    score: float
    veto: bool
    finding_codes: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class AuditRecord:
    request_id: str
    tenant_id: str
    verdict: Verdict
    aggregate_score: float
    agents: tuple[AgentAudit, ...]
    reasons: tuple[str, ...]
    error_code: str | None
    chunk_count: int
    chunk_ids: tuple[str, ...]
    timestamp: str
    #: Correlación con ContextRAG_Engine: `X-Request-Id` de su respuesta y, si falló, su código de error / estado HTTP.
    engine_request_id: str | None = None
    engine_error: str | None = None
    engine_http_status: int | None = None

    def to_json(self) -> str:
        return json.dumps(
            {
                "event": "rag_consensus.decision",
                "request_id": self.request_id,
                "tenant_id": self.tenant_id,
                "verdict": self.verdict.value,
                "aggregate_score": self.aggregate_score,
                "agents": [{"agent": a.agent, "score": a.score, "veto": a.veto, "findings": list(a.finding_codes)} for a in self.agents],
                "reasons": list(self.reasons),
                "error_code": self.error_code,
                "chunk_count": self.chunk_count,
                "chunk_ids": list(self.chunk_ids),
                "timestamp": self.timestamp,
                "engine": {"request_id": self.engine_request_id, "error": self.engine_error, "http_status": self.engine_http_status},
            },
            ensure_ascii=False,
            separators=(",", ":"),
        )


def build_record(
    *,
    request_id: str,
    tenant_id: str,
    decision: ConsensusDecision,
    error_code: str | None,
    chunk_ids: tuple[str, ...],
    engine_request_id: str | None = None,
    engine_error: str | None = None,
    engine_http_status: int | None = None,
) -> AuditRecord:
    return AuditRecord(
        request_id=request_id,
        tenant_id=tenant_id,
        verdict=decision.verdict,
        aggregate_score=decision.aggregate_score,
        agents=tuple(AgentAudit(a.agent, a.score, a.veto, tuple(f.code for f in a.findings)) for a in decision.assessments),
        reasons=decision.reasons,
        error_code=error_code,
        chunk_count=len(chunk_ids),
        chunk_ids=chunk_ids[:50],
        timestamp=datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
        engine_request_id=engine_request_id,
        engine_error=engine_error,
        engine_http_status=engine_http_status,
    )


class AuditSink(Protocol):
    """Destino de auditoría. Si `emit` lanza, el orquestador retiene la respuesta (no se entrega nada sin traza)."""

    def emit(self, record: AuditRecord) -> None: ...


class LoggingAuditSink:
    """Una línea JSON por decisión en el logger `rag_consensus.audit` (recogible por cualquier agregador de logs)."""

    def __init__(self, logger: logging.Logger | None = None) -> None:
        self._log = logger or logging.getLogger("rag_consensus.audit")

    def emit(self, record: AuditRecord) -> None:
        self._log.info(record.to_json())


class InMemoryAuditSink:
    def __init__(self) -> None:
        self.records: list[AuditRecord] = []

    def emit(self, record: AuditRecord) -> None:
        self.records.append(record)
