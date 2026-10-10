"""Configuración del gatekeeper a partir de variables de entorno."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Mapping


def _bool(v: str | None, default: bool) -> bool:
    if v is None or v == "":
        return default
    return v.strip().lower() in {"1", "true", "yes", "on"}


def _csv(v: str | None) -> tuple[str, ...]:
    return tuple(x.strip().lower() for x in (v or "").split(",") if x.strip())


@dataclass(frozen=True)
class Settings:
    orchestrator_url: str = "http://localhost:3000"
    orchestrator_api_key: str | None = None
    #: URL pública del orquestador para enlazar la minuta desde el estado del commit (opcional).
    orchestrator_public_url: str | None = None

    github_token: str | None = None
    github_webhook_secret: str | None = None
    github_api_url: str = "https://api.github.com"

    gitlab_token: str | None = None
    gitlab_webhook_token: str | None = None
    gitlab_api_url: str = "https://gitlab.com/api/v4"

    status_context: str = "multiagent-consensus"
    #: Fusiona automáticamente cuando el veredicto es APPROVED.
    auto_merge: bool = False
    merge_method: str = "squash"
    #: Publica una revisión "request changes" en GitHub cuando el veredicto es REJECTED.
    request_changes: bool = False
    #: Usuarios autorizados a resolver escalados (minúsculas). Vacío = cualquiera con permiso de escritura.
    senior_reviewers: tuple[str, ...] = field(default_factory=tuple)
    #: Tiempo máximo esperando el debate (s).
    debate_timeout_s: float = 900.0
    poll_wait_ms: int = 25_000
    http_timeout_s: float = 60.0

    @staticmethod
    def from_env(env: Mapping[str, str]) -> "Settings":
        g = env.get
        return Settings(
            orchestrator_url=(g("ORCHESTRATOR_URL") or "http://localhost:3000").rstrip("/"),
            orchestrator_api_key=g("ORCHESTRATOR_API_KEY") or None,
            orchestrator_public_url=(g("ORCHESTRATOR_PUBLIC_URL") or None),
            github_token=g("GITHUB_TOKEN") or None,
            github_webhook_secret=g("GITHUB_WEBHOOK_SECRET") or None,
            github_api_url=(g("GITHUB_API_URL") or "https://api.github.com").rstrip("/"),
            gitlab_token=g("GITLAB_TOKEN") or None,
            gitlab_webhook_token=g("GITLAB_WEBHOOK_TOKEN") or None,
            gitlab_api_url=(g("GITLAB_API_URL") or "https://gitlab.com/api/v4").rstrip("/"),
            status_context=g("STATUS_CONTEXT") or "multiagent-consensus",
            auto_merge=_bool(g("GATEKEEPER_AUTO_MERGE"), False),
            merge_method=g("GATEKEEPER_MERGE_METHOD") or "squash",
            request_changes=_bool(g("GATEKEEPER_REQUEST_CHANGES"), False),
            senior_reviewers=_csv(g("GATEKEEPER_SENIOR_REVIEWERS")),
            debate_timeout_s=float(g("DEBATE_TIMEOUT_S") or 900),
            poll_wait_ms=int(g("POLL_WAIT_MS") or 25_000),
            http_timeout_s=float(g("HTTP_TIMEOUT_S") or 60),
        )
