"""Prueba con un servidor HTTP real en loopback (sin MockTransport): cubre sockets, JSON y cabeceras de verdad."""
from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Iterator

import pytest

from rag_consensus import ConsensusOrchestrator, RagClient, RagClientConfig, Verdict

from .helpers import POLICY_TEXT, REQUEST, rag_body, run

received: list[dict[str, object]] = []
mode = {"value": "ok"}


class Handler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("content-length", "0"))
        body = json.loads(self.rfile.read(length))
        received.append({"path": self.path, "auth": self.headers.get("x-api-key"), "tenant": self.headers.get("x-tenant"), "body": body})
        payload = rag_body(tenant="globex") if mode["value"] == "leak" else rag_body()
        data = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args: object) -> None:
        return None


@pytest.fixture()
def server() -> Iterator[str]:
    received.clear()
    mode["value"] = "ok"
    srv = HTTPServer(("127.0.0.1", 0), Handler)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    yield f"http://127.0.0.1:{srv.server_address[1]}"
    srv.shutdown()
    srv.server_close()


def test_real_socket_roundtrip_approved(server: str) -> None:
    async def go() -> None:
        async with RagClient(RagClientConfig(base_url=server, api_key="k")) as client:
            out = await ConsensusOrchestrator(client).answer(REQUEST)
        assert out.approved and out.verdict is Verdict.APPROVED

    run(go())
    assert received[0]["path"] == "/api/v1/retrieve" and received[0]["auth"] == "k"
    assert received[0]["tenant"] == "acme"
    assert received[0]["body"] == {"tenant_id": "acme", "query": REQUEST.query, "top_k": 3}


def test_real_socket_cross_tenant_is_blocked(server: str) -> None:
    mode["value"] = "leak"

    async def go() -> None:
        async with RagClient(RagClientConfig(base_url=server)) as client:
            out = await ConsensusOrchestrator(client).answer(REQUEST)
        assert out.verdict is Verdict.REJECTED and out.answer is None

    run(go())


def test_real_connection_refused_is_a_rejection() -> None:
    async def go() -> None:
        cfg = RagClientConfig(base_url="http://127.0.0.1:1", max_retries=1, backoff_s=0.0, timeout_s=1.0)
        async with RagClient(cfg) as client:
            out = await ConsensusOrchestrator(client).answer(REQUEST)
        assert out.verdict is Verdict.REJECTED and out.error_code == "RAG_CONNECTION" and out.answer is None

    run(go())
