"""Confianza servicio-a-servicio con el edge-gateway de ShadowAPI_Guard.

El gateway firma lo que reenvía; este servicio SÓLO confía en el tenant si la firma verifica. Algoritmo idéntico al de
`edge_gateway.signing` (HMAC-SHA256 sobre tenant, request id, timestamp, método, ruta y SHA-256 del cuerpo); una prueba
de contrato lo comprueba contra la implementación del gateway cuando está disponible.
"""
from __future__ import annotations

import hashlib
import hmac
import time
from collections.abc import Mapping

from ..models import TENANT_RE

HEADER_SIGNATURE = "x-guard-signature"
HEADER_TIMESTAMP = "x-guard-timestamp"
HEADER_TENANT = "x-tenant-id"
HEADER_REQUEST_ID = "x-request-id"
SIGNATURE_PREFIX = "v1="
MAX_SKEW_SECONDS = 60
MIN_KEY_BYTES = 32


def canonical(tenant: str, request_id: str, timestamp: str, method: str, path: str, body_sha256: str) -> bytes:
    return "\n".join((tenant, request_id, timestamp, method.upper(), path, body_sha256)).encode()


def sign(key: bytes, tenant: str, request_id: str, timestamp: str, method: str, path: str, body: bytes) -> str:
    sha = hashlib.sha256(body).hexdigest()
    return SIGNATURE_PREFIX + hmac.new(key, canonical(tenant, request_id, timestamp, method, path, sha), hashlib.sha256).hexdigest()


class GuardIdentity:
    """Resultado de una verificación correcta."""

    __slots__ = ("tenant", "request_id", "timestamp")

    def __init__(self, tenant: str, request_id: str, timestamp: int) -> None:
        self.tenant, self.request_id, self.timestamp = tenant, request_id, timestamp


def verify(
    headers: Mapping[str, str],
    method: str,
    path: str,
    body: bytes,
    key: bytes,
    *,
    max_skew_seconds: int = MAX_SKEW_SECONDS,
    now: float | None = None,
) -> GuardIdentity | None:
    """Devuelve la identidad verificada o None (no vino del guard, fue manipulada o está fuera de la ventana de reloj)."""
    h = {k.lower(): v for k, v in headers.items()}
    tenant, rid = h.get(HEADER_TENANT), h.get(HEADER_REQUEST_ID)
    ts, sig = h.get(HEADER_TIMESTAMP), h.get(HEADER_SIGNATURE)
    if not (tenant and rid and ts and sig and sig.startswith(SIGNATURE_PREFIX)):
        return None
    if not TENANT_RE.fullmatch(tenant) or len(rid) > 128:
        return None
    try:
        stamp = int(ts)
    except ValueError:
        return None
    if abs((time.time() if now is None else now) - stamp) > max_skew_seconds:
        return None
    expected = hmac.new(key, canonical(tenant, rid, ts, method, path, hashlib.sha256(body).hexdigest()), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(sig[len(SIGNATURE_PREFIX):], expected):
        return None
    return GuardIdentity(tenant, rid, stamp)
