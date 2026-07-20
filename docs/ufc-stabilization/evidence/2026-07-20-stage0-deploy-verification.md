# Etapa 0 — Verificación de deploy

Fecha UTC: 2026-07-20

SHA desplegado: `1323308382fb72152914e6cf36a304ba92e92bdf`

## Resultado

- `main` y OCI avanzaron por fast-forward desde `1afddfa` hasta `1323308`.
- `billing-service` y `bot-factory@ufc` quedaron `active/running`.
- UFC quedó con `MainPID=1552431`, `NRestarts=0` y exactamente un proceso dentro de `bot-factory@ufc.service`.
- `/health` respondió HTTP 200.
- `PRAGMA quick_check` de la DB UFC devolvió `ok`.
- Los seis conjuntos protegidos conservaron conteo y SHA-256 exactos:
  - `bets`: 49 filas.
  - `bet_mutations`: 52 filas.
  - `credit_transactions`: 27 filas.
  - `ledger_summary`: 2 filas.
  - `mp_processed_payments`: 1 fila.
  - `user_credits`: 1 fila.
- El SHA de conteos global cambió porque el runtime agregó telemetría/snapshots; no cambió el ledger protegido.
- Desde el nuevo boot hasta el checkpoint hubo cero conflictos Telegram 409 y cero fallos de background categorizados.

## Señales pendientes

- El cold start tardó aproximadamente 218 segundos hasta abrir health.
- `ufc_stats.db` conserva mtime `2026-04-01T18:58:10.834Z`.
- Durante el arranque se volvió a reconciliar UFC 329 y se insertaron 5 proyecciones más 15 scoring snapshots. Esto confirma la necesidad del `EventTruthGate` y del fail-closed de UFC-STAB-100/101.

## Higiene de evidencia

La captura se ejecutó read-only. El JSON sanitizado se comparó localmente contra el baseline canónico y el archivo temporal `/tmp/ufc-stabilization-post-1323308.json` fue eliminado del servidor después de validar la copia.
