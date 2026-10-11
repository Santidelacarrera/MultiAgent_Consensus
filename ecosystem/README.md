# Segundo Cerebro — stack E2E unificado

Un único `docker-compose.yml` que levanta los nueve servicios del ecosistema con redes aisladas, volúmenes persistentes y
**un solo puerto publicado**: el gateway perimetral, y sólo en `127.0.0.1`.

```bash
cp .env.example .env
./scripts/gen_secrets.sh            # sustituye cada CHANGE_ME por un secreto aleatorio URL-safe (chmod 600)
./scripts/run_e2e_stack.sh          # build + up --wait + comprobación de puertos + suite E2E
./scripts/run_e2e_stack.sh --reset  # ídem y, al terminar, `down -v`
```

`run_e2e_stack.sh` sale con: `0` ok · `1` pruebas fallidas · `2` requisitos (docker, `.env`, `CHANGE_ME`) · `3` el stack no
llegó a estar sano en `WAIT_TIMEOUT` (420 s) · `4` hay puertos publicados de más. Ante un fallo vuelca `ps` y las últimas
líneas de log de los servicios no sanos.

## Topología

```
host ─127.0.0.1:8080─▶ shadowapi-guard ─┐ red `edge` + `internal`
                                        ▼
        internal (sin salida)   consensus-service ──▶ contextrag-engine ──▶ qdrant ┐
        nexusflow-engine ─────▶ (consensus, contextrag, docmind)          │         │ data (sin salida)
        docmind-api · docmind-worker · cloudcost-api ─────────────────────┴──▶ postgres · redis ┘
```

| Servicio | Papel | Redes | Persistencia |
|---|---|---|---|
| `postgres` | PG16 (+pgvector); una BD y un rol por servicio; roles de aplicación **sin superusuario ni BYPASSRLS** | data | `pg_data` |
| `qdrant` | vectores; el aislamiento por `tenant_id` lo imponen los clientes (filtro de payload obligatorio) | data | `qdrant_data` |
| `redis` | caché, anti-replay de firmas HMAC, rate limiting; **ACL por servicio** con prefijo de claves propio, usuario `default` deshabilitado | data | `redis_data` |
| `shadowapi-guard` | gateway/WAF: auth, rate limit, esquema estricto, escáner de amenazas, contexto firmado | edge, internal | — |
| `consensus-service` | comité de 3 agentes sobre **cada** respuesta RAG (fail-closed) + runs de consenso por tenant | internal, data | (Redis) |
| `contextrag-engine` | RAG híbrido particionado, auditoría con RLS, cifrado de chunks por tenant | internal, data | (Postgres/Qdrant) |
| `nexusflow-engine` | orquestador DAG/Saga | internal | `nexusflow_data` |
| `docmind-api` (+worker) | ingesta segura de documentos | internal, data | `docmind_documents` |
| `cloudcost-api` | guardrails FinOps y métricas | internal, data | (Postgres) |

`internal` y `data` son redes Docker `internal: true`: **sin salida a Internet ni al host**. Los contenedores de aplicación
corren con `cap_drop: ALL`, `no-new-privileges`, `init` y límite de PIDs; `consensus-service` además con FS de solo lectura.

## Secretos y claves

* Las claves de cliente existen **en claro sólo en `.env`**. `secrets-init` (sin red) deriva de ellas los ficheros que consumen
  los servicios, con **hashes SHA-256**: `tenants.json` (gateway) y `contextrag-keys.json` (ContextRAG, claves ligadas a tenant y rol).
* Cadena de confianza: cliente → gateway (API key/JWT + `X-Tenant`) → contexto **firmado con HMAC** (`GUARD_SIGNING_KEY`, 60 s de
  tolerancia, nonce anti-replay en Redis) → `consensus-service` → ContextRAG con una clave `reader` **por tenant**.
* Rotación: cambia el valor en `.env` y `docker compose up -d --force-recreate secrets-init shadowapi-guard contextrag-engine consensus-service`.
* `.env` está en `.gitignore`; `run_e2e_stack.sh` no arranca con `CHANGE_ME` pendientes.

## Qué prueba la suite (`e2e/e2e_stack.py`, corre dentro de la red interna)

Salud · 401/403/404/405/422 en el perímetro · inyección de prompt/SQL bloqueada · camino feliz gateway→comité→ContextRAG con citas ·
**aislamiento entre tenants** (consulta cruzada, runs ajenos → 404, auditoría por tenant) · **puenteo del gateway** (sin firma, firma
forjada, timestamp caducado, cuerpo alterado, replay → 401) · token de servicio de la ruta interna · acceso directo a ContextRAG sin clave.
La misma suite acepta URLs por entorno y se ensayó contra procesos locales (ver "Verificación").

## Matriz de contratos (estado real de los repositorios hermanos)

| Enlace | Contrato esperado | Estado | Qué hace el stack |
|---|---|---|---|
| gateway → RAG | `POST /v1/rag/query` | ContextRAG no lo expone | el upstream es `consensus-service`, que lo sirve pasando SIEMPRE por el comité |
| gateway → consenso | `POST /v1/consensus/run`, `GET …/runs/{id}` | sin servicio previo | implementado en `consensus-service` (1 ronda del comité; runs por tenant, TTL) |
| consensus → ContextRAG | `POST /api/v1/retrieve` | ✔ validado | clave `reader` por tenant |
| NexusFlow → ContextRAG | `/v1/retrieve` (supuesto) | ✘ la ruta real es `/api/v1/retrieve` | **GAP** informado por la sonda de contrato |
| NexusFlow → consenso | `POST /v1/consensus` + Bearer + `X-Tenant-Id` | ✔ | ruta interna de `consensus-service` |
| NexusFlow → DocMind | `POST /v1/parse` | ✘ DocMind ingiere como biblioteca, no cableada a su API | **GAP** |
| NexusFlow → escalado / entrega | `ESCALATION_URL`, `DELIVERY_URL` | sin servicio | host `*.unprovisioned.invalid`: falla cerrado, no simula éxito |
| DocMind → ContextRAG | ingesta de chunks | no existe el puente | **GAP** (la ingesta a RAG se hace hoy vía `POST /ingest` de ContextRAG) |

Los GAP se informan como `GAP` y no fallan la suite, salvo `STRICT_CONTRACTS=true`.

## Límites conocidos (honestidad técnica)

* **No hay TLS** dentro del stack (redes internas aisladas); en un despliegue real: mTLS o malla + `CONTEXTRAG_ALLOW_INSECURE_HTTP=false`.
* **Qdrant OSS no tiene RBAC por tenant**: el aislamiento depende de los filtros de payload de los clientes y de que sólo ContextRAG
  alcance Qdrant. Sin clave de API de Qdrant en este stack local.
* El comité es **determinista/léxico** (embeddings `hashing`, NLI `lexical`, LLM `extractive`): sin descargas ni red; la calidad semántica es la
  de esas heurísticas. Cambia `EMBEDDER=bge` etc. para modelos reales (imágenes mucho mayores).
* `ANTIVIRUS_PROVIDER=disabled` y `LLM_PROVIDER=mock` en DocMind; `COOKIE_SECURE=false` (HTTP local); `DEMO_ENABLED=false`.
* El gateway guarda su estado (bans, rate limit) en memoria: una réplica. Los repos se construyen desde Git por referencia
  (`*_REF`); para builds reproducibles fija SHAs o usa `*_CONTEXT` con rutas locales.
* Los scripts de init de Postgres sólo se ejecutan al inicializar el volumen: para recrear roles, `down -v`.

## Verificación realizada al escribir este stack

* `docker compose --env-file .env.example config` ✔ (sólo `shadowapi-guard` publica puerto, en `127.0.0.1`).
* `bash -n`/`py_compile` de scripts y suite ✔.
* **Ensayo a nivel de proceso** (no hay daemon Docker en el entorno de desarrollo): `bootstrap.py` → Redis real con el ACL generado por
  `redis/entrypoint.sh` (verificado: el usuario `consensus` no puede escribir `contextrag:*`) → PostgreSQL 16 real inicializado con
  `postgres/init/10-databases.sh` (roles sin BYPASSRLS) → ContextRAG real → `consensus-service` → `edge-gateway` real → `e2e_stack.py`:
  15/17 OK; las 2 restantes son las sondas de NexusFlow/DocMind, que ese ensayo no levantó.
* **No se han construido ni ejecutado las imágenes ni los contenedores.** `NexusFlow`, `DocMind` y `CloudCost` no se ejercitaron en
  contenedor; sus Dockerfiles, comandos y variables se tomaron de sus repositorios y deben confirmarse con el primer `run_e2e_stack.sh`.
