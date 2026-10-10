"""Mundo simulado: GitHub, GitLab y orquestador sobre httpx.MockTransport."""
from __future__ import annotations

import hashlib
import hmac
import json
from dataclasses import dataclass, field
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app

GH_SECRET = "gh-secret"
GL_TOKEN = "gl-token"
SHA = "a" * 40
DIFF = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n"


def approved_view(**over: Any) -> dict[str, Any]:
    base = {
        "id": "d1", "prId": "github:acme/shop#7", "headSha": SHA, "status": "approved", "decision": "APPROVED", "verdict": "APPROVED",
        "reason": "Unanimidad de aprobación en la primera ronda (3/3).",
        "summary": {"conditions": [], "approvals": 3, "quorum": 2, "hardBlockers": [], "blockingDissent": [], "resolution": None},
    }
    base.update(over)
    return base


@dataclass
class World:
    orch_view: dict[str, Any] = field(default_factory=approved_view)
    orch_submit_status: str = "running"
    orch_down: bool = False
    orch_history: list[dict[str, Any]] = field(default_factory=list)
    resolved_view: dict[str, Any] | None = None
    big_diff: bool = False
    merge_status: int = 200
    permission: str = "write"
    calls: list[tuple[str, str, Any]] = field(default_factory=list)
    comments: list[dict[str, Any]] = field(default_factory=list)  # comentarios existentes en el PR/MR
    repo_config: str | None = None

    def of(self, method: str, path_prefix: str) -> list[tuple[str, str, Any]]:
        return [c for c in self.calls if c[0] == method and c[1].startswith(path_prefix)]

    # ------------------------------------------------------------------ router
    def handler(self, request: httpx.Request) -> httpx.Response:
        host, path, method = request.url.host, request.url.path, request.method
        body: Any = None
        if request.content:
            try:
                body = json.loads(request.content)
            except ValueError:
                body = request.content.decode()
        self.calls.append((method, path, body if body is not None else dict(request.url.params)))
        if host == "orchestrator.test":
            return self._orchestrator(request, method, path, body)
        if host == "api.github.com":
            return self._github(request, method, path, body)
        if host == "gitlab.test":
            return self._gitlab(request, method, path, body)
        return httpx.Response(404)

    def _orchestrator(self, request: httpx.Request, method: str, path: str, body: Any) -> httpx.Response:
        if self.orch_down:
            return httpx.Response(503, text="down")
        if method == "POST" and path == "/v1/debates":
            return httpx.Response(202, json={**self.orch_view, "status": self.orch_submit_status})
        if method == "GET" and path == "/v1/debates":
            return httpx.Response(200, json=self.orch_history)
        if method == "GET" and path.endswith("/minutes"):
            return httpx.Response(200, text="# Minuta de prueba", headers={"content-type": "text/markdown"})
        if method == "POST" and path.endswith("/resolution"):
            return httpx.Response(201, json=self.resolved_view or self.orch_view)
        if method == "GET" and path.startswith("/v1/debates/"):
            return httpx.Response(200, json=self.orch_view)
        return httpx.Response(404)

    def _github(self, request: httpx.Request, method: str, path: str, body: Any) -> httpx.Response:
        if method == "GET" and path == "/repos/acme/shop/pulls/7":
            if "diff" in request.headers.get("accept", ""):
                return httpx.Response(406 if self.big_diff else 200, text=DIFF)
            return httpx.Response(200, json={"head": {"sha": SHA}, "title": "T", "user": {"login": "dev"}, "base": {"ref": "main"}, "body": "desc", "labels": [{"name": "x"}]})
        if method == "GET" and path == "/repos/acme/shop/pulls/7/files":
            return httpx.Response(200, json=[{"filename": "src/a.ts", "status": "modified", "patch": "@@ -1 +1 @@\n-old\n+new"}, {"filename": "img.png", "status": "added"}])
        if method == "GET" and path == "/repos/acme/shop/contents/.consensus.json":
            return httpx.Response(404) if self.repo_config is None else httpx.Response(200, text=self.repo_config)
        if method == "POST" and path.startswith("/repos/acme/shop/statuses/"):
            return httpx.Response(201, json={})
        if method == "GET" and path == "/repos/acme/shop/issues/7/comments":
            return httpx.Response(200, json=self.comments)
        if method == "POST" and path == "/repos/acme/shop/issues/7/comments":
            self.comments.append({"id": len(self.comments) + 1, "body": body["body"]})
            return httpx.Response(201, json={})
        if method == "PATCH" and path.startswith("/repos/acme/shop/issues/comments/"):
            cid = int(path.rsplit("/", 1)[1])
            for c in self.comments:
                if c["id"] == cid:
                    c["body"] = body["body"]
            return httpx.Response(200, json={})
        if method == "PUT" and path == "/repos/acme/shop/pulls/7/merge":
            return httpx.Response(self.merge_status, json={"merged": self.merge_status == 200})
        if method == "POST" and path == "/repos/acme/shop/pulls/7/reviews":
            return httpx.Response(200, json={})
        if method == "GET" and path.startswith("/repos/acme/shop/collaborators/"):
            return httpx.Response(200, json={"permission": self.permission})
        return httpx.Response(404)

    def _gitlab(self, request: httpx.Request, method: str, path: str, body: Any) -> httpx.Response:
        base = "/api/v4/projects/42/merge_requests/3"
        if method == "GET" and path == base:
            return httpx.Response(200, json={"sha": SHA, "title": "MR", "author": {"username": "dev"}, "target_branch": "main", "description": "", "labels": ["l"]})
        if method == "GET" and path == f"{base}/changes":
            return httpx.Response(200, json={"changes": [
                {"old_path": "a.py", "new_path": "a.py", "new_file": False, "deleted_file": False, "renamed_file": False, "diff": "@@ -1 +1 @@\n-x\n+y\n"},
                {"old_path": "b.py", "new_path": "b.py", "new_file": True, "deleted_file": False, "renamed_file": False, "diff": "@@ -0,0 +1 @@\n+z\n"},
            ]})
        if method == "POST" and path.startswith("/api/v4/projects/42/statuses/"):
            return httpx.Response(201, json={})
        if method == "GET" and path == f"{base}/notes":
            return httpx.Response(200, json=self.comments)
        if method == "POST" and path == f"{base}/notes":
            self.comments.append({"id": len(self.comments) + 1, "body": body["body"]})
            return httpx.Response(201, json={})
        if method == "PUT" and path.startswith(f"{base}/notes/"):
            return httpx.Response(200, json={})
        if method == "PUT" and path == f"{base}/merge":
            return httpx.Response(200, json={})
        if method == "GET" and path == "/api/v4/projects/42/members/all":
            return httpx.Response(200, json=[{"username": "alice", "access_level": 40}])
        return httpx.Response(404)


def make_settings(**over: Any) -> Settings:
    base = dict(
        orchestrator_url="http://orchestrator.test", orchestrator_api_key="orch-key",
        github_token="ghp_x", github_webhook_secret=GH_SECRET, github_api_url="https://api.github.com",
        gitlab_token="glpat", gitlab_webhook_token=GL_TOKEN, gitlab_api_url="http://gitlab.test/api/v4",
        poll_wait_ms=0, debate_timeout_s=5, orchestrator_public_url="https://consensus.example",
    )
    base.update(over)
    return Settings(**base)


@pytest.fixture
def world() -> World:
    return World()


@pytest.fixture
def make_client(world: World):
    def _make(**settings_over: Any) -> TestClient:
        app = create_app(make_settings(**settings_over), transport=httpx.MockTransport(world.handler))
        return TestClient(app)

    return _make


def gh_post(client: TestClient, event: str, payload: dict[str, Any], secret: str = GH_SECRET, sig: str | None = None):
    raw = json.dumps(payload).encode()
    signature = sig if sig is not None else "sha256=" + hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest()
    return client.post("/webhooks/github", content=raw, headers={"x-github-event": event, "x-hub-signature-256": signature, "content-type": "application/json"})


def pr_payload(action: str = "opened", draft: bool = False) -> dict[str, Any]:
    return {
        "action": action,
        "repository": {"full_name": "acme/shop"},
        "pull_request": {"number": 7, "title": "Add feature", "body": "desc", "draft": draft, "head": {"sha": SHA}, "base": {"ref": "main"}, "user": {"login": "dev"}, "labels": []},
    }


def comment_payload(body: str, user: str = "alice", user_type: str = "User", is_pr: bool = True) -> dict[str, Any]:
    issue: dict[str, Any] = {"number": 7}
    if is_pr:
        issue["pull_request"] = {}
    return {"action": "created", "repository": {"full_name": "acme/shop"}, "issue": issue, "comment": {"body": body, "user": {"login": user, "type": user_type}}}
