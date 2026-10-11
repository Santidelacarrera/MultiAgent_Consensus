"""Almacenes del servicio: ejecuciones (`runs`) y caché anti-replay de firmas. Memoria (dev/tests) o Redis."""
from __future__ import annotations

import json
import time
from dataclasses import asdict, dataclass, field
from typing import Protocol

from redis.asyncio import Redis


@dataclass(frozen=True, slots=True)
class RunRecord:
    run_id: str
    tenant_id: str
    status: str  # completed | failed
    verdict: str | None
    answer: str | None
    citations: tuple[str, ...] = ()
    error: str | None = None
    created_at: float = field(default_factory=time.time)

    def to_json(self) -> str:
        return json.dumps(asdict(self), ensure_ascii=False)

    @staticmethod
    def from_json(raw: str) -> "RunRecord":
        d = json.loads(raw)
        d["citations"] = tuple(d.get("citations", ()))
        return RunRecord(**d)


class RunStore(Protocol):
    async def put(self, record: RunRecord) -> None: ...
    async def get(self, tenant_id: str, run_id: str) -> RunRecord | None: ...
    async def ping(self) -> bool: ...


class ReplayCache(Protocol):
    async def first_seen(self, tenant_id: str, request_id: str) -> bool:
        """True si es la primera vez que se ve (y la registra); False si es un replay."""
        ...


class MemoryStore:
    """Implementa RunStore y ReplayCache en memoria, con caducidad."""

    def __init__(self, run_ttl_s: float = 3600, replay_ttl_s: float = 120, max_entries: int = 10_000) -> None:
        self._runs: dict[tuple[str, str], tuple[float, RunRecord]] = {}
        self._seen: dict[tuple[str, str], float] = {}
        self._run_ttl, self._replay_ttl, self._max = run_ttl_s, replay_ttl_s, max_entries

    def _prune(self, now: float) -> None:
        if len(self._runs) > self._max:
            for k in [k for k, (exp, _) in self._runs.items() if exp < now] or list(self._runs)[: len(self._runs) // 10]:
                self._runs.pop(k, None)
        if len(self._seen) > self._max:
            for k in [k for k, exp in self._seen.items() if exp < now] or list(self._seen)[: len(self._seen) // 10]:
                self._seen.pop(k, None)

    async def put(self, record: RunRecord) -> None:
        now = time.monotonic()
        self._prune(now)
        self._runs[(record.tenant_id, record.run_id)] = (now + self._run_ttl, record)

    async def get(self, tenant_id: str, run_id: str) -> RunRecord | None:
        item = self._runs.get((tenant_id, run_id))
        if item is None or item[0] < time.monotonic():
            return None
        return item[1]

    async def first_seen(self, tenant_id: str, request_id: str) -> bool:
        now = time.monotonic()
        self._prune(now)
        key = (tenant_id, request_id)
        if self._seen.get(key, 0) > now:
            return False
        self._seen[key] = now + self._replay_ttl
        return True

    async def ping(self) -> bool:
        return True


class RedisStore:
    """RunStore + ReplayCache sobre Redis. Todas las claves cuelgan de `consensus:` (el ACL del stack las restringe)."""

    def __init__(self, redis: Redis, run_ttl_s: int = 3600, replay_ttl_s: int = 120) -> None:
        self._r, self._run_ttl, self._replay_ttl = redis, run_ttl_s, replay_ttl_s

    @staticmethod
    def _run_key(tenant_id: str, run_id: str) -> str:
        return f"consensus:run:{tenant_id}:{run_id}"

    async def put(self, record: RunRecord) -> None:
        await self._r.set(self._run_key(record.tenant_id, record.run_id), record.to_json(), ex=self._run_ttl)

    async def get(self, tenant_id: str, run_id: str) -> RunRecord | None:
        raw = await self._r.get(self._run_key(tenant_id, run_id))
        if raw is None:
            return None
        return RunRecord.from_json(raw.decode() if isinstance(raw, bytes) else str(raw))

    async def first_seen(self, tenant_id: str, request_id: str) -> bool:
        return bool(await self._r.set(f"consensus:nonce:{tenant_id}:{request_id}", "1", nx=True, ex=self._replay_ttl))

    async def ping(self) -> bool:
        try:
            return bool(await self._r.ping())
        except Exception:  # noqa: BLE001
            return False
