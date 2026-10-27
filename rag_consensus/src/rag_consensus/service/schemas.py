"""Esquemas de entrada. `extra="forbid"` + `strict`: un campo desconocido es una anomalía, no se ignora."""
from __future__ import annotations

from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

Identifier = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9_.-]{1,64}$")]
UUIDStr = Annotated[str, StringConstraints(pattern=r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")]
Scalar = str | int | float | bool


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class RagQueryIn(_Strict):
    """Idéntico al `RagQuery` del edge-gateway (el contrato público)."""

    query: Annotated[str, StringConstraints(min_length=1, max_length=4000)]
    top_k: Annotated[int, Field(ge=1, le=50)] = 5
    filters: dict[Identifier, Annotated[str, StringConstraints(max_length=256)] | int | bool] = {}
    conversation_id: UUIDStr | None = None


class ConsensusRunIn(_Strict):
    """Idéntico al `ConsensusRun` del edge-gateway."""

    task: Annotated[str, StringConstraints(min_length=1, max_length=8000)]
    agents: Annotated[list[Identifier], Field(max_length=10)] = []
    max_rounds: Annotated[int, Field(ge=1, le=10)] = 3
    context: dict[Identifier, Annotated[str, StringConstraints(max_length=2000)] | int | float | bool] = {}


class Passage(BaseModel):
    """Fragmento tal y como lo devuelve ContextRAG_Engine (`fragments[]`); se ignoran campos desconocidos."""

    model_config = ConfigDict(extra="ignore")

    text: Annotated[str, StringConstraints(max_length=100_000)]
    index: Annotated[int, Field(ge=1)] | None = None
    doc_id: Annotated[str, StringConstraints(max_length=512)] | None = None
    source: Annotated[str, StringConstraints(max_length=512)] | None = None
    section: Annotated[str, StringConstraints(max_length=512)] | None = None
    score: float = 0.0
    tenant_id: Annotated[str, StringConstraints(max_length=128)] | None = None


class ReviewIn(BaseModel):
    """Contrato de NexusFlow (`HttpConsensus`): revisar un borrador ya generado frente a sus pasajes."""

    model_config = ConfigDict(extra="forbid")

    question: Annotated[str, StringConstraints(min_length=1, max_length=4000)]
    draft_answer: Annotated[str, StringConstraints(max_length=50_000)]
    passages: Annotated[list[Passage], Field(max_length=50)]
