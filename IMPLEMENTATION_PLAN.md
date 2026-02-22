# Implementation Plan (Execution Track)

Este archivo traduce el backlog de `WISHLIST.md` a un plan secuencial de ejecucion en 3 PRs.
Objetivo: atacar primero riesgo de integridad de datos y luego mejorar precision/UX.

## Principios de ejecucion

- Priorizar integridad de ledger sobre features nuevas.
- Evitar respuestas "optimistas" sin persistencia real confirmada.
- Mover reglas criticas a codigo deterministico (no solo prompt).
- Cada PR debe incluir pruebas de regresion de incidentes reales.

## PR 1 - Ledger Safety Core (Bloqueante)

Prioridad: Critica  
Estado: Pendiente

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

## PR 2 - Temporal/Factual Reliability

Prioridad: Alta (con dependencia de PR1 para seguridad)  
Estado: Pendiente

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

## PR 3 - Turn UX + Operational Clarity

Prioridad: Alta  
Estado: Pendiente

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
