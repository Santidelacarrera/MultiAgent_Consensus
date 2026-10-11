"""RedisStore contra un redis-server real, con el ACL mínimo que usa el stack (claves `consensus:*`, sin comandos peligrosos)."""
from __future__ import annotations

import asyncio
import json
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient
from redis.asyncio import Redis
from redis.exceptions import AuthenticationError, NoPermissionError

from rag_consensus import InMemoryAuditSink
from rag_consensus.service.app import create_app
from rag_consensus.service.stores import RedisStore, RunRecord

from .helpers import run
from .redis_proc import redis_server
from .test_service import Rag, make_settings, signed

PASSWORD = "p" * 24
# La misma regla que genera ecosystem/redis/entrypoint.sh para el usuario de consensus-service.
ACL = [
    "user default off",
    f"user consensus on >{PASSWORD} ~consensus:* &* -@all +@connection +@string +@keyspace -@dangerous",
    "user other on >otherpw ~other:* &* -@all +@connection +@string +@keyspace -@dangerous",
]


def test_run_store_roundtrip_ttl_and_tenant_scoping_on_real_redis() -> None:
    async def go(port: int) -> None:
        r = Redis.from_url(f"redis://consensus:{PASSWORD}@127.0.0.1:{port}/0")
        store = RedisStore(r, run_ttl_s=2, replay_ttl_s=1)
        rec = RunRecord(run_id="abc", tenant_id="acme", status="completed", verdict="APPROVED", answer="ok", citations=("d:1",))
        await store.put(rec)
        got = await store.get("acme", "abc")
        assert got is not None and got.answer == "ok" and got.citations == ("d:1",)
        assert await store.get("globex", "abc") is None  # la clave incluye el tenant
        assert await store.ping() is True
        # anti-replay: SET NX con caducidad
        assert await store.first_seen("acme", "req-1") is True
        assert await store.first_seen("acme", "req-1") is False
        assert await store.first_seen("globex", "req-1") is True
        await asyncio.sleep(1.2)
        assert await store.first_seen("acme", "req-1") is True  # caducó la ventana
        await asyncio.sleep(1.0)
        assert await store.get("acme", "abc") is None  # caducó el run
        await r.aclose()

    with redis_server(ACL) as port:
        run(go(port))


def test_acl_confines_the_service_to_its_own_keys_and_blocks_dangerous_commands() -> None:
    async def go(port: int) -> None:
        r = Redis.from_url(f"redis://consensus:{PASSWORD}@127.0.0.1:{port}/0")
        await r.set("consensus:ok", "1")
        for forbidden in (r.set("other:secret", "x"), r.get("other:secret"), r.flushall(), r.keys("*"), r.config_get("*")):
            with pytest.raises(NoPermissionError):
                await forbidden
        await r.aclose()
        anon = Redis.from_url(f"redis://127.0.0.1:{port}/0")
        with pytest.raises((AuthenticationError, NoPermissionError)):  # `default` desactivado: sin autenticación no hay nada
            await anon.set("consensus:x", "1")
        await anon.aclose()
        bad = Redis.from_url(f"redis://consensus:mala@127.0.0.1:{port}/0")
        with pytest.raises(AuthenticationError):
            await bad.ping()
        await bad.aclose()

    with redis_server(ACL) as port:
        run(go(port))


def test_whole_service_on_redis_replay_is_rejected_across_two_instances() -> None:
    """Dos réplicas comparten el anti-replay a través de Redis (algo que la memoria de proceso no puede)."""
    with redis_server(ACL) as port:
        url = f"redis://consensus:{PASSWORD}@127.0.0.1:{port}/0"

        def instance() -> tuple[TestClient, Rag]:
            rag = Rag()
            app = create_app(make_settings(redis_url=url), audit=InMemoryAuditSink(), transport=httpx.MockTransport(rag))
            return TestClient(app), rag

        a, rag_a = instance()
        b, rag_b = instance()
        with a, b:
            body: dict[str, Any] = {"query": "plazo de devolución de los pedidos"}
            first = signed(a, "POST", "/v1/rag/query", body, rid="shared-1")
            replay_on_other_replica = signed(b, "POST", "/v1/rag/query", body, rid="shared-1")
            assert first.status_code == 200 and replay_on_other_replica.status_code == 401
            assert len(rag_b.calls) == 0 and len(rag_a.calls) == 1
            run_id = signed(a, "POST", "/v1/consensus/run", {"task": "plazo de devolución de los pedidos"}).json()["run_id"]
            seen_by_b = signed(b, "GET", f"/v1/consensus/runs/{run_id}")  # el run guardado por una réplica lo lee la otra
            assert seen_by_b.status_code == 200 and seen_by_b.json()["tenant_id"] == "acme"
            assert a.get("/readyz").json() == {"status": "ready"}


def test_readyz_reports_unavailable_when_redis_is_down() -> None:
    app = create_app(make_settings(redis_url="redis://127.0.0.1:1/0"), audit=InMemoryAuditSink(), transport=httpx.MockTransport(Rag()))
    with TestClient(app) as client:
        r = client.get("/readyz")
        assert r.status_code == 503 and r.json() == {"status": "store_unavailable"}
        assert client.get("/healthz").status_code == 200  # liveness no depende de Redis
        assert json.dumps(r.json()).find("redis://") == -1
