# UFC Stabilization Handoff

Actualizado: 2026-07-18

Estado general: Etapa 0 en progreso

Branch: `stabilize/ufc-runtime-integrity`

Producción modificada durante esta ejecución: no

## Último checkpoint

- Worktree global creado desde `main` en commit `1afddfa`.
- Git preflight del worktree: `ok`.
- Backlog/spec/plan publicados en `origin/stabilize/ufc-runtime-integrity` mediante commit `333c4a8`; el pre-push Nutrition completo pasó.
- `npm install` completado desde `package-lock.json`.
- Baseline inicial: `npm test` terminaba con exit code 0 aunque `toolsHandlers` disparaba `Background cache refresh failed: Should not read Google Sheet when sqlite cache exists`.
- UFC-STAB-002 cerrado: quality pack versionado, instalador compatible con worktrees, `npm run quality:gate` y regresión `qualityPack.test.js` en verde.
- UFC-STAB-005 publicado en commit `4818365`: el cache SQLite ya no dispara refresh sin ownership y el runner falla ante rechazos no manejados o `Timeout` residuales; `npm test` queda verde sin `Background cache refresh failed`. Permanece `VERIFYING` hasta el deploy de Etapa 0.
- UFC-STAB-003 cerrado: perfiles UFC versionados, paths locales protegidos, token local/live comparado únicamente por hash y comandos `qa:parity:ufc`/`prepush:ufc` disponibles. El gate real pasó paridad de código, entorno, suite integral y verificación DB read-only.
- UFC-STAB-004 cerrado: CLI `ufc:baseline:capture`, esquema v1, cuatro fixtures anonimizados y pruebas de cero escrituras/PII verdes. La evidencia productiva sanitizada quedó en `docs/ufc-stabilization/evidence/2026-07-20-production-baseline.json`; el temp OCI exacto fue eliminado tras validar copia semántica.
- Baseline productivo confirmado: servicio `active/running`, health 200, DB UFC `quick_check=ok`, 36 tablas y seis digests protegidos completos. Señales críticas: `ufc_stats.db` mtime `2026-04-01`, 249.903 scoring snapshots, 83.301 projection snapshots, tablas Nutrition dentro de UFC y 915 conflictos Telegram 409 en las últimas 1.000 líneas. El health del proceso actual muestra cero conflictos porque su contador reinició con el proceso; journal conserva la evidencia histórica.
- Incidente de test cerrado: `qualityPack.test.js` heredó variables Git del primer `pre-push` y creó el commit temporal `4904932`. Se restauraron branch/índice sin tocar el working tree, se eliminaron sólo sus artefactos y se agregó una regresión que sanitiza las variables locales de Git. La branch remota fue corregida bajo lease exacto y local/origin/remoto coinciden en `4818365`.
- Preflight de merge detectó y corrigió la última secuela del mismo incidente: `core.bare` común había quedado en `true`. Se restauró a `false`, ambos worktrees vuelven a resolverse correctamente y la regresión ahora exige que HEAD y el modo no-bare permanezcan invariantes.
- No se editaron bases, servicios, variables ni procesos productivos.

## Estado de datos protegido

- Ledger productivo: no tocado.
- Billing productivo: no tocado.
- `event_watch_state`, mirrors y snapshots productivos: no tocados.
- Los conteos/hashes autoritativos se capturarán en UFC-STAB-004 antes del primer cambio runtime.

## Próximo paso exacto

1. Publicar los commits locales UFC-STAB-004 y ejecutar deploy/verificación de Etapa 0; marcar UFC-STAB-005 `DONE` sólo después del smoke productivo.
2. Iniciar UFC-STAB-100 (`EventTruthGate`) mediante TDD y usar el baseline protegido como pre/post condición de todo cambio runtime.

## Rollback actual

No hay cambios de runtime que revertir. El worktree se puede retirar sin eliminar la branch. No borrar branches remotas ni datos.
