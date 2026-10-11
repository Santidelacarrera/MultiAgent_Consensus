from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from ..models import Assessment, RetrievalRequest, RetrievalResponse


@dataclass(frozen=True, slots=True)
class AssessmentContext:
    """Todo lo que ve un agente: la petición original y lo que devolvió el motor RAG."""

    request: RetrievalRequest
    response: RetrievalResponse


class CommitteeAgent(Protocol):
    """Un miembro del comité: sin efectos laterales, puntuación en [0, 1]."""

    name: str

    async def assess(self, ctx: AssessmentContext) -> Assessment: ...
