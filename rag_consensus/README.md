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
    config = RagClientConfig(base_url="https://context-rag.internal", api_key="…", retrieve_path="/v1/retrieve")
    async with RagClient(config) as client:
        orchestrator = ConsensusOrchestrator(client)
        out = await orchestrator.answer(RetrievalRequest(tenant_id="acme", query="¿Plazo de devolución?", top_k=5))
    if out.approved:
        print(out.answer, out.citations)
    else:
        print("BLOQUEADA:", out.decision.reasons, out.error_code)   # out.answer es None

asyncio.run(main())
```

## Contrato asumido con ContextRAG_Engine

> Este repositorio no tiene acceso al código de `ContextRAG_Engine`: el contrato es una **suposición explícita**
> y está centralizado en `client.py` (`_parse`, `_parse_chunk`). Si el endpoint real difiere, es el único sitio a adaptar.

```
POST {base_url}{retrieve_path}                 (por defecto /v1/retrieve)
  { "tenant_id": str, "query": str, "top_k": int, "filters"?: {...}, "min_score"?: float }
→ { "tenant_id"?: str,
    "draft_answer": str,                        (alias: "answer")
    "chunks": [ { "id": str, "text": str, "score": number, "tenant_id"?: str,
                  "source"?: str, "metadata"?: {...} } ] }      (alias: "chunk_id", "content")
```

Cualquier desviación (JSON inválido, tipos erróneos, >200 fragmentos, >2 MB) ⇒ `RagProtocolError`; no se "repara" en silencio.

## El comité

| Agente | Qué verifica | Veto |
|--------|--------------|------|
| `HallucinationCritic` | Cada afirmación del borrador frente a los fragmentos (solapamiento léxico por frase y por fragmento), cifras inventadas, nombres propios ausentes, citas `[id]`/`[n]` inexistentes. Una abstención honesta puntúa 1.0 | Respuesta con contenido pero **sin evidencia** |
| `TenantSecurityAuditor` | Todo fragmento pertenece al `tenant_id` pedido (también en `metadata`); la respuesta no declara otro tenant; el borrador no copia contenido ni menciona IDs de otro tenant; sin secretos/credenciales; PII (penaliza); **inyección de prompts** en el contexto (penaliza; veta si el borrador la repite) | Fuga entre tenants, fragmento sin `tenant_id` (no verificable), secretos, inyección reproducida |
| `CoherenceValidator` | Relevancia frente a la consulta, contradicciones directas, repetición degenerada, truncamiento, baja relevancia de la recuperación | — (una contradicción por sí sola hace fallar el umbral) |

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

`RagClient.retrieve` sólo lanza subclases de `RagError`: `RagConnectionError`, `RagTimeoutError`, `RagHttpError(status)`,
`RagProtocolError`. Reintenta con *backoff* exponencial ante errores de transporte y `429/502/503/504` (respeta
`Retry-After`, acotado a 5 s); los demás `4xx/5xx` no se reintentan. **El orquestador nunca propaga esos errores**: devuelve
un `GuardedAnswer` `REJECTED` con `error_code`, de modo que nadie pueda entregar por descuido una respuesta sin validar.

## Seguridad del conector

- HTTPS obligatorio salvo loopback (o `allow_insecure_http=True` explícito); verificación TLS no desactivable fuera de loopback.
- Sin credenciales en la URL; `api_key` fuera de `repr`; **no se siguen redirecciones** (no se reenvía el bearer a otro host).
- Los mensajes de error y los logs nunca contienen consultas, fragmentos ni cuerpos de respuesta; sólo códigos.
- `tenant_id` validado por expresión regular y longitud antes de cualquier llamada de red.
- Un borrador rechazado no aparece en ningún campo de `GuardedAnswer` (`answer=None`).

## Desarrollo

```bash
cd rag_consensus
python -m pip install -e '.[dev]'
python -m pytest -q          # 99 pruebas: cliente (httpx.MockTransport), agentes, consenso, orquestador y sockets reales en loopback
python -m mypy --strict src tests
```

## Límites conocidos

- Los agentes usan heurísticas léxicas (solapamiento, cifras, entidades): detectan bien invenciones de datos y fugas
  estructurales, pero no razonamiento semántico fino; para eso conviene añadir un agente-juez LLM (la interfaz ya lo permite)
  **sin** quitar los deterministas, que actúan como suelo de seguridad.
- El contrato con ContextRAG_Engine está supuesto (ver arriba) y no se ha probado contra el servicio real.
