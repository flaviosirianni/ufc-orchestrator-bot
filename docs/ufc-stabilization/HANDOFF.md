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
- UFC-STAB-004 en `VERIFYING`: CLI `ufc:baseline:capture`, esquema v1, cuatro fixtures anonimizados y pruebas de cero escrituras/PII están verdes. Sobre la DB local real: `quick_check=ok`, 24 tablas, 47 bets y 46 mutaciones. La captura productiva no terminó: dos ejecuciones read-only duplicadas quedaron leyendo la DB grande y fueron canceladas sólo por sus PIDs SSH locales; desde entonces TCP/22 responde pero SSH no entrega banner. No se tocó ni reinició ningún servicio.
- Incidente de test cerrado: `qualityPack.test.js` heredó variables Git del primer `pre-push` y creó el commit temporal `4904932`. Se restauraron branch/índice sin tocar el working tree, se eliminaron sólo sus artefactos y se agregó una regresión que sanitiza las variables locales de Git. La branch remota fue corregida bajo lease exacto y local/origin/remoto coinciden en `4818365`.
- No se editaron bases, servicios, variables ni procesos productivos.

## Estado de datos protegido

- Ledger productivo: no tocado.
- Billing productivo: no tocado.
- `event_watch_state`, mirrors y snapshots productivos: no tocados.
- Los conteos/hashes autoritativos se capturarán en UFC-STAB-004 antes del primer cambio runtime.

## Próximo paso exacto

1. Cuando SSH vuelva a entregar banner, copiar la versión optimizada de `operationalSnapshot.js` al temp existente y ejecutar una sola captura; conservar el JSON sanitizado bajo `docs/ufc-stabilization/evidence/` y retirar sólo `/tmp/ufc-stabilization-snapshot-af78911`.
2. Marcar UFC-STAB-004 `DONE`, cerrar/deployar Etapa 0 y recién entonces iniciar UFC-STAB-100 (`EventTruthGate`) mediante TDD.

## Rollback actual

No hay cambios de runtime que revertir. El worktree se puede retirar sin eliminar la branch. No borrar branches remotas ni datos.
