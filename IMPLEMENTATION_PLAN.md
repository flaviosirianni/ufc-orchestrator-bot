# Implementation Plan (Execution Track)

Este archivo traduce el backlog de `WISHLIST.md` a un plan secuencial de ejecucion en 3 PRs.
Objetivo: atacar primero riesgo de integridad de datos y luego mejorar precision/UX.

## Principios de ejecucion

- Priorizar integridad de ledger sobre features nuevas.
- Evitar respuestas "optimistas" sin persistencia real confirmada.
- Mover reglas criticas a codigo deterministico (no solo prompt).
- Cada PR debe incluir pruebas de regresion de incidentes reales.

## Progreso

- 2026-02-22: PR1 en avance.
  - Implementado: base de mutaciones seguras (`preview/apply`), auditoria append-only (`bet_mutations`), receipts de escritura y nuevas tools de ledger (`list_user_bets`, `mutate_user_bets`).
  - Implementado: confirmacion por token para mutaciones sensibles y guardrail inicial para no cerrar peleas marcadas como "no empezo".
  - Implementado: pruebas de regresion nuevas en `__tests__/bettingWizard.test.js` para confirmacion y settle legacy ambiguo.
- 2026-03-15: avance adicional en seguridad de ledger + contexto temporal/local.
  - Implementado: hardening de mutaciones para cierres (`settle/set_pending`) exigiendo selector explicito y bloqueando referencias ambiguas en lenguaje natural.
  - Implementado: guardrail de contexto de exposicion post-registro para evitar claims falsos de "peleas restantes/comprometido/remanente" cuando no hay base en ledger.
  - Implementado: reconciliacion de eventos "hoy/manana/ahora" usando fecha local del usuario (no solo UTC) en logica de seleccion de evento.
  - Implementado: nuevas pruebas de regresion para los escenarios anteriores en `__tests__/bettingWizard.test.js`.

## PR 1 - Ledger Safety Core (Bloqueante)

Prioridad: Critica  
Estado: En progreso (base operativa implementada; hardening pendiente)

Items cubiertos de `WISHLIST.md`:

- 16. Cierre de apuestas en ledger: evitar updates sobre pelea equivocada.
- 18. Operaciones destructivas con confirmacion en dos pasos.
- 17. Trazabilidad y reversibilidad de mutaciones (parte base: receipts + auditoria).
- 19. Ejecucion multi-accion robusta (fase 1: planner + resultado por step).

Alcance tecnico:

- Implementar `LedgerMutationGuard` antes de cualquier write de apuestas.
- Implementar `FightReferenceResolver` deterministico para `esta/anterior/siguiente/esas`.
- Implementar `FightStateGate` (bloquear WON/LOST en pelea no iniciada/en curso).
- Implementar `DestructiveActionGuard` con preview + confirm para delete/bulk-close.
- Implementar `CompositeMutationPlanner` para turnos con multiples acciones.
- Implementar `MutationReceipt` obligatorio en toda respuesta de escritura.
- Crear tabla de auditoria append-only para cambios de estado.

Entregables:

- Nuevos helpers/servicios de guardrails de ledger.
- Cambios en handler de betting wizard para usar planner/guards.
- Respuestas estructuradas por step (`ok`/`needs_input`/`failed`) en mutaciones compuestas.
- Pruebas automatizadas de los incidentes reales reportados.

Definition of Done:

- No se ejecutan mutaciones ambiguas.
- No hay confirmacion de escritura sin receipt.
- Operaciones destructivas requieren confirmacion explicita.
- Tests de regresion del incidente "pelea anterior" y "borra las demas" en verde.

Estado actual del alcance:

- Hecho:
  - Base `preview/apply` de mutaciones de ledger y auditoria `bet_mutations`.
  - Receipts de escritura y soporte de `undo_last_mutation`.
  - Confirmacion por token para mutaciones sensibles (especialmente bulk/ambiguas).
  - Guardrails adicionales para evitar cierres sobre targets ambiguos.
- Pendiente:
  - `CompositeMutationPlanner` completo para instrucciones multi-accion en un solo turno.
  - Politica final para lotes multi-ID (confirmacion/atomicidad) y rollback explicito por batch complejo.

## PR 2 - Temporal/Factual Reliability

Prioridad: Alta (con dependencia de PR1 para seguridad)  
Estado: En progreso (ventana temporal local implementada; faltan gates de veracidad completos)

Items cubiertos de `WISHLIST.md`:

- 6. Robustecer logica de fechas y validez temporal de datos deportivos.
- 19. Ejecucion multi-accion robusta (fase 2: integracion con parsing de adjuntos).

Alcance tecnico:

- Implementar `RelativeDateResolver` backend con `as_of_date` obligatorio por turno.
- Implementar `FactFreshnessGate` para claims de racha/ultimos N/viene de.
- Implementar `ContradictionHandler` al detectar correccion factica del usuario.
- Implementar `ResponseConsistencyValidator` pre-envio de respuesta.
- Integrar parsing de adjuntos/screenshot al flujo de captura de apuestas (si falta dato, pedir solo lo faltante).

Entregables:

- Guardrails de veracidad temporal integrados al pipeline de respuesta.
- Fallback seguro de incertidumbre cuando no hay evidencia vigente.
- Pruebas para escenarios 2026 con historiales desactualizados.

Definition of Done:

- Sin discrepancias `hoy/manana` vs fecha real.
- No se emiten claims de recencia sin evidencia temporal valida.
- Ante contradiccion del usuario, el bot verifica antes de insistir.

Estado actual del alcance:

- Hecho:
  - Resolucion de fecha de referencia local para reconciliacion de eventos live/intel.
  - Cobertura de regresion para escenario de borde nocturno (`hoy/manana`).
- Pendiente:
  - `FactFreshnessGate` para claims de racha/ultimos N.
  - `ContradictionHandler` y `ResponseConsistencyValidator` end-to-end.

## PR 3 - Turn UX + Operational Clarity

Prioridad: Alta  
Estado: En progreso (componentes parciales en produccion; falta cierre integral)

Items cubiertos de `WISHLIST.md`:

- 14. Guardrail para mensajes encadenados mientras procesa.
- 13. Progreso visible durante respuestas lentas.
- 15. Educar al usuario para cargar cuotas completas.
- 11. Render correcto de formato en Telegram.
- 12. Ajuste de staking (fase inicial de policy).
- 9. Notificacion inmediata de recarga + consulta de saldo (fase inicial UX).

Alcance tecnico:

- Implementar `InFlightTurnGuard` por chat con politica inicial configurable (`coalesce` recomendado).
- Implementar `ProgressNotifier` (`start/update/finish`) con throttling.
- Agregar mensajes/CTA de onboarding de odds y solicitud de quotes completos.
- Unificar formatter Telegram (HTML recomendado) + fallback plain text seguro.
- Implementar `StakingPolicy` MVP (unidad minima, pisos, limites de exposicion).
- Agregar comando rapido de saldo (`/creditos`) y boton "Ver creditos" en respuestas relevantes.

Entregables:

- Menor friccion en chats largos y menos spam de mensajes encadenados.
- Respuestas mas legibles y consistentes.
- Mejor alineacion de stakes con presupuesto de evento.

Definition of Done:

- El usuario recibe feedback de progreso en turnos lentos.
- Mensajes encadenados no rompen contexto ni causan writes inconsistentes.
- No aparece markdown crudo en Telegram.
- Flujo de quotes/odds queda explicitado y accionable.

Estado actual del alcance:

- Hecho:
  - Submenus y navegacion base en Telegram (Apuestas/Config) con persistencia de scope.
  - Entrypoint inicial de `Cargar creditos` en Home.
  - Staking policy base con pisos/exposicion en pipeline de recomendaciones.
- Pendiente:
  - `InFlightTurnGuard` robusto y `ProgressNotifier` con lifecycle completo.
  - Cierre de formateo Telegram y flujo guiado de cuotas end-to-end.

## Orden recomendado de ejecucion

1. PR1 (bloqueante, seguridad de datos).
2. PR2 (precision y confianza factual).
3. PR3 (UX operacional y calidad de interaccion).

## Riesgos transversales

- Aumentar friccion por exceso de confirmaciones: mitigar con confirmaciones solo para mutaciones de riesgo.
- Complejidad de parser de screenshots: iniciar con fallback guiado cuando OCR no alcance.
- Deuda de pruebas: priorizar casos reales ya observados antes de escenarios sinteticos.

## Seguimiento

- Cada PR debe enlazar explicitamente los items de `WISHLIST.md` que cubre.
- No marcar item como cerrado sin pruebas de regresion asociadas.
