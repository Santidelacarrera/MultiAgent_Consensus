"""Validador de Coherencia: ¿el borrador responde a la consulta y es internamente consistente?"""
from __future__ import annotations

from ..config import COHERENCE
from ..models import Assessment, Finding, Severity
from ..text import content_tokens, fold, is_abstention, negation_signature, split_sentences
from .base import AssessmentContext

_MAX_REPETITION = 0.30
_LOW_RETRIEVAL = 0.30


class CoherenceValidator:
    name = COHERENCE

    async def assess(self, ctx: AssessmentContext) -> Assessment:
        draft = ctx.response.draft_answer.strip()
        if not draft:
            return Assessment(self.name, 0.0, findings=(Finding("EMPTY_DRAFT", "El borrador está vacío.", Severity.CRITICAL),))

        findings: list[Finding] = []
        sentences = split_sentences(draft)
        abstains = is_abstention(draft)

        q = content_tokens(ctx.request.query)
        d = content_tokens(draft) | frozenset().union(*(content_tokens(s) for s in sentences))
        relevance = len(q & d) / len(q) if q else 1.0
        if abstains:
            relevance = max(relevance, 0.75)  # abstenerse con honestidad es coherente
        elif relevance < 0.3:
            findings.append(Finding("OFF_TOPIC", f"El borrador apenas se relaciona con la consulta ({relevance:.2f}).", Severity.WARNING))

        penalty = 0.0

        # Repetición degenerada (bucles del generador).
        norm = [fold(s) for s in sentences]
        if len(norm) >= 3:
            rep = 1 - len(set(norm)) / len(norm)
            if rep > _MAX_REPETITION:
                penalty += min(0.3, rep)
                findings.append(Finding("REPETITION", f"Contenido repetido ({rep:.0%} de las frases).", Severity.WARNING))

        # Contradicción directa: misma proposición, una afirmada y otra negada.
        sigs = [negation_signature(s) for s in sentences]
        contradictions = 0
        for i in range(len(sigs)):
            for j in range(i + 1, len(sigs)):
                (ti, ni), (tj, nj) = sigs[i], sigs[j]
                if ni != nj and len(ti) >= 3 and len(tj) >= 3 and len(ti & tj) / len(ti | tj) >= 0.75:
                    contradictions += 1
        if contradictions:
            penalty += min(0.9, 0.6 * contradictions)  # una contradicción directa debe bloquear por sí sola
            findings.append(Finding("CONTRADICTION", f"{contradictions} par(es) de frases se contradicen.", Severity.CRITICAL))

        # Respuesta cortada.
        if not abstains and (draft.endswith(("...", "…")) or draft[-1] not in ".!?)\"'»]"):
            penalty += 0.15
            findings.append(Finding("TRUNCATED", "El borrador parece cortado.", Severity.WARNING))

        # Calidad de la recuperación (sólo si las puntuaciones están en [0, 1]).
        scores = [c.score for c in ctx.response.chunks]
        if scores and all(0.0 <= s <= 1.0 for s in scores) and max(scores) < _LOW_RETRIEVAL and not abstains:
            penalty += 0.2
            findings.append(Finding("LOW_RETRIEVAL_SCORE", "Los fragmentos recuperados tienen baja relevancia.", Severity.WARNING))

        score = max(0.0, min(1.0, 0.4 * relevance + 0.6 - penalty))
        return Assessment(self.name, round(score, 4), findings=tuple(findings))
