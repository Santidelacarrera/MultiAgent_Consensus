"""Política de veredicto: reglas del gatekeeper sobre el resultado del orquestador.

El gatekeeper NO confía ciegamente en el orquestador: revalida el resultado
(defensa en profundidad) y falla cerrado ante cualquier inconsistencia.
"""
from __future__ import annotations

from typing import Any

from .models import Verdict


def _short(text: str, limit: int = 140) -> str:
    """Los estados de commit admiten ~140 caracteres."""
    text = " ".join(text.split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def decide(view: dict[str, Any]) -> Verdict:
    status = view.get("status")
    summary = view.get("summary") or {}

    if status == "running":
        return Verdict("pending", "Debate multi-agente en curso…")
    if status == "error":
        return Verdict("error", _short(f"Error del orquestador: {view.get('reason') or 'desconocido'}. Falla cerrado."))

    if status == "approved":
        problems = _inconsistencies(summary)
        if problems:
            return Verdict("failure", _short(f"Aprobación inconsistente, se bloquea: {problems[0]}"), blocking=True)
        n = len(summary.get("conditions") or [])
        return Verdict("success", _short(f"Consenso alcanzado{f' con {n} condición(es)' if n else ''}. {view.get('reason') or ''}"), mergeable=True)

    if status == "resolved_approved":
        res = summary.get("resolution") or {}
        return Verdict("success", _short(f"Aprobado por {res.get('reviewer', 'ingeniero senior')} tras escalado."), mergeable=True)

    if status == "rejected":
        return Verdict("failure", _short(f"Rechazado por consenso. {view.get('reason') or ''}"), blocking=True)

    if status == "resolved_rejected":
        res = summary.get("resolution") or {}
        return Verdict("failure", _short(f"Rechazado por {res.get('reviewer', 'ingeniero senior')} tras escalado."), blocking=True)

    if status == "escalated":
        return Verdict("pending", "Sin consenso: esperando decisión de un ingeniero senior (/consensus approve|reject <motivo>).")

    return Verdict("error", _short(f"Estado desconocido '{status}'. Falla cerrado."))


def _inconsistencies(summary: dict[str, Any]) -> list[str]:
    """Una aprobación válida exige: sin vetos críticos, sin disenso bloqueante y quórum de aprobación."""
    problems: list[str] = []
    if summary.get("hardBlockers"):
        problems.append("existen hallazgos críticos sin resolver")
    if summary.get("blockingDissent"):
        problems.append("hay disenso bloqueante")
    approvals, quorum = summary.get("approvals"), summary.get("quorum")
    if approvals is None or quorum is None:
        problems.append("faltan datos de quórum")
    elif approvals < quorum:
        problems.append(f"quórum no alcanzado ({approvals}/{quorum})")
    return problems


COMMAND_PREFIX = "/consensus"


def parse_command(body: str) -> tuple[str, str] | None:
    """Interpreta `/consensus approve|reject <motivo>`. Devuelve (decisión, motivo) o None."""
    for line in (body or "").splitlines():
        line = line.strip()
        if not line.lower().startswith(COMMAND_PREFIX):
            continue
        parts = line[len(COMMAND_PREFIX):].strip().split(None, 1)
        if not parts or parts[0].lower() not in {"approve", "reject"}:
            return None
        rationale = parts[1].strip() if len(parts) > 1 else ""
        return parts[0].lower(), rationale
    return None
