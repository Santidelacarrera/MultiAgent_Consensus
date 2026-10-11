"""Modelos inmutables del dominio. Toda validación ocurre al construir (fail-fast)."""
from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from enum import Enum
from types import MappingProxyType
from typing import Mapping

TENANT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:\-]{0,127}$")
MAX_QUERY_CHARS = 4_000

FilterValue = str | int | float | bool


class Verdict(str, Enum):
    APPROVED = "APPROVED"
    REJECTED = "REJECTED"


class Severity(str, Enum):
    INFO = "info"
    WARNING = "warning"
    CRITICAL = "critical"


@dataclass(frozen=True, slots=True)
class RetrievalRequest:
    """Petición al motor de recuperación."""

    tenant_id: str
    query: str
    top_k: int = 5
    filters: Mapping[str, FilterValue] = field(default_factory=dict)
    min_score: float | None = None

    def __post_init__(self) -> None:
        if not TENANT_RE.fullmatch(self.tenant_id):
            raise ValueError("tenant_id inválido (1-128 caracteres alfanuméricos, '_', '.', ':' o '-')")
        if not self.query.strip():
            raise ValueError("query vacía")
        if len(self.query) > MAX_QUERY_CHARS:
            raise ValueError(f"query demasiado larga (máx. {MAX_QUERY_CHARS})")
        if not 1 <= self.top_k <= 50:
            raise ValueError("top_k debe estar entre 1 y 50")
        if self.min_score is not None and not (math.isfinite(self.min_score) and 0.0 <= self.min_score <= 1.0):
            raise ValueError("min_score debe estar entre 0 y 1")
        object.__setattr__(self, "filters", MappingProxyType(dict(self.filters)))

    def to_payload(self) -> dict[str, object]:
        payload: dict[str, object] = {"tenant_id": self.tenant_id, "query": self.query, "top_k": self.top_k}
        if self.filters:
            payload["filters"] = dict(self.filters)
        if self.min_score is not None:
            payload["min_score"] = self.min_score
        return payload


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
