from __future__ import annotations

import dataclasses
from typing import Any
from urllib.parse import quote

import httpx

from ..config import Settings
from ..models import PrRef
from .base import COMMENT_MARKER, VcsError

MAX_COMMENT = 900_000  # GitLab admite ~1 MB


class GitLabClient:
    def __init__(self, settings: Settings, transport: httpx.BaseTransport | None = None) -> None:
        if not settings.gitlab_token:
            raise VcsError("GITLAB_TOKEN no configurado")
        self._s = settings
        self._http = httpx.Client(
            base_url=settings.gitlab_api_url,
            headers={"PRIVATE-TOKEN": settings.gitlab_token, "User-Agent": "multiagent-consensus-gatekeeper"},
            timeout=settings.http_timeout_s,
            transport=transport,
        )

    def _pid(self, ref: PrRef) -> str:
        return str(ref.project_id) if ref.project_id is not None else quote(ref.repo, safe="")

    def _req(self, method: str, url: str, ok: tuple[int, ...] = (200, 201), **kw: Any) -> httpx.Response:
        r = self._http.request(method, url, **kw)
        if r.status_code not in ok:
            raise VcsError(f"GitLab {method} {url} → {r.status_code}: {r.text[:300]}")
        return r

    def get_pr(self, ref: PrRef) -> PrRef:
        d = self._req("GET", f"/projects/{self._pid(ref)}/merge_requests/{ref.number}").json()
        return dataclasses.replace(
            ref,
            head_sha=d["sha"],
            title=d.get("title") or "",
            author=(d.get("author") or {}).get("username", ""),
            base_branch=d.get("target_branch", ""),
            description=d.get("description") or "",
            labels=tuple(d.get("labels") or []),
        )

    def get_diff(self, ref: PrRef) -> str:
        data = self._req("GET", f"/projects/{self._pid(ref)}/merge_requests/{ref.number}/changes").json()
        out: list[str] = []
        for c in data.get("changes", []):
            old, new = c["old_path"], c["new_path"]
            out.append(f"diff --git a/{old} b/{new}")
            if c.get("new_file"):
                out.append("new file mode 100644")
            if c.get("deleted_file"):
                out.append("deleted file mode 100644")
            if c.get("renamed_file"):
                out.append(f"rename to {new}")
            out.append("--- /dev/null" if c.get("new_file") else f"--- a/{old}")
            out.append("+++ /dev/null" if c.get("deleted_file") else f"+++ b/{new}")
            diff = c.get("diff") or ""
            if diff:
                out.append(diff.rstrip("\n"))
        return "\n".join(out) + "\n"

    def set_status(self, ref: PrRef, state: str, description: str, target_url: str | None = None) -> None:
        gl_state = {"success": "success", "failure": "failed", "error": "failed", "pending": "running"}.get(state, "pending")
        params: dict[str, Any] = {"state": gl_state, "name": self._s.status_context, "description": description[:140]}
        if target_url:
            params["target_url"] = target_url
        self._req("POST", f"/projects/{self._pid(ref)}/statuses/{ref.head_sha}", params=params)

    def upsert_comment(self, ref: PrRef, body: str) -> None:
        body = f"{COMMENT_MARKER}\n{body}"[:MAX_COMMENT]
        base = f"/projects/{self._pid(ref)}/merge_requests/{ref.number}/notes"
        page = 1
        while True:
            notes = self._req("GET", base, params={"per_page": 100, "page": page}).json()
            for n in notes:
                if COMMENT_MARKER in (n.get("body") or ""):
                    self._req("PUT", f"{base}/{n['id']}", json={"body": body})
                    return
            if len(notes) < 100:
                break
            page += 1
        self._req("POST", base, json={"body": body})

    def post_comment(self, ref: PrRef, body: str) -> None:
        self._req("POST", f"/projects/{self._pid(ref)}/merge_requests/{ref.number}/notes", json={"body": body[:MAX_COMMENT]})

    def merge(self, ref: PrRef) -> None:
        self._req("PUT", f"/projects/{self._pid(ref)}/merge_requests/{ref.number}/merge", json={"sha": ref.head_sha, "squash": self._s.merge_method == "squash"})

    def request_changes(self, ref: PrRef, body: str) -> None:
        # GitLab no tiene "request changes" genérico: el bloqueo se aplica con el estado `failed` del commit.
        return None

    def has_write_access(self, ref: PrRef, username: str) -> bool:
        r = self._http.get(f"/projects/{self._pid(ref)}/members/all", params={"query": username})
        if r.status_code != 200:
            return False
        return any(m.get("username", "").lower() == username.lower() and m.get("access_level", 0) >= 30 for m in r.json())
