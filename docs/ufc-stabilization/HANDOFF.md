# UFC Stabilization Handoff

Actualizado: 2026-07-20

Estado general: Etapa 0 cerrada; UFC-STAB-100/101 verificando y UFC-STAB-102 en progreso

Branch: `stabilize/ufc-runtime-integrity`

Producción modificada durante esta ejecución: sí; `main`/OCI desplegados en `1323308382fb72152914e6cf36a304ba92e92bdf`

## Último checkpoint

- Worktree global creado desde `main` en commit `1afddfa`.
- Git preflight del worktree: `ok`.
- Backlog/spec/plan publicados en `origin/stabilize/ufc-runtime-integrity` mediante commit `333c4a8`; el pre-push Nutrition completo pasó.
- `npm install` completado desde `package-lock.json`.
- Baseline inicial: `npm test` terminaba con exit code 0 aunque `toolsHandlers` disparaba `Background cache refresh failed: Should not read Google Sheet when sqlite cache exists`.
- UFC-STAB-002 cerrado: quality pack versionado, instalador compatible con worktrees, `npm run quality:gate` y regresión `qualityPack.test.js` en verde.
- UFC-STAB-005 cerrado: el cache SQLite ya no dispara refresh sin ownership y el runner falla ante rechazos no manejados o `Timeout` residuales; `npm test` queda verde sin `Background cache refresh failed`.
- UFC-STAB-003 cerrado: perfiles UFC versionados, paths locales protegidos, token local/live comparado únicamente por hash y comandos `qa:parity:ufc`/`prepush:ufc` disponibles. El gate real pasó paridad de código, entorno, suite integral y verificación DB read-only.
- UFC-STAB-004 cerrado: CLI `ufc:baseline:capture`, esquema v1, cuatro fixtures anonimizados y pruebas de cero escrituras/PII verdes. La evidencia productiva sanitizada quedó en `docs/ufc-stabilization/evidence/2026-07-20-production-baseline.json`; el temp OCI exacto fue eliminado tras validar copia semántica.
- Baseline productivo confirmado: servicio `active/running`, health 200, DB UFC `quick_check=ok`, 36 tablas y seis digests protegidos completos. Señales críticas: `ufc_stats.db` mtime `2026-04-01`, 249.903 scoring snapshots, 83.301 projection snapshots, tablas Nutrition dentro de UFC y 915 conflictos Telegram 409 en las últimas 1.000 líneas. El health del proceso actual muestra cero conflictos porque su contador reinició con el proceso; journal conserva la evidencia histórica.
- Incidente de test cerrado: `qualityPack.test.js` heredó variables Git del primer `pre-push` y creó el commit temporal `4904932`. Se restauraron branch/índice sin tocar el working tree, se eliminaron sólo sus artefactos y se agregó una regresión que sanitiza las variables locales de Git. La branch remota fue corregida bajo lease exacto y local/origin/remoto coinciden en `4818365`.
- Preflight de merge detectó y corrigió la última secuela del mismo incidente: `core.bare` común había quedado en `true`. Se restauró a `false`, ambos worktrees vuelven a resolverse correctamente y la regresión ahora exige que HEAD y el modo no-bare permanezcan invariantes.
- Etapa 0 fusionada a `main`, publicada y desplegada por fast-forward `1afddfa..1323308`. `billing-service` y `bot-factory@ufc` quedaron `active/running`; UFC tiene un único proceso de su cgroup, health 200 y `NRestarts=0`.
- La captura post-deploy read-only confirmó `quick_check=ok` y coincidencia exacta de los seis conteos/digests protegidos. El archivo temporal remoto fue eliminado. Evidencia: `docs/ufc-stabilization/evidence/2026-07-20-stage0-deploy-verification.md`.
- El arranque UFC tardó aproximadamente 218 segundos hasta abrir `/health`; queda como señal de performance/runtime a investigar. Desde el boot verificado hubo cero 409, pero se volvió a publicar UFC 329 y se escribieron 5 proyecciones/15 scoring desde stats vencidas. La Etapa 1 debe contener esto antes de cualquier reconstrucción.
- UFC-STAB-100 local completo: `EventTruthGate` puro, migración aditiva, lectura legacy `invalid/verification_missing`, decisiones append-only y discovery web auditado como no consumible. Tests de UFC 329, `Preview`, stale-live, store legacy y suite completa verdes. No se desplegó todavía este cambio.
- UFC-STAB-101 local completo: revalidación al consumir, freshness stats por mtime con máximo 36 h, bloqueos de news/proyección/scoring/mirrors/settlement y vista segura para Telegram. Tests positivos y negativos verdes; una DB real conservó apuesta pending y conteo de mutaciones exacto.

## Estado de datos protegido

- Ledger productivo: sin cambios entre baseline y post-deploy (49 apuestas, 52 mutaciones, 27 movimientos locales, 2 resúmenes, 1 pago y 1 saldo; hashes idénticos).
- Billing productivo: servicio reiniciado; DB no migrada ni reconciliada en esta etapa.
- `event_watch_state`, mirrors y snapshots productivos: el runtime existente volvió a escribir estado/snapshots dudosos; no se borró ni reescribió evidencia.
- `ufc_stats.db`: sigue vencida, mtime `2026-04-01T18:58:10.834Z`.

## Próximo paso exacto

1. Continuar UFC-STAB-102 con test RED de snapshots idénticos repetidos y cambio material.
2. Agregar hash persistido e índices únicos compatibles con filas legacy; simular 24 h antes de marcar verificando.

## Rollback actual

El deploy de Etapa 0 puede revertirse mediante un commit de reversión y redeploy del servicio; no usar `reset --hard` ni tocar las DB. El baseline `1afddfa` y los digests pre/post permiten verificar la reversión. El worktree/branch deben conservarse hasta cerrar la estabilización.
