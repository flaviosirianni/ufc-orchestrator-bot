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
