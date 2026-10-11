from __future__ import annotations

import dataclasses
from typing import Any

import httpx

from ..config import Settings
from ..models import PrRef
from .base import COMMENT_MARKER, VcsError

MAX_COMMENT = 65_000


class GitHubClient:
    def __init__(self, settings: Settings, transport: httpx.BaseTransport | None = None) -> None:
        if not settings.github_token:
            raise VcsError("GITHUB_TOKEN no configurado")
        self._s = settings
        self._http = httpx.Client(
            base_url=settings.github_api_url,
            headers={
                "Authorization": f"Bearer {settings.github_token}",
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
                "User-Agent": "multiagent-consensus-gatekeeper",
            },
            timeout=settings.http_timeout_s,
            transport=transport,
        )

    def _req(self, method: str, url: str, ok: tuple[int, ...] = (200, 201), **kw: Any) -> httpx.Response:
        r = self._http.request(method, url, **kw)
        if r.status_code not in ok:
            raise VcsError(f"GitHub {method} {url} → {r.status_code}: {r.text[:300]}")
        return r

    def get_pr(self, ref: PrRef) -> PrRef:
        d = self._req("GET", f"/repos/{ref.repo}/pulls/{ref.number}").json()
        return dataclasses.replace(
            ref,
            head_sha=d["head"]["sha"],
            title=d.get("title") or "",
            author=(d.get("user") or {}).get("login", ""),
            base_branch=(d.get("base") or {}).get("ref", ""),
            description=d.get("body") or "",
            labels=tuple(l["name"] for l in d.get("labels", [])),
        )

    def get_diff(self, ref: PrRef) -> str:
        r = self._http.get(f"/repos/{ref.repo}/pulls/{ref.number}", headers={"Accept": "application/vnd.github.v3.diff"})
        if r.status_code == 200:
            return r.text
        if r.status_code in (406, 422):  # diff demasiado grande: reconstruir desde /files
            return self._diff_from_files(ref)
        raise VcsError(f"GitHub diff → {r.status_code}: {r.text[:300]}")

    def _diff_from_files(self, ref: PrRef) -> str:
        out: list[str] = []
        page = 1
        while True:
            files = self._req("GET", f"/repos/{ref.repo}/pulls/{ref.number}/files", params={"per_page": 100, "page": page}).json()
            for f in files:
                patch = f.get("patch")
                if patch is None:  # binario o demasiado grande
                    continue
                old = f.get("previous_filename") or f["filename"]
                status = f.get("status")
                out.append(f"diff --git a/{old} b/{f['filename']}")
                if status == "added":
                    out.append("new file mode 100644")
                if status == "removed":
                    out.append("deleted file mode 100644")
                if status == "renamed":
                    out.append(f"rename to {f['filename']}")
                out.append("--- /dev/null" if status == "added" else f"--- a/{old}")
                out.append("+++ /dev/null" if status == "removed" else f"+++ b/{f['filename']}")
                out.append(patch)
            if len(files) < 100:
                break
            page += 1
        return "\n".join(out) + "\n"

    def get_file(self, ref: PrRef, path: str) -> str | None:
        r = self._http.get(f"/repos/{ref.repo}/contents/{path}", params={"ref": ref.base_branch}, headers={"Accept": "application/vnd.github.raw+json"})
        if r.status_code == 404:
            return None
        if r.status_code != 200:
            raise VcsError(f"GitHub contents {path} → {r.status_code}")
        return r.text

    def set_status(self, ref: PrRef, state: str, description: str, target_url: str | None = None) -> None:
        body: dict[str, Any] = {"state": state, "description": description[:140], "context": self._s.status_context}
        if target_url:
            body["target_url"] = target_url
        self._req("POST", f"/repos/{ref.repo}/statuses/{ref.head_sha}", json=body)

    def upsert_comment(self, ref: PrRef, body: str) -> None:
        body = f"{COMMENT_MARKER}\n{body}"[:MAX_COMMENT]
        page = 1
        while True:
            comments = self._req("GET", f"/repos/{ref.repo}/issues/{ref.number}/comments", params={"per_page": 100, "page": page}).json()
            for c in comments:
                if COMMENT_MARKER in (c.get("body") or ""):
                    self._req("PATCH", f"/repos/{ref.repo}/issues/comments/{c['id']}", json={"body": body})
                    return
            if len(comments) < 100:
                break
            page += 1
        self._req("POST", f"/repos/{ref.repo}/issues/{ref.number}/comments", json={"body": body})

    def post_comment(self, ref: PrRef, body: str) -> None:
        self._req("POST", f"/repos/{ref.repo}/issues/{ref.number}/comments", json={"body": body[:MAX_COMMENT]})

    def merge(self, ref: PrRef) -> None:
        self._req("PUT", f"/repos/{ref.repo}/pulls/{ref.number}/merge", json={"sha": ref.head_sha, "merge_method": self._s.merge_method})

    def request_changes(self, ref: PrRef, body: str) -> None:
        self._req(
            "POST",
            f"/repos/{ref.repo}/pulls/{ref.number}/reviews",
            json={"commit_id": ref.head_sha, "event": "REQUEST_CHANGES", "body": body[:MAX_COMMENT]},
        )

    def has_write_access(self, ref: PrRef, username: str) -> bool:
        r = self._http.get(f"/repos/{ref.repo}/collaborators/{username}/permission")
        if r.status_code != 200:
            return False
        return r.json().get("permission") in {"admin", "maintain", "write"}
