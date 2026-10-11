"""Mecanismo de consenso fail-closed.

APPROVED exige TODAS estas condiciones; en cualquier otro caso (incluida la duda) el veredicto es REJECTED:

 1. respondieron todos los agentes requeridos (un fallo, timeout o ausencia ⇒ rechazo);
 2. cada puntuación es un número finito en [0, 1] (NaN/∞/fuera de rango ⇒ rechazo);
 3. ningún agente emitió veto;
 4. cada agente alcanza su puntuación mínima (unanimidad);
 5. la media ponderada alcanza `aggregate_threshold`.
"""
from __future__ import annotations

import math
from typing import Sequence

from .config import ConsensusPolicy
from .models import AgentFailure, Assessment, ConsensusDecision, Verdict


def decide(
    assessments: Sequence[Assessment],
    failures: Sequence[AgentFailure],
    policy: ConsensusPolicy,
) -> ConsensusDecision:
    reasons: list[str] = []
    by_agent: dict[str, Assessment] = {}

    for a in assessments:
        if a.agent in by_agent:
            reasons.append(f"DUPLICATE_ASSESSMENT:{a.agent}")  # un agente no puede votar dos veces
        by_agent.setdefault(a.agent, a)

    for f in failures:
        reasons.append(f"AGENT_FAILED:{f.agent}:{f.error_type}")
    for name in policy.required_agents:
        if name not in by_agent and not any(f.agent == name for f in failures):
            reasons.append(f"AGENT_MISSING:{name}")

    valid: dict[str, Assessment] = {}
    for name in policy.required_agents:
        candidate = by_agent.get(name)
        if candidate is None:
            continue
        score = candidate.score
        if isinstance(score, bool) or not isinstance(score, (int, float)) or not math.isfinite(score) or not 0.0 <= score <= 1.0:
            reasons.append(f"INVALID_SCORE:{name}")
            continue
        valid[name] = candidate

    for name, a in valid.items():
        if a.veto:
            reasons.append(f"VETO:{name}")
        if a.score < policy.min_scores[name]:
            reasons.append(f"BELOW_MIN:{name}:{a.score:.2f}<{policy.min_scores[name]:.2f}")

    total_weight = sum(policy.weights[n] for n in policy.required_agents)
    aggregate = sum(policy.weights[n] * valid[n].score for n in valid) / total_weight if total_weight else 0.0
    if len(valid) == len(policy.required_agents) and aggregate < policy.aggregate_threshold:
        reasons.append(f"BELOW_AGGREGATE:{aggregate:.2f}<{policy.aggregate_threshold:.2f}")

    verdict = Verdict.REJECTED if reasons else Verdict.APPROVED
    return ConsensusDecision(
        verdict=verdict,
        aggregate_score=round(aggregate, 4),
        assessments=tuple(assessments),
        failures=tuple(failures),
        reasons=tuple(reasons),
    )


def rejected(reason: str) -> ConsensusDecision:
    """Decisión de rechazo previa a la evaluación (p. ej. el motor RAG no respondió)."""
    return ConsensusDecision(Verdict.REJECTED, 0.0, (), (), (reason,))
