from __future__ import annotations

from typing import Protocol

from ..models import PrRef


class VcsError(RuntimeError):
    pass


COMMENT_MARKER = "<!-- multiagent-consensus -->"


class VcsClient(Protocol):
    """Operaciones que el gatekeeper necesita de GitHub / GitLab."""

    def get_pr(self, ref: PrRef) -> PrRef: ...

    def get_diff(self, ref: PrRef) -> str: ...

    def set_status(self, ref: PrRef, state: str, description: str, target_url: str | None = None) -> None: ...

    def upsert_comment(self, ref: PrRef, body: str) -> None: ...

    def post_comment(self, ref: PrRef, body: str) -> None: ...

    def merge(self, ref: PrRef) -> None: ...

    def request_changes(self, ref: PrRef, body: str) -> None: ...

    def has_write_access(self, ref: PrRef, username: str) -> bool: ...
