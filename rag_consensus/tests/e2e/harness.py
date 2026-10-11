"""Arnés E2E: PostgreSQL efímero + servicio ContextRAG_Engine real + claves de API ligadas a tenant.

Requisitos (si faltan, las pruebas E2E se omiten con el motivo):
  * CONTEXTRAG_ENGINE_PATH : checkout de https://github.com/Santidelacarrera/contextrag_engine
  * CONTEXTRAG_PYTHON      : intérprete con fastapi, uvicorn, psycopg[binary,pool], rank-bm25, numpy
  * binarios de PostgreSQL en /usr/lib/postgresql/*/bin
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Sequence


class E2EUnavailable(RuntimeError):
    pass


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


@dataclass
class EngineStack:
    url: str
    keys: dict[str, str]  # tenant → clave de API en claro
    pg_dir: Path
    pg_port: int
    pg_bin: Path
    prefix: list[str]
    proc: subprocess.Popen[bytes]
    log_path: Path
    _cleanup: list[Path] = field(default_factory=list)

    def psql(self, sql: str, *, user: str = "postgres") -> str:
        out = subprocess.run(
            [*self.prefix, str(self.pg_bin / "psql"), "-h", "127.0.0.1", "-p", str(self.pg_port), "-U", user, "-d", "postgres", "-At", "-c", sql],
            check=True, capture_output=True, text=True,
        )
        return out.stdout.strip()

    def kill_database(self) -> None:
        """Simula una caída de la base de datos de auditoría del motor."""
        subprocess.run([*self.prefix, str(self.pg_bin / "pg_ctl"), "-D", str(self.pg_dir / "data"), "-m", "immediate", "stop"], check=True, capture_output=True)

    def stop(self) -> None:
        self.proc.terminate()
        try:
            self.proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.proc.kill()
        subprocess.run([*self.prefix, str(self.pg_bin / "pg_ctl"), "-D", str(self.pg_dir / "data"), "-m", "immediate", "stop"], capture_output=True)
        for p in self._cleanup:
            shutil.rmtree(p, ignore_errors=True)


def start_stack(tenants: Sequence[str] = ("acme", "globex")) -> EngineStack:
    engine = os.environ.get("CONTEXTRAG_ENGINE_PATH")
    python = os.environ.get("CONTEXTRAG_PYTHON")
    if not engine or not Path(engine, "contextrag").is_dir():
        raise E2EUnavailable("define CONTEXTRAG_ENGINE_PATH con un checkout de contextrag_engine")
    if not python or not Path(python).exists():
        raise E2EUnavailable("define CONTEXTRAG_PYTHON con un intérprete que tenga las dependencias del motor")
    pg_bin = next(iter(sorted(Path("/usr/lib/postgresql").glob("*/bin"))), None)
    if pg_bin is None or not (pg_bin / "initdb").exists():
        raise E2EUnavailable("PostgreSQL no está instalado")

    prefix: list[str] = []
    root = Path(tempfile.mkdtemp(prefix="rag-e2e-"))
    data = root / "data"
    if os.geteuid() == 0:  # postgres se niega a ejecutarse como root
        if not shutil.which("runuser"):
            raise E2EUnavailable("no se pueden soltar privilegios de root para PostgreSQL")
        os.chmod(root, 0o755)
        prefix = ["runuser", "-u", "postgres", "--"]
        shutil.chown(root, "postgres")
    def run(*a: str) -> "subprocess.CompletedProcess[bytes]":
        return subprocess.run([*prefix, *a], check=True, capture_output=True)

    run(str(pg_bin / "initdb"), "-D", str(data), "-A", "trust", "-U", "postgres")
    pg_port = _free_port()
    run(str(pg_bin / "pg_ctl"), "-D", str(data), "-l", str(root / "pg.log"), "-o", f"-p {pg_port} -k {root} -c listen_addresses=127.0.0.1", "-w", "-t", "30", "start")
    run(str(pg_bin / "psql"), "-h", "127.0.0.1", "-p", str(pg_port), "-U", "postgres", "-d", "postgres", "-c", "CREATE ROLE contextrag_app LOGIN")  # rol plano: ni superusuario ni BYPASSRLS ni propietario de la tabla ⇒ aplica RLS

    keys = {t: f"crag_e2e_{t}_{hashlib.sha256(os.urandom(16)).hexdigest()[:24]}" for t in tenants}
    keys_file = root / "keys.json"
    keys_file.write_text(json.dumps({hashlib.sha256(k.encode()).hexdigest(): {"id": f"{t}-reader", "tenant": t, "groups": [], "role": "reader"} for t, k in keys.items()}))
    os.chmod(keys_file, 0o644)

    port = _free_port()
    env = {
        **os.environ,
        "CONTEXTRAG_ENGINE_PATH": engine,
        "ENGINE_PORT": str(port),
        "KEYS_FILE": str(keys_file),
        "PG_ADMIN_DSN": f"postgresql://postgres@127.0.0.1:{pg_port}/postgres",
        "PG_APP_DSN": f"postgresql://contextrag_app@127.0.0.1:{pg_port}/postgres",
    }
    log_path = root / "engine.log"
    proc = subprocess.Popen([python, str(Path(__file__).with_name("engine_service.py"))], env=env, stdout=log_path.open("wb"), stderr=subprocess.STDOUT)
    stack = EngineStack(f"http://127.0.0.1:{port}", keys, root, pg_port, pg_bin, prefix, proc, log_path, [root])

    deadline = time.time() + 40
    while time.time() < deadline:
        if proc.poll() is not None:
            stack.stop()
            raise E2EUnavailable(f"el servicio terminó al arrancar: {log_path.read_text(errors='replace')[-800:]}")
        try:
            with urllib.request.urlopen(f"{stack.url}/healthz", timeout=1) as r:
                if r.status in (200, 503):
                    return stack
        except Exception:
            time.sleep(0.3)
    stack.stop()
    raise E2EUnavailable("el servicio no respondió a /healthz a tiempo")
