#!/usr/bin/env bash
# Ejecuta la suite E2E contra el servicio REAL ContextRAG_Engine + PostgreSQL real.
#   ./scripts/run_e2e.sh [ruta/al/checkout/de/contextrag_engine]
# Sin argumento clona https://github.com/Santidelacarrera/contextrag_engine en un directorio temporal.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
ENGINE="${1:-}"
if [ -z "$ENGINE" ]; then
  ENGINE="$WORK/contextrag_engine"
  GIT_LFS_SKIP_SMUDGE=1 git clone --depth 1 https://github.com/Santidelacarrera/contextrag_engine "$ENGINE"
fi
echo "ContextRAG_Engine @ $(git -C "$ENGINE" rev-parse --short HEAD)"
python3 -m venv "$WORK/venv"
"$WORK/venv/bin/pip" install -q fastapi uvicorn "psycopg[binary,pool]" rank-bm25 numpy httpx pydantic
cd "$HERE"
CONTEXTRAG_ENGINE_PATH="$ENGINE" CONTEXTRAG_PYTHON="$WORK/venv/bin/python" python3 -m pytest -q tests/e2e -rs "${@:2}"
