"""Modelos inmutables del dominio. Toda validación ocurre al construir (fail-fast)."""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from enum import Enum
from typing import Mapping

TENANT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:\-]{0,127}$")
MAX_QUERY_CHARS = 4_000

MAX_TOP_K = 20  # límite del servicio (ContextRAG_Engine: 1 ≤ top_k ≤ 20)

#: Texto propio (no del motor) que se entrega cuando el motor no encontró respuesta; el comité lo valida como abstención.
NO_ANSWER_TEXT = "No se encontró información suficiente en las fuentes para responder a esta consulta."


class Verdict(str, Enum):
    APPROVED = "APPROVED"
    REJECTED = "REJECTED"


class Severity(str, Enum):
    INFO = "info"
    WARNING = "warning"
    CRITICAL = "critical"


@dataclass(frozen=True, slots=True)
class RetrievalRequest:
    """Petición al motor de recuperación (el servicio rechaza campos desconocidos: sólo se envían estos tres)."""

    tenant_id: str
    query: str
    top_k: int = 5

    def __post_init__(self) -> None:
        if not TENANT_RE.fullmatch(self.tenant_id):
            raise ValueError("tenant_id inválido (1-128 caracteres alfanuméricos, '_', '.', ':' o '-')")
        if not self.query.strip():
            raise ValueError("query vacía")
        if len(self.query) > MAX_QUERY_CHARS:
            raise ValueError(f"query demasiado larga (máx. {MAX_QUERY_CHARS})")
        if not 1 <= self.top_k <= MAX_TOP_K:
            raise ValueError(f"top_k debe estar entre 1 y {MAX_TOP_K}")

    def to_payload(self) -> dict[str, object]:
        return {"tenant_id": self.tenant_id, "query": self.query, "top_k": self.top_k}


@dataclass(frozen=True, slots=True)
class Chunk:
    """Fragmento crudo devuelto por el motor RAG."""

    id: str
    text: str
    score: float
    tenant_id: str | None
    source: str | None = None
    metadata: Mapping[str, object] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class RetrievalResponse:
    """Borrador de respuesta + fragmentos crudos."""

    draft_answer: str
    chunks: tuple[Chunk, ...]
    tenant_id: str | None = None
    #: 'ok' | 'no_results' (según el servicio)
    status: str = "ok"
    #: True si el motor no aportó borrador (`draft_answer: null`) y se sustituyó por NO_ANSWER_TEXT.
    synthesized_abstention: bool = False


@dataclass(frozen=True, slots=True)
class Finding:
    code: str
    message: str
    severity: Severity = Severity.INFO


@dataclass(frozen=True, slots=True)
class Assessment:
    """Dictamen de un agente. `veto=True` rechaza el conjunto con independencia de las puntuaciones."""

    agent: str
    score: float
    veto: bool = False
    findings: tuple[Finding, ...] = ()


@dataclass(frozen=True, slots=True)
class AgentFailure:
    agent: str
    error_type: str


@dataclass(frozen=True, slots=True)
class ConsensusDecision:
    verdict: Verdict
    aggregate_score: float
    assessments: tuple[Assessment, ...]
    failures: tuple[AgentFailure, ...]
    reasons: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class GuardedAnswer:
    """Resultado entregable. `answer` es None salvo que el veredicto sea APPROVED (el borrador rechazado nunca sale)."""

    request_id: str
    verdict: Verdict
    answer: str | None
    decision: ConsensusDecision
    citations: tuple[str, ...] = ()
    error_code: str | None = None

    @property
    def approved(self) -> bool:
        return self.verdict is Verdict.APPROVED and self.answer is not None
