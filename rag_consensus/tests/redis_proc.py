"""redis-server efímero para pruebas (con o sin ACL). Se omite si el binario no existe."""
from __future__ import annotations

import shutil
import socket
import subprocess
import tempfile
import time
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

import pytest


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


@contextmanager
def redis_server(acl_lines: list[str] | None = None) -> Iterator[int]:
    binary = shutil.which("redis-server")
    if binary is None:
        pytest.skip("redis-server no está instalado")
    port = _free_port()
    tmp = Path(tempfile.mkdtemp(prefix="redis-test-"))
    args = [binary, "--port", str(port), "--bind", "127.0.0.1", "--save", "", "--appendonly", "no", "--dir", str(tmp)]
    if acl_lines is not None:
        acl = tmp / "users.acl"
        acl.write_text("\n".join(acl_lines) + "\n")
        args += ["--aclfile", str(acl)]
    proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        deadline = time.time() + 5
        while time.time() < deadline:
            try:
                socket.create_connection(("127.0.0.1", port), timeout=0.2).close()
                break
            except OSError:
                time.sleep(0.05)
        yield port
    finally:
        proc.terminate()
        proc.wait(timeout=5)
        shutil.rmtree(tmp, ignore_errors=True)
