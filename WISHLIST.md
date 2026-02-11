# Wishlist

Ideas para implementar mas adelante (fuera del foco actual de trabajo).

## Pendientes

1. **Feedback de "pensando" mientras el bot procesa la respuesta**
   - **Objetivo:** mejorar la UX cuando la respuesta tarda varios segundos.
   - **Comportamiento deseado:** mostrar que el bot esta activo durante el procesamiento.
   - **Opciones sugeridas:**
     - Mostrar estado "escribiendo..." en Telegram mientras se genera la respuesta.
     - Como fallback, enviar un mensaje corto tipo "Pensando..." y luego la respuesta final.
   - **Contexto:** hoy hay demoras de algunos segundos y desde el POV del usuario parece que el bot "se queda" sin reaccion.
   - **Estado:** pendiente.

2. **Consultas de creditos y pagos desde el bot**
   - **Objetivo:** que el usuario pueda consultar su estado de cuenta sin salir del chat.
   - **Comportamiento deseado:** responder sobre creditos disponibles, recargas/pagos realizados y movimientos recientes.
   - **Alcance inicial sugerido:**
     - Saldo actual (free + paid).
     - Ultimas transacciones de creditos (gastos y recargas).
     - Confirmacion de pagos acreditados cuando aplique.
   - **Contexto:** hoy esa informacion existe en backend/DB pero no esta expuesta en el flujo conversacional al usuario final.
   - **Estado:** pendiente.

3. **Hardening de seguridad y operacion de la base de datos**
   - **Objetivo:** mejorar resiliencia, seguridad y trazabilidad de datos sensibles (usuarios, creditos y pagos).
   - **Comportamiento deseado:** que la DB no viva dentro del repo y que exista respaldo/auditoria robusta.
   - **Alcance inicial sugerido:**
     - Mover la base de datos fuera del repositorio de codigo.
     - Agregar snapshots/backups periodicos con politica de retencion.
     - Incorporar logs operativos y auditoria de pagos (eventos, resultado, motivo, timestamp, idempotencia).
   - **Contexto:** a medida que crece la integracion de pagos, aumenta el riesgo operativo y la necesidad de trazabilidad.
   - **Estado:** pendiente.
