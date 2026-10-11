#!/usr/bin/env bash
# Levanta el stack "Segundo Cerebro", espera a que TODOS los contenedores estén sanos y ejecuta la suite E2E.
#
#   ./scripts/run_e2e_stack.sh              # build + up + suite; deja el stack en marcha si todo va bien
#   ./scripts/run_e2e_stack.sh --down       # al terminar, `down` (conserva volúmenes)
#   ./scripts/run_e2e_stack.sh --reset      # al terminar, `down -v` (borra datos; el siguiente arranque es limpio)
#   ./scripts/run_e2e_stack.sh --no-build   # reutiliza imágenes existentes
#   WAIT_TIMEOUT=600 ./scripts/run_e2e_stack.sh
#
# Códigos de salida: 0 ok · 1 fallo de pruebas · 2 requisitos/entorno · 3 el stack no llegó a estar sano · 4 puertos expuestos de más
set -euo pipefail
cd "$(dirname "$0")/.."

TEARDOWN=none BUILD=--build
for a in "$@"; do
  case "$a" in
    --down) TEARDOWN=down ;;
    --reset) TEARDOWN=reset ;;
    --no-build) BUILD= ;;
    -h|--help) sed -n 2,11p "$0"; exit 0 ;;
    *) echo "opción desconocida: $a" >&2; exit 2 ;;
  esac
done
WAIT_TIMEOUT="${WAIT_TIMEOUT:-420}"
DC=(docker compose --env-file .env)

die() { echo "✖ $*" >&2; exit "${2:-2}"; }
step() { printf '\n▶ %s\n' "$*"; }

# ── requisitos ──────────────────────────────────────────────────────────────────────────────────────────────────
command -v docker >/dev/null || die "docker no está instalado"
docker compose version >/dev/null 2>&1 || die "falta el plugin 'docker compose' (v2)"
docker info >/dev/null 2>&1 || die "el daemon de Docker no responde"
[[ -f .env ]] || die "falta .env: cp .env.example .env && ./scripts/gen_secrets.sh"
if grep -qE '^[A-Z0-9_]+=CHANGE_ME' .env; then
  die "quedan secretos sin generar en .env ($(grep -cE '^[A-Z0-9_]+=CHANGE_ME' .env)): ejecuta ./scripts/gen_secrets.sh"
fi
step "validando la configuración de Compose"
"${DC[@]}" config --quiet || die "docker-compose.yml o .env inválidos"

cleanup() {
  local rc=$?
  if [[ $rc -ne 0 ]]; then
    step "diagnóstico (últimas líneas de los servicios no sanos)"
    "${DC[@]}" ps -a || true
    for s in $("${DC[@]}" ps -a --format '{{.Service}} {{.Health}} {{.State}}' 2>/dev/null | awk '$2!="healthy" && $3!="exited" || $3=="exited" {print $1}' | sort -u); do
      echo "── $s"; "${DC[@]}" logs --no-color --tail 40 "$s" 2>&1 | sed 's/^/   /' || true
    done
  fi
  case "$TEARDOWN" in
    down) step "docker compose down"; "${DC[@]}" --profile e2e down --remove-orphans || true ;;
    reset) step "docker compose down -v (borrando volúmenes)"; "${DC[@]}" --profile e2e down -v --remove-orphans || true ;;
  esac
  exit $rc
}
trap cleanup EXIT

# ── arranque ────────────────────────────────────────────────────────────────────────────────────────────────────
step "construyendo y levantando el stack (espera a healthchecks, máx. ${WAIT_TIMEOUT}s)"
# shellcheck disable=SC2086
"${DC[@]}" up -d $BUILD --wait --wait-timeout "$WAIT_TIMEOUT" || die "el stack no llegó a estar sano" 3

step "estado de los servicios"
"${DC[@]}" ps

# ── garantías de aislamiento ────────────────────────────────────────────────────────────────────────────────────
step "comprobando que SÓLO el gateway publica puertos"
published=$("${DC[@]}" ps --format '{{.Service}}|{{.Publishers}}' | awk -F'|' '$2 ~ /->/ {print $1}' | sort -u)
if [[ "$published" != "shadowapi-guard" ]]; then
  die "servicios con puertos publicados distintos del gateway: ${published:-<ninguno: el gateway tampoco publica>}" 4
fi
bound=$("${DC[@]}" port shadowapi-guard 8080)
case "$bound" in 127.0.0.1:*) echo "  ✓ gateway en $bound (sólo loopback)";; *) die "el gateway no está limitado a 127.0.0.1: $bound" 4;; esac

# ── suite E2E ───────────────────────────────────────────────────────────────────────────────────────────────────
step "ejecutando la suite E2E (contenedor en la red interna)"
"${DC[@]}" --profile e2e run --rm --build e2e || die "la suite E2E ha fallado" 1

echo
echo "✔ stack sano y suite E2E superada. Gateway: http://$("${DC[@]}" port shadowapi-guard 8080)"
