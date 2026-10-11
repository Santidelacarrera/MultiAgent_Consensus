from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass, field

from ..config import ConsensusPolicy
from ..errors import ConfigurationError
from ..models import TENANT_RE
from .guard import MIN_KEY_BYTES


@dataclass(frozen=True, slots=True)
class ServiceSettings:
    guard_signing_key: bytes = field(repr=False)
    contextrag_url: str
    #: tenant → API key de ContextRAG_Engine (cada clave está ligada a ese tenant en el motor)
    tenant_rag_keys: Mapping[str, str] = field(repr=False, default_factory=dict)
    contextrag_allow_insecure_http: bool = False
    contextrag_timeout_s: float = 15.0
    #: token de servicio para llamadas internas (NexusFlow → /v1/consensus); vacío = ruta deshabilitada
    service_token: str | None = field(repr=False, default=None)
    redis_url: str | None = field(repr=False, default=None)
    run_ttl_s: int = 3600
    max_body_bytes: int = 64 * 1024
    policy: ConsensusPolicy = field(default_factory=ConsensusPolicy)

    @staticmethod
    def from_env(env: Mapping[str, str]) -> "ServiceSettings":
        key = env.get("GUARD_SIGNING_KEY", "").encode()
        if len(key) < MIN_KEY_BYTES:
            raise ConfigurationError(f"GUARD_SIGNING_KEY es obligatoria y debe tener ≥ {MIN_KEY_BYTES} bytes")
        url = env.get("CONTEXTRAG_URL", "").strip()
        if not url:
            raise ConfigurationError("CONTEXTRAG_URL es obligatoria")
        try:
            keys = json.loads(env.get("CONTEXTRAG_TENANT_KEYS_JSON", "") or "{}")
        except ValueError as e:
            raise ConfigurationError("CONTEXTRAG_TENANT_KEYS_JSON no es JSON válido") from e
        if not isinstance(keys, dict) or not all(isinstance(k, str) and TENANT_RE.fullmatch(k) and isinstance(v, str) and v for k, v in keys.items()):
            raise ConfigurationError("CONTEXTRAG_TENANT_KEYS_JSON debe ser {tenant: api_key}")
        if not keys:
            raise ConfigurationError("CONTEXTRAG_TENANT_KEYS_JSON está vacío: ningún tenant podría consultar el motor")
        token = env.get("SERVICE_TOKEN") or None
        if token is not None and len(token) < 24:
            raise ConfigurationError("SERVICE_TOKEN debe tener ≥ 24 caracteres")
        return ServiceSettings(
            guard_signing_key=key,
            contextrag_url=url,
            tenant_rag_keys=dict(keys),
            contextrag_allow_insecure_http=env.get("CONTEXTRAG_ALLOW_INSECURE_HTTP", "false").lower() == "true",
            contextrag_timeout_s=float(env.get("CONTEXTRAG_TIMEOUT_S", "15")),
            service_token=token,
            redis_url=env.get("REDIS_URL") or None,
            run_ttl_s=int(env.get("RUN_TTL_SECONDS", "3600")),
        )
