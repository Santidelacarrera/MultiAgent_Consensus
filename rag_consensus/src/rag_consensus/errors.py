"""Jerarquía de errores del conector. Ningún mensaje incluye contenido de consultas, fragmentos ni credenciales."""
from __future__ import annotations


class RagConsensusError(Exception):
    """Base de todos los errores de este paquete."""


class RagError(RagConsensusError):
    """Fallo al obtener el contexto desde ContextRAG_Engine (siempre ⇒ el orquestador rechaza: fail-closed)."""

    code = "RAG_ERROR"

    #: `X-Request-Id` que el motor devolvió (si lo hizo): permite cruzar esta traza con sus logs.
    engine_request_id: str | None = None


class RagConnectionError(RagError):
    """No se pudo establecer o mantener la conexión (DNS, TCP, TLS, reset)."""

    code = "RAG_CONNECTION"


class RagTimeoutError(RagError):
    """El motor RAG no respondió dentro del plazo (tras los reintentos configurados)."""

    code = "RAG_TIMEOUT"


class RagHttpError(RagError):
    """Respuesta HTTP no exitosa."""

    code = "RAG_HTTP"

    def __init__(self, status_code: int, message: str = "", *, engine_request_id: str | None = None, engine_error: str | None = None) -> None:
        super().__init__(f"HTTP {status_code}{': ' + message if message else ''}")
        self.status_code = status_code
        self.engine_request_id = engine_request_id
        #: Código de error del motor (`database_unavailable`, `tenant_not_authorized`…), sólo si es un identificador seguro.
        self.engine_error = engine_error


class RagProtocolError(RagError):
    """La respuesta no cumple el contrato esperado (JSON inválido, tipos erróneos, campos ausentes, tamaño excesivo)."""

    code = "RAG_PROTOCOL"


class ConfigurationError(RagConsensusError):
    """Configuración insegura o inválida (se rechaza al construir, no en tiempo de ejecución)."""
