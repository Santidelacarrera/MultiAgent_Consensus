from __future__ import annotations

import time
from typing import Any

import httpx

from .config import Settings


class OrchestratorError(RuntimeError):
    pass


class OrchestratorClient:
    def __init__(self, settings: Settings, transport: httpx.BaseTransport | None = None) -> None:
        headers = {"x-api-key": settings.orchestrator_api_key} if settings.orchestrator_api_key else {}
        self._s = settings
        self._http = httpx.Client(
            base_url=settings.orchestrator_url,
            headers=headers,
            timeout=settings.http_timeout_s + settings.poll_wait_ms / 1000,
            transport=transport,
        )

    def close(self) -> None:
        self._http.close()

    def _check(self, r: httpx.Response) -> Any:
        if r.status_code >= 400:
            raise OrchestratorError(f"orquestador respondió {r.status_code}: {r.text[:300]}")
        return r.json() if "json" in r.headers.get("content-type", "") else r.text

    def submit(self, payload: dict[str, Any], force: bool = False, settings: dict[str, Any] | None = None) -> dict[str, Any]:
        body: dict[str, Any] = {"pr": payload, "force": force}
        if settings:
            body["settings"] = settings
        return self._check(self._http.post("/v1/debates", json=body))

    def get(self, debate_id: str, wait_ms: int = 0) -> dict[str, Any]:
        return self._check(self._http.get(f"/v1/debates/{debate_id}", params={"waitMs": wait_ms}))

    def wait(self, debate_id: str, timeout_s: float) -> dict[str, Any]:
        """Long-polling hasta que el debate deje de estar `running` o venza el plazo."""
        deadline = time.monotonic() + timeout_s
        while True:
            remaining_ms = int((deadline - time.monotonic()) * 1000)
            view = self.get(debate_id, wait_ms=max(0, min(self._s.poll_wait_ms, remaining_ms)))
            if view.get("status") != "running":
                return view
            if time.monotonic() >= deadline:
                raise OrchestratorError(f"el debate {debate_id} no terminó en {timeout_s:.0f}s")
            if self._s.poll_wait_ms == 0:
                time.sleep(0.05)

    def minutes(self, debate_id: str) -> str:
        return self._check(self._http.get(f"/v1/debates/{debate_id}/minutes"))

    def history(self, pr_id: str) -> list[dict[str, Any]]:
        return self._check(self._http.get("/v1/debates", params={"prId": pr_id}))

    def resolve(self, debate_id: str, reviewer: str, decision: str, rationale: str) -> dict[str, Any]:
        return self._check(
            self._http.post(f"/v1/debates/{debate_id}/resolution", json={"reviewer": reviewer, "decision": decision, "rationale": rationale})
        )
