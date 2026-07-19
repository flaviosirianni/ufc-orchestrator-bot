# UFC Betting Bot Stabilization Design

## Objetivo

Restaurar la confianza operativa del bot UFC: datos deportivos verificados, wallet global consistente, un único poller Telegram y almacenamiento canónico recuperable, preservando sin cambios el ledger y su auditoría.

## Arquitectura

La frontera principal será un `EventTruthGate`. Los adaptadores de UFCStats, UFC oficial y Odds API producen candidatos con evidencia; un reconciliador exige corroboración antes de actualizar `current_event` o `next_event`. Los consumidores —news, mirrors, proyecciones, scoring y settlement— sólo reciben estados verificados y frescos.

`data_scrapper` seguirá siendo el productor de `ufc_stats.db`, pero publicará un artefacto versionado, validado y atómico. Billing productivo usará `external_required`; ningún outage podrá caer silenciosamente al store local. El runtime tendrá lifecycle central, lock por bot y restart budget persistente.

## Contratos

- Confianza de evento: `verified | degraded | invalid | stale`.
- Estado deportivo: `scheduled | live | completed | unknown`.
- Evento consumible: confianza `verified`, evidencia vigente y card válida.
- Stats consumibles: schema soportado, `quick_check=ok` y edad máxima de 36 horas.
- Billing productivo: requests externas idempotentes; fallo explícito sin mutación local.
- Datos protegidos: ledger, mutaciones, pagos, créditos, perfiles y odds cargadas por usuario.

## Data flow

1. Fuentes producen candidatos y health.
2. Reconciliador valida identidad, fecha y card con quorum.
3. Store persiste estado canónico y un log append-only de intentos.
4. Truth gate entrega sólo estados consumibles.
5. Monitores materializan datos deduplicados.
6. Telegram presenta información verificada o fallback seguro.

## Fallos y rollback

- Fuente ausente/conflictiva: conservar último válido dentro de TTL; fuera de TTL, fail-closed.
- Stats inválidas: no hacer swap y conservar DB anterior.
- Billing caído: bloquear operación facturable; no usar fallback productivo.
- 409 Telegram: backoff y alerta; no crear otro poller ni reiniciar en loop.
- Migración DB: candidato + backup + digests + swap; rollback por path/env y restart.

## Fuera de alcance

- Ejecución automática de apuestas.
- Features nuevas de Wishlist 38–41.
- Refactor masivo de `bettingWizard.js` o `sqliteStore.js` sin relación directa.
- Borrado del ledger o reinterpretación de resultados existentes.

## Aceptación

El cierre requiere tests de incidentes, gates de calidad/paridad, backups restaurables, smoke productivo no mutante y ventanas de observación de runtime y paths documentadas en el backlog.
