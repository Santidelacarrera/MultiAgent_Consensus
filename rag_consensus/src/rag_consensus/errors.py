"""Jerarquía de errores del conector. Ningún mensaje incluye contenido de consultas, fragmentos ni credenciales."""
from __future__ import annotations


class RagConsensusError(Exception):
    """Base de todos los errores de este paquete."""


class RagError(RagConsensusError):
    """Fallo al obtener el contexto desde ContextRAG_Engine (siempre ⇒ el orquestador rechaza: fail-closed)."""

    code = "RAG_ERROR"


class RagConnectionError(RagError):
    """No se pudo establecer o mantener la conexión (DNS, TCP, TLS, reset)."""

    code = "RAG_CONNECTION"


class RagTimeoutError(RagError):
    """El motor RAG no respondió dentro del plazo (tras los reintentos configurados)."""

    code = "RAG_TIMEOUT"


class RagHttpError(RagError):
    """Respuesta HTTP no exitosa."""

    code = "RAG_HTTP"

    def __init__(self, status_code: int, message: str = "") -> None:
        super().__init__(f"HTTP {status_code}{': ' + message if message else ''}")
        self.status_code = status_code


class RagProtocolError(RagError):
    """La respuesta no cumple el contrato esperado (JSON inválido, tipos erróneos, campos ausentes, tamaño excesivo)."""

    code = "RAG_PROTOCOL"


class ConfigurationError(RagConsensusError):
    """Configuración insegura o inválida (se rechaza al construir, no en tiempo de ejecución)."""
