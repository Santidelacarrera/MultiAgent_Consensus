from __future__ import annotations

import math
from dataclasses import dataclass, field
from types import MappingProxyType
from typing import Mapping
from urllib.parse import urlsplit

from .errors import ConfigurationError

HALLUCINATION = "hallucination_critic"
TENANT_SECURITY = "tenant_security_auditor"
COHERENCE = "coherence_validator"
AGENT_NAMES: tuple[str, ...] = (HALLUCINATION, TENANT_SECURITY, COHERENCE)

_LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}


@dataclass(frozen=True, slots=True)
class RagClientConfig:
    """Configuración del cliente HTTP. HTTPS es obligatorio salvo loopback o `allow_insecure_http=True`."""

    base_url: str
    retrieve_path: str = "/v1/retrieve"
    api_key: str | None = field(default=None, repr=False)  # nunca aparece en repr/logs
    timeout_s: float = 10.0
    max_retries: int = 2
    backoff_s: float = 0.2
    max_response_bytes: int = 2_000_000
    verify_tls: bool = True
    allow_insecure_http: bool = False

    def __post_init__(self) -> None:
        parts = urlsplit(self.base_url)
        if parts.scheme not in {"http", "https"} or not parts.hostname:
            raise ConfigurationError("base_url debe ser una URL http(s) válida")
        if parts.username or parts.password:
            raise ConfigurationError("base_url no debe incluir credenciales")
        if parts.scheme == "http" and parts.hostname not in _LOCAL_HOSTS and not self.allow_insecure_http:
            raise ConfigurationError("HTTP sin TLS sólo se admite en loopback (o allow_insecure_http=True)")
        if not self.retrieve_path.startswith("/"):
            raise ConfigurationError("retrieve_path debe empezar por '/'")
        if not (math.isfinite(self.timeout_s) and self.timeout_s > 0):
            raise ConfigurationError("timeout_s debe ser > 0")
        if not 0 <= self.max_retries <= 5:
            raise ConfigurationError("max_retries debe estar entre 0 y 5")
        if self.backoff_s < 0 or self.max_response_bytes <= 0:
            raise ConfigurationError("backoff_s / max_response_bytes inválidos")
        if not self.verify_tls and parts.scheme == "https" and parts.hostname not in _LOCAL_HOSTS:
            raise ConfigurationError("verify_tls=False sólo se admite en loopback")

    @property
    def url(self) -> str:
        return self.base_url.rstrip("/") + self.retrieve_path


def _default_min_scores() -> Mapping[str, float]:
    return MappingProxyType({HALLUCINATION: 0.75, TENANT_SECURITY: 0.90, COHERENCE: 0.60})


def _default_weights() -> Mapping[str, float]:
    return MappingProxyType({HALLUCINATION: 0.40, TENANT_SECURITY: 0.35, COHERENCE: 0.25})


@dataclass(frozen=True, slots=True)
class ConsensusPolicy:
    """Política de consenso. Es estricta por diseño: unanimidad + sin vetos + agregado mínimo."""

    min_scores: Mapping[str, float] = field(default_factory=_default_min_scores)
    weights: Mapping[str, float] = field(default_factory=_default_weights)
    aggregate_threshold: float = 0.80
    agent_timeout_s: float = 5.0
    required_agents: tuple[str, ...] = AGENT_NAMES
    #: Si False (por defecto) un fragmento sin `tenant_id` no puede verificarse y se trata como fuga potencial.
    allow_untagged_chunks: bool = False

    def __post_init__(self) -> None:
        for name in self.required_agents:
            if name not in self.min_scores or name not in self.weights:
                raise ConfigurationError(f"falta umbral o peso para el agente '{name}'")
        for v in (*self.min_scores.values(), *self.weights.values(), self.aggregate_threshold):
            if not (math.isfinite(v) and 0.0 <= v <= 1.0):
                raise ConfigurationError("umbrales y pesos deben estar en [0, 1]")
        if sum(self.weights[n] for n in self.required_agents) <= 0:
            raise ConfigurationError("la suma de pesos debe ser > 0")
        if self.agent_timeout_s <= 0:
            raise ConfigurationError("agent_timeout_s debe ser > 0")
