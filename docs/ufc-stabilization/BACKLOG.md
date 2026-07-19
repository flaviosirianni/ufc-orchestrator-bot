# UFC Betting Bot Stabilization Backlog

Actualizado: 2026-07-18

Branch de trabajo: `stabilize/ufc-runtime-integrity`

Objetivo: recuperar veracidad deportiva, consistencia de billing, estabilidad operativa e integridad de datos sin modificar el significado ni el historial del ledger.

## Reglas de seguimiento

- Estados válidos: `BLOCKED`, `READY`, `IN_PROGRESS`, `VERIFYING`, `DONE`, `WAITING_OBSERVATION`, `ROLLED_BACK`.
- Antes de tocar un ítem, cambiarlo a `IN_PROGRESS` y completar `Última actualización` y `Próximo paso`.
- Un ítem de runtime sólo puede pasar a `DONE` después de tests, merge, deploy y evidencia productiva.
- Cada cambio de estado se commitea junto con el código o evidencia correspondiente.
- Al cerrar una sesión se actualiza `docs/ufc-stabilization/HANDOFF.md` y se sube la branch.
- El ledger, sus receipts, mutaciones, pagos y créditos nunca se purgan ni se reescriben de manera silenciosa.

## Resumen

| Etapa | Estado | Resultado requerido |
| --- | --- | --- |
| 0. Control y baseline | IN_PROGRESS | Backlog retomable, workspace aislado, calidad y paridad ejecutables |
| 1. Contención | BLOCKED | Ningún dato deportivo dudoso produce output o mutaciones |
| 2. Fuentes deportivas | BLOCKED | Stats frescas y current/next reconciliados por fuentes corroboradas |
| 3. Billing | BLOCKED | Wallet global como única fuente productiva, sin dobles movimientos |
| 4. Runtime | BLOCKED | Un poller por token y restart budget persistente |
| 5. Datos | BLOCKED | Paths canónicos, DB UFC-only y retención recuperable |
| 6. Cierre | BLOCKED | Matriz completa, runbooks, smoke y observación documentada |

## Etapa 0 — Control de ejecución y baseline

| ID | Prioridad | Estado | Dependencias | Acción y diseño | Aceptación y pruebas | Evidencia / próximo paso |
| --- | --- | --- | --- | --- | --- | --- |
| UFC-STAB-000 | crítica | DONE | — | Crear worktree global y branch aislada desde `main`; configurar upstream y no editar `main`. Rollback: remover sólo el worktree sin borrar la branch. | Guard Git `preflight` en estado `ok`, worktree limpio y suite base ejecutada. | Worktree global creado; branch publicada con upstream después de pasar el hook obligatorio. |
| UFC-STAB-001 | crítica | DONE | UFC-STAB-000 | Crear backlog, handoff, spec, plan; enlazar desde Wishlist y marcar el plan anterior como histórico. | Otra sesión puede identificar branch, SHA, estado, evidencia y siguiente comando sin reconstruir contexto. | Commit `333c4a8`, publicado en `origin/stabilize/ufc-runtime-integrity`. |
| UFC-STAB-002 | alta | DONE | UFC-STAB-001 | Aplicar quality pack, documentar símbolos nuevos y asociar tests/evidencia runtime. | `check-quality-pack.sh` sin bloqueos. | `qualityPack.test.js`, `npm run quality:gate` y fixture Git/worktree en verde; el fixture sanitiza variables Git heredadas por hooks, se autolimpia y configura `core.hooksPath=.githooks`. |
| UFC-STAB-003 | crítica | DONE | UFC-STAB-002 | Crear perfil de paridad UFC, safety local, required keys y scripts `qa:parity:ufc`/`prepush:ufc`. | El gate detecta token/path productivo local y valida code/env/test parity. | RED bloqueó `UFC_STATS_DB_PATH` productivo y perfiles ausentes. GREEN: `qa:parity:ufc` pasó code/env/test parity y DB verify read-only; perfil local sintético ignorado por Git. |
| UFC-STAB-004 | crítica | VERIFYING | UFC-STAB-001 | Versionar formato de snapshot operativo anonimizado: ledger digests, tablas, paths, systemd, health y logs. | Dos snapshots pueden compararse sin exponer tokens, chat IDs ni PII. | CLI/fixtures/TDD verdes: cero escrituras, digests sensibles a mutación, health/journal sanitizados. Captura local real: quick_check OK, 24 tablas, 47 bets y 46 mutaciones. Falta evidencia productiva: OCI acepta TCP/22 pero no entrega banner SSH tras cancelar dos lecturas diagnósticas duplicadas; no se reinició ningún servicio. |
| UFC-STAB-005 | alta | VERIFYING | UFC-STAB-001 | Endurecer el runner para fallar ante errores de background, unhandled rejections y timers abiertos. | El incidente de `toolsHandlers` falla en RED y queda verde sólo al esperar/cancelar el refresh. | Commit `4818365` publicado. RED confirmó 1 lectura indebida; GREEN sirve SQLite sin I/O oculto. Marcar `DONE` junto con deploy/verificación de Etapa 0. |

## Etapa 1 — Contención inmediata y fail-closed

| ID | Prioridad | Estado | Dependencias | Acción y diseño | Aceptación y pruebas | Evidencia / próximo paso |
| --- | --- | --- | --- | --- | --- | --- |
| UFC-STAB-100 | crítica | BLOCKED | Etapa 0 | Introducir `EventTruthGate`; separar estado deportivo de confianza y persistir evidencia/reasons. | Eventos `invalid/stale/degraded` no son consumibles; tests UFC 329 y fragmentos `Preview`. | Desbloquear tras gates de Etapa 0. |
| UFC-STAB-101 | crítica | BLOCKED | UFC-STAB-100 | Aplicar gate a proyecciones, scoring, news, mirrors y auto-settlement; exigir stats frescas. | Stats vencidas no escriben snapshots ni cierran apuestas; la apuesta abierta permanece igual. | Capturar digest de ledger antes/después. |
| UFC-STAB-102 | crítica | BLOCKED | UFC-STAB-100 | Hash determinístico e índices de dedupe para projection/scoring. | Fake clock 24 h inserta sólo snapshot inicial y cambios reales. | Migración con backup y rollback definidos. |
| UFC-STAB-103 | alta | BLOCKED | UFC-STAB-100 | Ampliar `/health` con evento, stats, Odds, billing y mantenimiento sin secretos. | Campos aditivos, timestamps y reasons verificables; tests del contrato HTTP. | Health no debe disparar I/O mutante. |
| UFC-STAB-104 | crítica | BLOCKED | UFC-STAB-100, UFC-STAB-004 | Tras backup, marcar inválidos estados UFC 329/live viejo y mirrors garbled; conservar evidencia. | Ninguna fila de ledger cambia; output Telegram queda fail-closed. | Primero dry-run y listado exacto de filas operativas. |
| UFC-STAB-105 | crítica | BLOCKED | UFC-STAB-100..104 | Gate, push, deploy, refresh forzado y observación 24 h con rollback por kill switch. | Cero cartelera falsa, snapshots repetidos o settlements no verificados. | Usar playbook AGENTS y registrar health/logs. |

## Etapa 2 — Fuentes deportivas y actualización automática

| ID | Prioridad | Estado | Dependencias | Acción y diseño | Aceptación y pruebas | Evidencia / próximo paso |
| --- | --- | --- | --- | --- | --- | --- |
| UFC-STAB-200 | crítica | BLOCKED | Etapa 1 | En `data_scrapper`: fechas ISO, escrituras atómicas, rechazo de futuros/completados sin stats y fixtures HTML. | Parser y conversión rechazan datos incompletos sin corromper JSON/estado previo. | Branch separada `fix/ufc-stats-pipeline`. |
| UFC-STAB-201 | crítica | BLOCKED | UFC-STAB-200 | Agregar metadata de schema/generación y corregir sorting textual por fecha. | `event_date_iso`, `generated_at`, conteos y `quick_check` presentes. | Verificar compatibilidad hacia atrás en `ufcStatsTool`. |
| UFC-STAB-202 | alta | BLOCKED | UFC-STAB-201 | Instalar scraper OCI y timer dos veces por día con single-flight y logs. | Dos corridas consecutivas idempotentes; timer visible y activo. | No desplegar sin rollback del DB anterior. |
| UFC-STAB-203 | crítica | BLOCKED | UFC-STAB-202 | Construir candidato, validar, swap atómico, restart UFC y rollback automático. | Bot abre la nueva DB y health expone frescura <36 h. | Comparar SHA y metadata antes/después. |
| UFC-STAB-204 | crítica | BLOCKED | UFC-STAB-201 | Resolver current/next con UFCStats, UFC oficial y Odds; quorum de dos fuentes. | UFC 329 falso es rechazado; estado válido no se reemplaza por candidato single-source. | Log append-only de candidatos. |
| UFC-STAB-205 | crítica | BLOCKED | UFC-STAB-204 | Declarar `live` sólo con señal Odds corroborada; aplicar ventana temporal completa. | Sin Odds, permanece `scheduled`; no hay falsos “no hay evento”. | Casos frontera local 23:30/00:30. |
| UFC-STAB-206 | alta | BLOCKED | Etapa 1 | Circuit breaker 401, backoff, cuota reservada y refresh inicial condicionado a stale cache. | 401 no genera loop; cuota bajo reserva bloquea llamadas no esenciales. | Fixture de auth/quota. |
| UFC-STAB-207 | crítica | BLOCKED | UFC-STAB-203..206 | Reconstruir current/next/mirrors/proyecciones desde fuentes verificadas. | Estado y card canónicos, candidatos rechazados auditados. | Backup y digest ledger obligatorios. |

## Etapa 3 — Billing global consistente

| ID | Prioridad | Estado | Dependencias | Acción y diseño | Aceptación y pruebas | Evidencia / próximo paso |
| --- | --- | --- | --- | --- | --- | --- |
| UFC-STAB-300 | crítica | BLOCKED | Etapa 1 | `BILLING_MODE=external_required|local`; prod external, local sólo dev. | Config inválida falla al arrancar; ningún fallback implícito. | Test de bootstrap. |
| UFC-STAB-301 | crítica | BLOCKED | UFC-STAB-300 | Fail-closed para saldo/gasto/recarga cuando billing externo cae. | Cero filas nuevas en credits local y respuesta no confirma éxito. | Test de outage. |
| UFC-STAB-302 | crítica | BLOCKED | UFC-STAB-300 | Idempotency keys determinísticas por operación estable. | Retry produce una transacción. | Tests spend/topup/webhook. |
| UFC-STAB-303 | alta | BLOCKED | UFC-STAB-300 | Health de billing con latencia, trace y último estado sin token. | Contrato health probado. | Sin PII/secretos. |
| UFC-STAB-304 | crítica | BLOCKED | UFC-STAB-301..303 | CLI dry-run de reconciliación y claves `legacy_ufc:<id>`. | Reporte por usuario y delta, sin writes por defecto. | Backups UFC+billing requeridos. |
| UFC-STAB-305 | crítica | BLOCKED | UFC-STAB-304 | Aplicar sólo reconciliación determinística en transacción. | `after=before+delta`, sin duplicados; ambigüedad bloquea. | Receipt de migración. |
| UFC-STAB-306 | crítica | BLOCKED | UFC-STAB-305 | Deploy y smoke de saldo/listado/gasto/webhook simulado. | Actividad nueva sólo en billing global. | No efectuar recarga real. |

## Etapa 4 — Runtime, polling y guard

| ID | Prioridad | Estado | Dependencias | Acción y diseño | Aceptación y pruebas | Evidencia / próximo paso |
| --- | --- | --- | --- | --- | --- | --- |
| UFC-STAB-400 | crítica | BLOCKED | Etapa 1 | Supervisor de handles; shutdown de monitores; impedir doble bootstrap. | Dos bootstraps no crean timers/pollers duplicados. | Fake timers y SIGTERM. |
| UFC-STAB-401 | crítica | BLOCKED | UFC-STAB-400 | Lock exclusivo por bot e instance/PID/boot/token fingerprint en health. | Segundo proceso falla sin iniciar polling. | No exponer token. |
| UFC-STAB-402 | crítica | BLOCKED | UFC-STAB-400 | Estado `polling_owner_conflict`, backoff+jitter y recovery acotado. | 409 no crea consumidor adicional ni restart loop. | Test de secuencia de errores. |
| UFC-STAB-403 | crítica | BLOCKED | UFC-STAB-402 | Guard con `flock`, estado persistente y restart budget; no reiniciar sólo por 409. | Máximo configurado por hora y alertas deduplicadas. | Tests shell existentes ampliados. |
| UFC-STAB-404 | alta | BLOCKED | UFC-STAB-401..403 | Start limits systemd, `KillMode=control-group`, proceso único. | `systemctl show/status` y `pgrep` consistentes. | Rollback units documentado. |
| UFC-STAB-405 | alta | BLOCKED | UFC-STAB-403 | Postmortem con evidencia y nivel de confianza. | No afirmar causa no demostrada. | Incluir 303 restarts y crecimiento abril. |
| UFC-STAB-406 | crítica | BLOCKED | UFC-STAB-404 | Soak de siete días. | Cero storms/duplicados y cadencias normales. | Estado `WAITING_OBSERVATION` durante ventana. |

## Etapa 5 — Paths, separación de datos y compactación

| ID | Prioridad | Estado | Dependencias | Acción y diseño | Aceptación y pruebas | Evidencia / próximo paso |
| --- | --- | --- | --- | --- | --- | --- |
| UFC-STAB-500 | crítica | BLOCKED | Etapas 1,3 | Migrador con allowlist UFC y digests de tablas protegidas. | Dry-run describe shape/counts sin mutar. | Data migration preflight strict. |
| UFC-STAB-501 | crítica | BLOCKED | UFC-STAB-500 | Backups restaurables SHA-256 de UFC/stats/billing y archivo 365 días. | Restore drill y quick_check. | Recovery point previo a todo apply. |
| UFC-STAB-502 | crítica | BLOCKED | UFC-STAB-501 | Cutover a `/home/ubuntu/bot-data/ufc/*`; alinear manifest/env/tools. | Sin drift y rollback por env/path probado. | Mantener path viejo 14 días. |
| UFC-STAB-503 | crítica | BLOCKED | UFC-STAB-502 | DB UFC-only; excluir tablas Nutrition; congelar credits locales auditables. | Digests protegidos idénticos. | No drop in-place. |
| UFC-STAB-504 | alta | BLOCKED | UFC-STAB-503 | Política de retención recuperable por tabla. | Nunca selecciona ledger/payments/credits/user odds. | Tests de selección y límites. |
| UFC-STAB-505 | crítica | BLOCKED | UFC-STAB-501,504 | Dry-run, delete por lotes y VACUUM offline sobre candidato. | DB menor, íntegra y con últimos snapshots históricos. | Swap atómico. |
| UFC-STAB-506 | alta | BLOCKED | UFC-STAB-505 | Job diario condicionado a backup reciente, con reporte. | Idempotente y bounded. | Timer/CLI health. |
| UFC-STAB-507 | alta | BLOCKED | UFC-STAB-502 | Observar 14 días y retirar path viejo conservando archivo. | Rollback ya no requerido y archivo recuperable. | `WAITING_OBSERVATION` hasta la fecha. |

## Etapa 6 — Cierre

| ID | Prioridad | Estado | Dependencias | Acción y diseño | Aceptación y pruebas | Evidencia / próximo paso |
| --- | --- | --- | --- | --- | --- | --- |
| UFC-STAB-600 | crítica | BLOCKED | Etapas 1..5 | Matriz full: sintaxis, unit, integración, ledger, incidentes, fake-clock, migración y restore. | Cero fallos y output sin errores ocultos. | Adjuntar comandos y conteos. |
| UFC-STAB-601 | crítica | BLOCKED | UFC-STAB-600 | Gates antes de push: Nutrition obligatorio, UFC parity, Git y matriz por riesgo. | Todos PASS con evidencia fresca. | No bypass. |
| UFC-STAB-602 | crítica | BLOCKED | UFC-STAB-601 | Smoke productivo no mutante de menús y health. | Servicios activos y ledger digest sin cambios. | `/start`, Evento, Analizar, Créditos. |
| UFC-STAB-603 | alta | BLOCKED | Etapas 1..5 | Runbooks de arquitectura, fuentes, timers, billing, DB, backup y rollback. | Operador nuevo puede diagnosticar y recuperar. | Enlaces desde README/ops. |
| UFC-STAB-604 | crítica | BLOCKED | UFC-STAB-602,603 | Cerrar backlog con evidencia; conservar sólo observaciones temporales. | Handoff final reproduce estado real. | Finish guard y branch closure. |

## Políticas cerradas

- Bot online con fail-closed.
- Deploys incrementales por etapa.
- Ninguna feature nueva de Wishlist 38–41 durante estabilización.
- Ledger, receipts, pagos y créditos son datos protegidos sin retención destructiva.
- Snapshots automáticos: 90 días completos y último histórico por clave; news/API 180 días; alertas 365 días; cache expirada 30 días.
- `data_scrapper` se modifica en branch separada y se referencia por commit en este backlog.
