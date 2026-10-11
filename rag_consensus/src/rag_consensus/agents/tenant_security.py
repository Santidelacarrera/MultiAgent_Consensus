"""Auditor de Seguridad de Tenant: aislamiento multi-tenant, fuga de secretos e inyección de prompts vía contexto."""
from __future__ import annotations

import re

from ..config import TENANT_SECURITY
from ..models import Assessment, Finding, Severity
from ..text import fold
from .base import AssessmentContext

_SECRET_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("AWS_KEY", re.compile(r"\b(AKIA|ASIA)[0-9A-Z]{16}\b")),
    ("PRIVATE_KEY", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    ("API_TOKEN", re.compile(r"\b(gh[pousr]_[A-Za-z0-9]{30,}|xox[abprs]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{35})\b")),
    ("CREDENTIAL", re.compile(r"(?i)\b(password|passwd|secret|api[_-]?key|token)\b\s*[:=]\s*['\"]?[^\s'\"]{8,}")),
)
_PII_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("EMAIL", re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.-]+\b")),
    ("PHONE", re.compile(r"(?<!\d)(\+?\d[\d\s().-]{8,}\d)(?!\d)")),
)
_INJECTION = re.compile(
    r"(?i)(ignor[ae]\s+(todas?\s+)?(las\s+)?(instrucciones|indicaciones)\s+(anteriores|previas)|"
    r"ignore\s+(all\s+)?(the\s+)?(previous|prior|above)\s+(instructions|prompts?)|disregard\s+(all\s+)?(previous|prior)|"
    r"you\s+are\s+now\b|nuevas?\s+instrucciones\s*:|system\s+prompt|act[uú]a\s+como\s+(si\s+fueras|un)\b)"
)
_LEAK_WINDOW = 6  # palabras consecutivas de un fragmento ajeno que, si aparecen en el borrador, constituyen una fuga


class TenantSecurityAuditor:
    name = TENANT_SECURITY

    def __init__(self, *, allow_untagged_chunks: bool = False) -> None:
        self._allow_untagged = allow_untagged_chunks

    async def assess(self, ctx: AssessmentContext) -> Assessment:
        tenant = ctx.request.tenant_id
        resp = ctx.response
        findings: list[Finding] = []
        veto = False
        penalty = 0.0

        if resp.tenant_id is not None and resp.tenant_id != tenant:
            veto = True
            findings.append(Finding("RESPONSE_TENANT_MISMATCH", "La respuesta declara un tenant distinto al solicitado.", Severity.CRITICAL))

        foreign_texts: list[str] = []
        foreign_ids: set[str] = set()
        for chunk in resp.chunks:
            meta_tenant = chunk.metadata.get("tenant_id", chunk.metadata.get("tenant"))
            declared = {t for t in (chunk.tenant_id, meta_tenant if isinstance(meta_tenant, str) else None) if t is not None}
            if not declared:
                if not self._allow_untagged:
                    veto = True
                    findings.append(Finding("CHUNK_UNTAGGED", "Un fragmento no declara tenant: no se puede verificar el aislamiento.", Severity.CRITICAL))
                continue
            foreign = declared - {tenant}
            if foreign:
                veto = True
                foreign_ids |= foreign
                foreign_texts.append(chunk.text)
                findings.append(Finding("CROSS_TENANT_LEAK", "Un fragmento pertenece a otro tenant.", Severity.CRITICAL))

        draft = resp.draft_answer
        folded_draft = fold(draft)
        for fid in foreign_ids:
            if fold(fid) in folded_draft:
                veto = True
                findings.append(Finding("FOREIGN_TENANT_ID_IN_DRAFT", "El borrador menciona el identificador de otro tenant.", Severity.CRITICAL))
        for text in foreign_texts:
            if _shares_window(folded_draft, fold(text)):
                veto = True
                findings.append(Finding("FOREIGN_CONTENT_IN_DRAFT", "El borrador reproduce contenido de otro tenant.", Severity.CRITICAL))
                break

        for code, pattern in _SECRET_PATTERNS:
            if pattern.search(draft):
                veto = True
                findings.append(Finding(f"SECRET_IN_DRAFT_{code}", "El borrador contiene un secreto o credencial.", Severity.CRITICAL))
        for code, pattern in _PII_PATTERNS:
            if pattern.search(draft):
                penalty += 0.15
                findings.append(Finding(f"PII_IN_DRAFT_{code}", "El borrador contiene datos personales; revisar si procede entregarlos.", Severity.WARNING))

        injected = [c.id for c in resp.chunks if _INJECTION.search(c.text)]
        if injected:
            penalty += 0.25
            findings.append(Finding("PROMPT_INJECTION_IN_CONTEXT", f"Instrucciones incrustadas en {len(injected)} fragmento(s) del contexto recuperado.", Severity.WARNING))
            if _INJECTION.search(draft):
                veto = True
                findings.append(Finding("PROMPT_INJECTION_ECHOED", "El borrador reproduce instrucciones inyectadas.", Severity.CRITICAL))

        score = 0.0 if veto else max(0.0, 1.0 - penalty)
        return Assessment(self.name, round(score, 4), veto=veto, findings=tuple(findings))


def _shares_window(haystack: str, source: str) -> bool:
    words = source.split()
    if len(words) < _LEAK_WINDOW:
        return False
    return any(" ".join(words[i : i + _LEAK_WINDOW]) in haystack for i in range(len(words) - _LEAK_WINDOW + 1))
