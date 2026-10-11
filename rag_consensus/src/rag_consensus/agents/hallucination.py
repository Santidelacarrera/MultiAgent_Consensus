"""Crítico de Alucinaciones: ¿cada afirmación del borrador está respaldada por los fragmentos recuperados?"""
from __future__ import annotations

from ..config import HALLUCINATION
from ..models import Assessment, Finding, Severity
from ..text import CITATION, content_tokens, entities, fold, is_abstention, numbers, split_sentences
from .base import AssessmentContext

#: Una frase se considera respaldada si su puntuación de soporte alcanza este valor.
CLAIM_SUPPORTED = 0.60
_MIN_CLAIM_TOKENS = 3


class HallucinationCritic:
    name = HALLUCINATION

    async def assess(self, ctx: AssessmentContext) -> Assessment:
        draft = ctx.response.draft_answer
        chunks = ctx.response.chunks
        findings: list[Finding] = []

        if not draft.strip():
            return Assessment(self.name, 0.0, findings=(Finding("EMPTY_DRAFT", "El borrador está vacío.", Severity.CRITICAL),))
        if is_abstention(draft):
            return Assessment(self.name, 1.0, findings=(Finding("ABSTENTION", "El borrador se abstiene de responder.", Severity.INFO),))
        if not chunks:
            return Assessment(
                self.name,
                0.0,
                veto=True,
                findings=(Finding("NO_EVIDENCE", "El borrador afirma contenido pero no hay fragmentos que lo respalden.", Severity.CRITICAL),),
            )

        union = frozenset().union(*(content_tokens(c.text) for c in chunks))
        per_chunk = [content_tokens(c.text) for c in chunks]
        union_numbers = frozenset().union(*(numbers(c.text) for c in chunks))
        union_entities = frozenset(fold(w) for c in chunks for s in split_sentences(c.text) for w in entities(s)) | union

        scores: list[float] = []
        for sentence in split_sentences(draft):
            toks = content_tokens(sentence)
            if len(toks) < _MIN_CLAIM_TOKENS:
                continue  # frase conectora / sin contenido verificable
            overall = len(toks & union) / len(toks)
            best = max(len(toks & ct) / len(toks) for ct in per_chunk)
            score = 0.4 * overall + 0.6 * best

            bad_numbers = numbers(sentence) - union_numbers
            if bad_numbers:
                score *= 0.3
                findings.append(Finding("UNSUPPORTED_NUMBER", f"Cifra(s) sin respaldo en las fuentes: {', '.join(sorted(bad_numbers))}.", Severity.CRITICAL))
            bad_entities = entities(sentence) - union_entities
            if bad_entities:
                score *= 0.8
                findings.append(Finding("UNSUPPORTED_ENTITY", f"Nombre(s) ausentes de las fuentes: {', '.join(sorted(bad_entities))}.", Severity.WARNING))
            if score < CLAIM_SUPPORTED:
                findings.append(Finding("UNSUPPORTED_CLAIM", f"Afirmación con respaldo insuficiente ({score:.2f}): «{sentence[:80]}».", Severity.WARNING))
            scores.append(score)

        known_refs = {c.id for c in chunks} | {str(i) for i in range(1, len(chunks) + 1)}
        bad_refs = {m for m in CITATION.findall(draft) if m not in known_refs}
        total = sum(scores) / len(scores) if scores else 0.0
        if not scores:
            findings.append(Finding("NO_VERIFIABLE_CLAIMS", "El borrador no contiene afirmaciones verificables.", Severity.WARNING))
        if bad_refs:
            total *= 0.5
            findings.append(Finding("INVALID_CITATION", f"Citas a fuentes inexistentes: {', '.join(sorted(bad_refs))}.", Severity.CRITICAL))
        return Assessment(self.name, round(max(0.0, min(1.0, total)), 4), findings=tuple(findings))
