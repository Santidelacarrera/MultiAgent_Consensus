# Bitácora autónoma — MultiAgent Consensus (Nexus Security & AI Lab)

Sesión autónoma del 2026-10-12 · rama `feat/multiagent-consensus-autonomo-2026-10-12` · base `main`.

## Tareas y evidencia

| # | Tarea | Evidencia |
|---|---|---|
| 1 | Pruebas de consenso (mayoría, unanimidad, rechazo) con agentes simulados | `orchestrator/test/consensus_simulated.test.ts` — 28 pruebas; `npx jest --runInBand orchestrator/test/consensus_simulated.test.ts` |
| 2 | Verificar la firma de cada voto; un voto sin firma válida no cuenta | 4 falsificaciones (`unsigned`, `wrong_key`, `other_agent_key`, `altered_after_signing`) × (veto falsificado, aprobaciones falsificadas); `verifyResponse` unitario con 7 variantes. **Mutación**: con `verifyResponse` forzado a `true`, 9 de 28 fallan |
| 3 | Demo de extremo a extremo con agentes falsos | `npm run demo` → `8/8 escenarios con el resultado esperado` (bus en memoria, motor real, sin red) |

## Comandos ejecutados (resultado)

| Comando | Resultado |
|---|---|
| `npm run typecheck` | sin errores |
| `npm test` | 13 suites, **158 tests pasan** (antes 130) |
| `npm run build` | sin errores |
| `npm run demo` | 8/8 escenarios OK |
| `npm run audit` (`npm audit --omit=dev --audit-level=high`) | 0 vulnerabilidades en dependencias de producción |
| `cd gatekeeper && python3 -m pytest -q` | 50 passed |
| `cd rag_consensus && python3 -m mypy --strict src tests` | sin errores (34 ficheros) |
| `cd rag_consensus && python3 -m pytest -q` | 145 passed, 13 skipped (E2E con ContextRAG real: corren en CI) |
| `bandit -r gatekeeper/app rag_consensus/src ecosystem/init ecosystem/e2e` | 0 high, 0 medium; 3 low (`assert` para estrechar tipos en `service/app.py`) |
| `ruff check --select E9,F` (mismos directorios) | All checks passed |
| `docker compose --env-file .env.example --profile e2e config --quiet` (en `ecosystem/`) | OK |

## Decisiones

| Fecha | Decisión | Motivo |
|---|---|---|
| 2026-10-12 | `ScriptedAgent` hereda de `BaseAgent` en vez de reimplementar el protocolo | así firma, ancla hallazgos y recalcula el voto como los agentes reales; el test ejercita el camino real |
| 2026-10-12 | El guion fija la *evidencia* (hallazgos), no el voto | el orquestador no confía en el voto declarado; el guion no debe poder saltarse esa regla |
| 2026-10-12 | Escenarios y falsificaciones en `src/demo/` (no en `test/`) | componente reutilizable: la demo y los tests comparten el mismo catálogo |
| 2026-10-12 | `npm run audit` omite dependencias de desarrollo | `npm audit` completo marca `braces` (alto, ReDoS) sólo vía la cadena de Jest 29; subir a Jest 30 es un cambio mayor fuera del alcance. Producción: 0 |
| 2026-10-12 | `# nosec B104/B310` con justificación; `assert`→`if` en `bootstrap.py` | B104: escucha dentro del contenedor sin puerto publicado; B310: sólo se admiten URLs http(s) |

## Pendientes para Santiago

1. **Aprobar y fusionar el PR** (no lo hago yo).
2. Valorar subir Jest a 30 para eliminar el aviso alto de `braces` en herramientas de desarrollo.
3. Ejecutar `ecosystem/scripts/run_e2e_stack.sh` en una máquina con Docker: las imágenes de NexusFlow/DocMind/CloudCost siguen sin construirse (ver `ecosystem/README.md`).
4. Contratos entre repos hermanos sin alinear (NexusFlow→ContextRAG/DocMind): requieren cambios en otros proyectos, fuera de este alcance.
5. La nota del vault del proyecto no es accesible desde esta sesión: esta bitácora es su copia; trasladarla.

## Riesgos conocidos

- Los agentes simulados validan la política de consenso y la verificación de firmas, no la calidad de las heurísticas de los agentes reales.
- Las firmas HMAC por agente derivan de un secreto compartido del bus: un orquestador comprometido puede firmar por cualquiera (límite del modelo, ya documentado en el README).
