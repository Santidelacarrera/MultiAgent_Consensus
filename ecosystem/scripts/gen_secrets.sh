#!/usr/bin/env bash
# Sustituye cada `CHANGE_ME` de .env por un secreto aleatorio URL-safe (48 caracteres). Idempotente: no toca el resto.
set -euo pipefail
cd "$(dirname "$0")/.."
[[ -f .env ]] || { echo "falta .env (cp .env.example .env)" >&2; exit 1; }
python3 - <<'PY'
import re, secrets, pathlib
p = pathlib.Path(".env")
out, n = [], 0
for line in p.read_text().splitlines():
    m = re.match(r"^([A-Z0-9_]+)=CHANGE_ME(\s*#.*)?$", line)
    if m:
        out.append(f"{m.group(1)}={secrets.token_urlsafe(36)}{m.group(2) or ''}")
        n += 1
    else:
        out.append(line)
p.write_text("\n".join(out) + "\n")
p.chmod(0o600)
print(f"{n} secretos generados en .env (permisos 600)")
PY
