from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class PrRef:
    """Referencia a un PR/MR independiente de la plataforma."""

    provider: str  # 'github' | 'gitlab'
    repo: str  # owner/name  |  group/project
    number: int
    head_sha: str = ""
    title: str = ""
    author: str = ""
    base_branch: str = ""
    description: str = ""
    labels: tuple[str, ...] = field(default_factory=tuple)
    #: Identificador numérico de proyecto (GitLab).
    project_id: int | None = None

    @property
    def pr_id(self) -> str:
        return f"{self.provider}:{self.repo}#{self.number}"


@dataclass(frozen=True)
class Verdict:
    """Veredicto final emitido por el gatekeeper."""

    #: Estado del check: success | failure | pending | error
    state: str
    description: str
    #: Si es seguro fusionar automáticamente (sólo APPROVED / resolución humana de aprobación).
    mergeable: bool = False
    #: Si hay que bloquear activamente (request changes).
    blocking: bool = False
