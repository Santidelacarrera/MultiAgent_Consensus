"""Genera, desde las claves en claro del entorno, los ficheros que consumen los servicios (sólo hashes SHA-256).

Salida en <dir>:
  tenants.json           → ShadowAPI edge-gateway (GUARD_TENANTS_FILE)
  contextrag-keys.json   → ContextRAG_Engine (CONTEXTRAG_KEYS_FILE)
Los servicios nunca reciben una clave de cliente en claro. Los ficheros son legibles por todos los UID del contenedor
(los servicios corren sin privilegios); el volumen sólo se monta de solo lectura.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sys
from pathlib import Path

TENANTS = ("acme", "globex")
MIN_LEN = 24


def sha256(key: str) -> str:
    return hashlib.sha256(key.encode()).hexdigest()


def need(name: str) -> str:
    v = os.environ.get(name, "")
    if len(v) < MIN_LEN or v == "CHANGE_ME":
        sys.exit(f"{name}: falta o es demasiado corta (>= {MIN_LEN} caracteres)")
    return v


def main(out: Path) -> None:
    tenants: dict[str, object] = {}
    keys: dict[str, object] = {}
    seen: set[str] = set()
    for t in TENANTS:
        up = t.upper()
        client, reader, admin = need(f"{up}_CLIENT_API_KEY"), need(f"{up}_RAG_READER_KEY"), need(f"{up}_RAG_ADMIN_KEY")
        if len({client, reader, admin} | seen) != 3 + len(seen):
            sys.exit("las claves deben ser distintas entre sí y entre tenants")
        seen |= {client, reader, admin}
        if not re.fullmatch(r"[a-z][a-z0-9_-]{1,31}", t):
            sys.exit(f"identificador de tenant inválido: {t!r}")
        tenants[t] = {
            "api_keys_sha256": [sha256(client)],
            "scopes": ["rag:query", "consensus:run", "consensus:read"],
            "rate_limit_per_minute": 120,
        }
        keys[sha256(reader)] = {"id": f"{t}-consensus", "tenant": t, "groups": [], "role": "reader"}
        keys[sha256(admin)] = {"id": f"{t}-admin", "tenant": t, "groups": [], "role": "admin"}
    out.mkdir(parents=True, exist_ok=True)
    for name, data in (("tenants.json", tenants), ("contextrag-keys.json", keys)):
        f = out / name
        f.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")
        f.chmod(0o644)
    print(f"bootstrap: {len(tenants)} tenants, {len(keys)} claves ligadas → {out}")


if __name__ == "__main__":
    main(Path(sys.argv[1] if len(sys.argv) > 1 else "/out"))
