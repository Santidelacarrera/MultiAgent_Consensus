# rag_consensus

Conector HTTP hacia **ContextRAG_Engine** y comité de consenso **fail-closed** para `MultiAgent_Consensus`.
Ninguna respuesta del motor RAG llega al usuario sin que tres agentes especializados la aprueben por unanimidad.

```
RetrievalRequest ──► RagClient ──POST──► ContextRAG_Engine
 (tenant_id, query,     │   reintentos · timeouts · TLS · límites
  top_k, filters)       ▼
                 RetrievalResponse (borrador + fragmentos crudos)
                        │
        ┌───────────────┼────────────────┐        (asyncio.gather, timeout por agente)
        ▼               ▼                ▼
 HallucinationCritic  TenantSecurityAuditor  CoherenceValidator
   puntuación 0‑1       puntuación 0‑1 + veto    puntuación 0‑1
        └───────────────┼────────────────┘
                        ▼
             consensus.decide()  ── fail‑closed ──►  GuardedAnswer
                                                      APPROVED → answer
                                                      REJECTED → answer = None
```

## Uso

```python
import asyncio
from rag_consensus import ConsensusOrchestrator, RagClient, RagClientConfig, RetrievalRequest

async def main() -> None:
    config = RagClientConfig(base_url="https://context-rag.internal", api_key="…")   # POST /api/v1/retrieve
    async with RagClient(config) as client:
        orchestrator = ConsensusOrchestrator(client)
        out = await orchestrator.answer(RetrievalRequest(tenant_id="acme", query="¿Plazo de devolución?", top_k=5))   # top_k ≤ 20
    if out.approved:
        print(out.answer, out.citations)
    else:
        print("BLOQUEADA:", out.decision.reasons, out.error_code)   # out.answer es None

asyncio.run(main())
```

## Contrato con ContextRAG_Engine

Verificado contra el código del servicio (`contextrag/api/retrieval.py`, commit `83869d8`) **y contra una instancia real**
en la suite E2E. Todo el contrato vive en `client.py` (docstring, `_parse`, `_parse_fragment`).

```
POST {base_url}/api/v1/retrieve                            (retrieve_path = DEFAULT_RETRIEVE_PATH)
Cabeceras:  X-API-Key: <clave ligada a un tenant>      X-Tenant: <tenant_id>
Cuerpo:     {"tenant_id": str, "query": str (1..4000), "top_k": int (1..20)}      ← el servicio usa extra="forbid"
200 →       {"status": "ok" | "no_results", "tenant_id": str, "query": str,
             "fragments": [{"index": int≥1, "score": float, "doc_id": str, "source": str, "section": str,
                            "page": int|null, "start": int, "end": int, "text": str}],
             "draft_answer": str | null,  "draft_verified": false,  "latency_ms": float}
Errores:    401 clave inválida · 403 tenant ≠ tenant de la clave · 422 cuerpo inválido · 429 límite · 503 BD de auditoría caída
```

Decisiones derivadas del contrato real:

- **Los fragmentos no llevan `tenant_id`**: el motor filtra por tenant en la búsqueda y declara el tenant a nivel de respuesta.
  El cliente exige ese `tenant_id` (si falta ⇒ `RagProtocolError`) y lo estampa en cada `Chunk`; el auditor lo compara con el
  solicitado (`RESPONSE_TENANT_MISMATCH` / `CROSS_TENANT_LEAK` ⇒ veto). La garantía de aislamiento *dentro* del motor sigue
  siendo suya (filtro + RLS); el comité verifica lo que es verificable desde fuera.
- **`draft_answer: null`** (el motor no encontró respuesta) ⇒ se sustituye por un texto propio (`NO_ANSWER_TEXT`), que el comité
  valida como abstención; nunca se inventa contenido del motor.
- Las citas del borrador son `[n]` con `n = index` del fragmento: el crítico de alucinaciones las valida contra esos índices.
- `top_k` máximo 20; el cliente no envía `filters`/`min_score` (el servicio los rechazaría con 422).
- `draft_verified` es siempre `false`: precisamente por eso existe este comité.

## El comité

| Agente | Qué verifica | Veto |
|--------|--------------|------|
| `HallucinationCritic` | Cada afirmación del borrador frente a los fragmentos (solapamiento léxico por frase y por fragmento), cifras inventadas **y cifras reales usadas en otro contexto** (una cifra debe aparecer en una frase fuente que además sustente la afirmación: que «90» figure en otra frase del fragmento no avala «el plazo es de 90 días»), nombres propios ausentes, citas `[n]` inexistentes. Una abstención honesta puntúa 1.0 | Respuesta con contenido pero **sin evidencia** |
| `TenantSecurityAuditor` | Todo fragmento pertenece al `tenant_id` pedido (también en `metadata`); la respuesta no declara otro tenant; el borrador no copia contenido ni menciona IDs de otro tenant; sin secretos/credenciales; PII (penaliza); **inyección de prompts** en el contexto (penaliza; veta si el borrador la repite) | Fuga entre tenants, fragmento sin `tenant_id` (no verificable), secretos, inyección reproducida |
| `CoherenceValidator` | Relevancia frente a la consulta, contradicciones directas, repetición degenerada, truncamiento y (opcional, `retrieval_score_floor`) baja relevancia de la recuperación; la escala de `score` depende del reranker del motor, por eso no se asume ninguna | — (una contradicción por sí sola hace fallar el umbral) |

Los agentes son deterministas (sin LLM): reproducibles, auditables y sin coste. Se pueden sustituir o ampliar con cualquier
objeto que cumpla `CommitteeAgent` (`name` + `async assess(ctx) -> Assessment`), p. ej. un juez basado en LLM.

## Consenso fail-closed (`consensus.decide`)

`APPROVED` **sólo si** se cumplen todas estas condiciones; ante cualquier duda es `REJECTED`:

1. respondieron los 3 agentes requeridos (fallo, timeout, ausencia o voto duplicado ⇒ rechazo);
2. cada puntuación es finita y está en `[0, 1]` (NaN/∞/fuera de rango ⇒ rechazo);
3. ningún agente emitió **veto**;
4. cada agente alcanza su mínimo (por defecto: alucinación 0.75 · tenant 0.90 · coherencia 0.60) — unanimidad;
5. la media ponderada (0.40 / 0.35 / 0.25) alcanza `aggregate_threshold` (0.80).

Un agente no puede votar en nombre de otro (`InvalidAssessment`) y los agentes ajenos a la política no cuentan.
`ConsensusDecision.reasons` explica cada rechazo con códigos estables (`VETO:…`, `BELOW_MIN:…`, `AGENT_FAILED:…`, …).

## Errores de red

## Auditoría

Cada decisión (aprobada, rechazada o por fallo del motor) genera un `AuditRecord` con `request_id`, **`tenant_id`**, veredicto,
puntuación agregada, puntuación/veto/códigos de hallazgo de cada agente, motivos, `error_code` e ids de fragmentos, más la correlación con el motor (`engine.request_id` = cabecera `X-Request-Id` de ContextRAG_Engine, y si falló su código de error y estado HTTP). **Nunca** contiene
la consulta, el borrador ni el texto de los fragmentos, y los mensajes de los hallazgos tampoco citan el borrador. El destino es un
`AuditSink` (por defecto `LoggingAuditSink`: una línea JSON en el logger `rag_consensus.audit`). La auditoría es *fail-closed*: si
`emit` lanza, la respuesta se retiene (`AUDIT_FAILED`).

## Errores de red

`RagClient.retrieve` sólo lanza subclases de `RagError`: `RagConnectionError`, `RagTimeoutError`, `RagHttpError(status)`,
`RagProtocolError`. Reintenta con *backoff* exponencial ante errores de transporte y `429/502/503/504` (respeta
`Retry-After`, acotado a 5 s); los demás `4xx/5xx` no se reintentan. **El orquestador nunca propaga esos errores**: devuelve
un `GuardedAnswer` `REJECTED` con `error_code`, de modo que nadie pueda entregar por descuido una respuesta sin validar.

## Seguridad del conector

- HTTPS obligatorio salvo loopback (o `allow_insecure_http=True` explícito); verificación TLS no desactivable fuera de loopback.
- Sin credenciales en la URL; `api_key` fuera de `repr`; **no se siguen redirecciones** (no se reenvía el bearer a otro host).
- Los mensajes de error, los logs y los hallazgos nunca contienen consultas, fragmentos ni borradores; sólo códigos y recuentos.
- `tenant_id` validado por expresión regular y longitud antes de cualquier llamada de red.
- Un borrador rechazado no aparece en ningún campo de `GuardedAnswer` (`answer=None`).

## Desarrollo y verificación

```bash
cd rag_consensus
python -m pip install -e '.[dev]'
python -m pytest -q                  # 109 pruebas rápidas: cliente (MockTransport), agentes, consenso, orquestador, sockets reales en loopback
python -m mypy --strict src tests
./scripts/run_e2e.sh                 # +13 E2E contra el servicio REAL ContextRAG_Engine y PostgreSQL real (clona y prepara todo)
```

La suite E2E (`tests/e2e/`) levanta PostgreSQL 16 efímero (rol de aplicación sin `BYPASSRLS`), arranca el servicio real con tres
documentos de dos tenants y claves de API ligadas a tenant, y comprueba: respuesta aprobada con cita y auditoría con `tenant_id`;
aislamiento entre tenants; coherencia entre la auditoría del comité y la del motor (RLS incluida); suplantación de tenant (`403`);
clave inválida (`401`); documento envenenado con *prompt injection*; caída de la BD del motor (`503` ⇒ fail-closed); y, con fragmentos reales y el borrador alterado después de recibirlos, que **cada agente bloquea por su cuenta** (cifra cambiada ⇒ crítico, contradicción ⇒ coherencia, tenant reetiquetado ⇒ veto del auditor) y que la respuesta legítima supera los tres umbrales y el agregado.
Sin `CONTEXTRAG_ENGINE_PATH`/`CONTEXTRAG_PYTHON`/PostgreSQL esas pruebas se **omiten** con el motivo.
Probado contra `contextrag_engine@479f81f` (HEAD con `retrieval_audit` particionada por meses y `X-Request-Id`); el contrato de petición/respuesta es idéntico al de `@83869d8`.

## Límites conocidos

- Los agentes usan heurísticas léxicas (solapamiento, cifras, entidades): detectan bien invenciones de datos y fugas
  estructurales, pero no razonamiento semántico fino; para eso conviene añadir un agente-juez LLM (la interfaz ya lo permite)
  **sin** quitar los deterministas, que actúan como suelo de seguridad.
- El motor se probó con su stack `offline` (embeddings *hashing*, reranker léxico, índices en memoria) y generador extractivo; con
  embeddings/rerankers/LLM reales cambian las puntuaciones y los borradores, no el contrato.
- Tenant: el comité sólo puede verificar el tenant *declarado* por el motor (los fragmentos no llevan el suyo); un motor que
  etiquete mal contenido ajeno sólo se detecta por huellas (IDs/contenido ajenos, secretos), no por etiqueta.
