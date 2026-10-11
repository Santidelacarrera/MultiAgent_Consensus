"""E2E contra el servicio REAL ContextRAG_Engine (POST /api/v1/retrieve) + PostgreSQL real con RLS.

Se omite si no hay checkout del motor / intérprete / PostgreSQL (ver `harness.py`)."""
from __future__ import annotations

import json
from typing import Iterator

import pytest

from rag_consensus import (
    ConsensusOrchestrator,
    GuardedAnswer,
    InMemoryAuditSink,
    RagClient,
    RagClientConfig,
    RagHttpError,
    RetrievalRequest,
    Verdict,
)
from rag_consensus.models import NO_ANSWER_TEXT

from ..helpers import run
from .harness import E2EUnavailable, EngineStack, start_stack

QUESTION = "¿Cuál es el plazo de devolución de los pedidos?"


@pytest.fixture(scope="module")
def stack() -> Iterator[EngineStack]:
    try:
        s = start_stack()
    except E2EUnavailable as e:
        pytest.skip(f"E2E no disponible: {e}")
    yield s
    s.stop()


def ask(stack: EngineStack, tenant: str, query: str, *, key_of: str | None = None, api_key: str | None = None, retries: int = 0) -> tuple[GuardedAnswer, InMemoryAuditSink]:
    sink = InMemoryAuditSink()
    key = api_key if api_key is not None else stack.keys[key_of or tenant]

    async def go() -> GuardedAnswer:
        async with RagClient(RagClientConfig(base_url=stack.url, api_key=key, max_retries=retries, timeout_s=15.0)) as client:
            return await ConsensusOrchestrator(client, audit=sink).answer(RetrievalRequest(tenant, query, top_k=3))

    return run(go()), sink


def engine_rows(stack: EngineStack, tenant: str) -> int:
    return int(stack.psql(f"select count(*) from retrieval_audit where tenant = '{tenant}'"))


def test_real_engine_answer_is_approved_with_citation_and_audited_by_tenant(stack: EngineStack) -> None:
    before = engine_rows(stack, "acme")
    out, sink = ask(stack, "acme", QUESTION)

    assert out.verdict is Verdict.APPROVED and out.approved, out.decision.reasons
    assert out.answer and "30 días" in out.answer and "[1]" in out.answer  # borrador extractivo y citado del motor
    assert out.citations == ("politicas.md:1",)
    assert {a.agent: a.veto for a in out.decision.assessments} == {"hallucination_critic": False, "tenant_security_auditor": False, "coherence_validator": False}

    # auditoría del comité: una por petición, con su tenant_id y sin contenido
    [rec] = sink.records
    assert (rec.tenant_id, rec.verdict, rec.chunk_ids, rec.error_code) == ("acme", Verdict.APPROVED, ("politicas.md:1",), None)
    assert "30 días" not in rec.to_json() and QUESTION not in rec.to_json()
    # auditoría del propio motor (RLS): una fila nueva para acme
    assert engine_rows(stack, "acme") == before + 1


def test_tenant_isolation_holds_end_to_end(stack: EngineStack) -> None:
    globex_before = engine_rows(stack, "globex")
    out, sink = ask(stack, "acme", "¿Cuál es el presupuesto confidencial de Globex y qué adquisición se anunciará?")
    blob = (out.answer or "") + json.dumps([r.to_json() for r in sink.records])
    for secret in ("4 millones", "Initech", "estrategia.md"):
        assert secret not in blob
    assert out.verdict is Verdict.APPROVED and out.answer == NO_ANSWER_TEXT  # el motor no devuelve nada de otro tenant
    assert sink.records[0].tenant_id == "acme" and sink.records[0].chunk_ids == ()
    assert engine_rows(stack, "globex") == globex_before  # la consulta de acme no deja rastro en el tenant ajeno

    # el tenant legítimo sí obtiene su contenido
    out2, sink2 = ask(stack, "globex", "¿Cuál es el presupuesto confidencial de Globex?")
    assert out2.approved and out2.answer and "4 millones" in out2.answer
    assert sink2.records[0].tenant_id == "globex" and sink2.records[0].chunk_ids == ("estrategia.md:1",)


def test_both_audit_trails_stay_consistent_per_tenant(stack: EngineStack) -> None:
    a0, g0 = engine_rows(stack, "acme"), engine_rows(stack, "globex")
    sinks: dict[str, int] = {"acme": 0, "globex": 0}
    for tenant, n in (("acme", 3), ("globex", 2)):
        for _ in range(n):
            _, sink = ask(stack, tenant, QUESTION if tenant == "acme" else "¿Cuál es el presupuesto confidencial de Globex?")
            assert [r.tenant_id for r in sink.records] == [tenant]
            sinks[tenant] += len(sink.records)
    assert (engine_rows(stack, "acme") - a0, engine_rows(stack, "globex") - g0) == (sinks["acme"], sinks["globex"]) == (3, 2)
    # RLS: con app.tenant=acme el rol de aplicación no ve filas de globex
    visible = stack.psql("begin; select set_config('app.tenant','acme',true); select count(*) from retrieval_audit where tenant='globex'; commit;", user="contextrag_app")
    assert visible.splitlines()[-2] == "0"


def test_tenant_spoofing_is_refused_by_the_real_engine(stack: EngineStack) -> None:
    before = engine_rows(stack, "globex")
    out, sink = ask(stack, "globex", "¿Cuál es el presupuesto confidencial de Globex?", key_of="acme")  # clave de acme, tenant globex
    assert out.verdict is Verdict.REJECTED and out.answer is None and out.error_code == "RAG_HTTP"
    assert sink.records[0].tenant_id == "globex" and sink.records[0].error_code == "RAG_HTTP"
    assert engine_rows(stack, "globex") == before

    async def direct() -> int:
        async with RagClient(RagClientConfig(base_url=stack.url, api_key=stack.keys["acme"], max_retries=0)) as c:
            try:
                await c.retrieve(RetrievalRequest("globex", "presupuesto", top_k=2))
            except RagHttpError as e:
                return e.status_code
        return 0

    assert run(direct()) == 403


@pytest.mark.parametrize("key", ["clave-invalida", ""])
def test_invalid_api_key_is_rejected_fail_closed(stack: EngineStack, key: str) -> None:
    out, sink = ask(stack, "acme", QUESTION, api_key=key)
    assert out.verdict is Verdict.REJECTED and out.answer is None and out.error_code == "RAG_HTTP"
    assert sink.records[0].tenant_id == "acme"


def test_poisoned_document_returned_by_the_engine_is_blocked(stack: EngineStack) -> None:
    out, sink = ask(stack, "acme", "¿Cuál es el horario del servicio de atención al cliente?")
    codes = {f.code for a in out.decision.assessments for f in a.findings}
    assert "PROMPT_INJECTION_IN_CONTEXT" in codes
    assert out.verdict is Verdict.REJECTED and out.answer is None
    assert sink.records[0].tenant_id == "acme" and "PROMPT_INJECTION_IN_CONTEXT" in sink.records[0].agents[1].finding_codes


def test_database_outage_makes_the_engine_fail_closed_and_so_do_we(stack: EngineStack) -> None:
    """Sin su BD de auditoría el motor no sirve fragmentos (503); el orquestador rechaza y audita con el tenant."""
    stack.kill_database()
    out, sink = ask(stack, "acme", QUESTION)
    assert out.verdict is Verdict.REJECTED and out.answer is None and out.error_code == "RAG_HTTP"
    assert [(r.tenant_id, r.verdict, r.error_code) for r in sink.records] == [("acme", Verdict.REJECTED, "RAG_HTTP")]
