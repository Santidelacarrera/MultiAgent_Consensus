"""Gatekeeper: receptor de webhooks de GitHub / GitLab que emite el veredicto final del PR."""
from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
from contextlib import asynccontextmanager
from typing import Any

import httpx
from fastapi import BackgroundTasks, FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

from .config import Settings
from .models import PrRef
from .orchestrator_client import OrchestratorClient
from .policy import COMMAND_PREFIX
from .service import GateService
from .vcs import VcsClient, VcsError
from .vcs.github import GitHubClient
from .vcs.gitlab import GitLabClient

log = logging.getLogger("gatekeeper")

GITHUB_PR_ACTIONS = {"opened", "synchronize", "reopened", "ready_for_review"}


def verify_github_signature(secret: str, body: bytes, header: str) -> bool:
    expected = "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, header or "")


def create_app(settings: Settings | None = None, transport: httpx.BaseTransport | None = None) -> FastAPI:
    """Construye la aplicación. `transport` permite inyectar un transporte HTTP (tests)."""
    settings = settings or Settings.from_env(os.environ)
    orchestrator = OrchestratorClient(settings, transport=transport)

    def vcs_factory(provider: str) -> VcsClient:
        if provider == "github":
            return GitHubClient(settings, transport=transport)
        if provider == "gitlab":
            return GitLabClient(settings, transport=transport)
        raise VcsError(f"proveedor no soportado: {provider}")

    service = GateService(settings, orchestrator, vcs_factory)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        yield
        orchestrator.close()

    app = FastAPI(title="MultiAgent Consensus — Gatekeeper", version="1.0.0", lifespan=lifespan)
    app.state.service = service
    app.state.settings = settings

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok", "service": "multiagent-consensus-gatekeeper"}

    # ------------------------------------------------------------------ GitHub

    @app.post("/webhooks/github")
    async def github_webhook(request: Request, background: BackgroundTasks) -> JSONResponse:
        secret = settings.github_webhook_secret
        if not secret:
            raise HTTPException(503, "GITHUB_WEBHOOK_SECRET no configurado")
        raw = await request.body()
        if not verify_github_signature(secret, raw, request.headers.get("x-hub-signature-256", "")):
            raise HTTPException(401, "firma inválida")
        event = request.headers.get("x-github-event", "")
        try:
            payload: dict[str, Any] = json.loads(raw)
        except json.JSONDecodeError:
            raise HTTPException(400, "JSON inválido")

        if event == "ping":
            return JSONResponse({"status": "pong"})

        if event == "pull_request":
            if payload.get("action") not in GITHUB_PR_ACTIONS:
                return JSONResponse({"status": "ignored", "reason": f"acción {payload.get('action')}"})
            pr = payload["pull_request"]
            if pr.get("draft"):
                return JSONResponse({"status": "ignored", "reason": "draft"})
            ref = PrRef(
                provider="github",
                repo=payload["repository"]["full_name"],
                number=pr["number"],
                head_sha=pr["head"]["sha"],
                title=pr.get("title") or "",
                author=(pr.get("user") or {}).get("login", ""),
                base_branch=(pr.get("base") or {}).get("ref", ""),
                description=pr.get("body") or "",
                labels=tuple(l["name"] for l in pr.get("labels", [])),
            )
            background.add_task(service.process_pr, ref)
            return JSONResponse({"status": "accepted", "pr": ref.pr_id}, status_code=202)

        if event == "issue_comment":
            comment = payload.get("comment") or {}
            issue = payload.get("issue") or {}
            body = comment.get("body") or ""
            is_bot = (comment.get("user") or {}).get("type") == "Bot"
            if payload.get("action") != "created" or "pull_request" not in issue or is_bot or not body.lstrip().lower().startswith(COMMAND_PREFIX):
                return JSONResponse({"status": "ignored"})
            ref = PrRef(provider="github", repo=payload["repository"]["full_name"], number=issue["number"])
            background.add_task(service.handle_command, ref, comment["user"]["login"], body)
            return JSONResponse({"status": "accepted", "command": True}, status_code=202)

        return JSONResponse({"status": "ignored", "reason": f"evento {event}"})

    # ------------------------------------------------------------------ GitLab

    @app.post("/webhooks/gitlab")
    async def gitlab_webhook(request: Request, background: BackgroundTasks) -> JSONResponse:
        token = settings.gitlab_webhook_token
        if not token:
            raise HTTPException(503, "GITLAB_WEBHOOK_TOKEN no configurado")
        if not hmac.compare_digest(token, request.headers.get("x-gitlab-token", "")):
            raise HTTPException(401, "token inválido")
        try:
            payload: dict[str, Any] = json.loads(await request.body())
        except json.JSONDecodeError:
            raise HTTPException(400, "JSON inválido")
        event = request.headers.get("x-gitlab-event", "")
        project = payload.get("project") or {}

        if event == "Merge Request Hook":
            attrs = payload.get("object_attributes") or {}
            action = attrs.get("action")
            # `update` sólo si trae commits nuevos (oldrev); evita re-evaluar ediciones de título/etiquetas.
            if not (action in {"open", "reopen"} or (action == "update" and "oldrev" in attrs)):
                return JSONResponse({"status": "ignored", "reason": f"acción {action}"})
            if attrs.get("draft") or attrs.get("work_in_progress"):
                return JSONResponse({"status": "ignored", "reason": "draft"})
            ref = PrRef(
                provider="gitlab",
                repo=project["path_with_namespace"],
                number=attrs["iid"],
                head_sha=(attrs.get("last_commit") or {}).get("id", ""),
                title=attrs.get("title") or "",
                author=(payload.get("user") or {}).get("username", ""),
                base_branch=attrs.get("target_branch", ""),
                description=attrs.get("description") or "",
                labels=tuple(l.get("title", "") for l in payload.get("labels", [])),
                project_id=project.get("id"),
            )
            background.add_task(service.process_pr, ref)
            return JSONResponse({"status": "accepted", "pr": ref.pr_id}, status_code=202)

        if event == "Note Hook":
            attrs = payload.get("object_attributes") or {}
            body = attrs.get("note") or ""
            mr = payload.get("merge_request")
            if attrs.get("noteable_type") != "MergeRequest" or not mr or not body.lstrip().lower().startswith(COMMAND_PREFIX):
                return JSONResponse({"status": "ignored"})
            ref = PrRef(provider="gitlab", repo=project["path_with_namespace"], number=mr["iid"], project_id=project.get("id"))
            background.add_task(service.handle_command, ref, (payload.get("user") or {}).get("username", ""), body)
            return JSONResponse({"status": "accepted", "command": True}, status_code=202)

        return JSONResponse({"status": "ignored", "reason": f"evento {event}"})

    return app
