# Unificación de menús guiados y fin del ruteo por keywords

## Objetivo

Eliminar la causa raíz de que el bot "diga que sí" a un pedido de registrar/cerrar una apuesta y no lo haga: hoy, en `guided_strict`, cada mensaje de texto libre se reclasifica por listas de keywords (`looksLikeStructuredBetRecordText` y hermanas en `telegramBot.js`) sin importar qué botón se apretó antes. De paso, unificar la navegación para que "ver evento → ver pelea → decidir apostar" sea un solo hilo enganchado por botones, en vez de menús desconectados (Análisis / Evento / Ledger).

## Incidente de referencia (sesión 2026-08-12)

Usuario único activo (`telegram_user_id 1806836602`), sesión real del 2026-07-19:
- `"le puse $ 2000 a Under 2.5 @3.75"` → matcheó `hasPickContext` por la keyword `under` → clasificado `record_bet` → `record_user_bet` se ejecutó → bet_id 49 existe en la tabla `bets`.
- `"le puse $2000 a Hooper por Sumisión @2.40"` → ninguna keyword de `hasFight`/`hasPickContext` matcheó (la lista sólo tiene `submission` en inglés, no `sumisión`/`sumision`) → cayó al chequeo de `looksLikeStructuredOddsText` (matchea cualquier `@\d+`) → clasificado `analyze_quotes` → el LLM llamó `store_user_odds` en vez de `record_user_bet` → **esa apuesta nunca quedó en el ledger**, sin error visible para el usuario.

Confirmado cruzando `journalctl` (tool calls reales por turno) contra la tabla `bets` en producción.

## Diagnóstico: por qué parchear la keyword no alcanza

El usuario habla con precisión y el bot sigue sin entender — no es un problema de qué tan claro se expresa, es que la clasificación ocurre **antes** de que cualquier razonamiento (LLM o no) vea el mensaje completo, basada en una lista de palabras que nunca va a cubrir todas las formas de decir lo mismo en español. Agregar `sumisión` arregla este caso puntual; no arregla la clase de bug. La decisión de esta sesión es sacar el mecanismo, no ampliarlo.

## Diseño

### 1. Ruteo por estado, no por keywords

`resolveGuidedMessageDecision` (`telegramBot.js`) deja de tener una rama de texto libre que adivina intención. En su lugar:
- La acción activa (`guidedAction`) sale **únicamente** de la sesión persistida por `setGuidedAction`, seteada al apretar un botón.
- Un mensaje de texto o foto usa esa acción activa tal cual, sin reclasificar.
- Si no hay acción activa (chat en frío) o pasaron más de 45 minutos desde el último set (ventana de inactividad configurable), el bot no intenta interpretar el mensaje: responde mostrando el menú principal.
- `looksLikeStructuredBetRecordText`, `looksLikeStructuredBetSettleText`, `looksLikeStructuredOddsText` se eliminan de la ruta de decisión de intención. (Pueden quedar como funciones muertas a remover en el mismo cambio, no archivadas "por las dudas".)

El texto libre **dentro** de un flujo con acción activa sigue funcionando exactamente igual que hoy — eso ya well-tested (bet_id 49 se creó así). No se toca `record_user_bet`, `mutate_user_bets`, ni la extracción de campos vía LLM.

### 2. Identidad de pelea enganchada en callbacks

Toda vez que el bot muestra una pelea concreta (predicción individual desde `Evento`, o el resultado de analizar quotes desde `Análisis`), el mensaje lleva botones con el `fight_id` real de esa pelea codificado en `callback_data` (ej. `qa:record_bet_for:<fightId>`, `qa:analyze_quotes_for:<fightId>`).

Al tocar uno de estos botones, `setGuidedAction` guarda además el contexto de la pelea (evento, fighterA, fighterB, fight_id) junto con la acción. El siguiente mensaje del usuario (texto o screenshot de su ticket) sólo necesita aportar pick/cuota/stake — el "para qué pelea es esto" queda resuelto de antemano, eliminando una clase entera de ambigüedad de target (relevante también para `mutate_user_bets`, ver Wishlist ítem 16).

### 3. Proyecciones: un mensaje por pelea

`wantsEventProjections` (`bettingWizard.js`) hoy arma un único bloque de texto con toda la cartelera. Pasa a enviar un mensaje por pelea pendiente, cada uno con `[📝 Registrar apuesta] [🔍 Analizar mis quotes]` con el `fight_id` correspondiente. Mismo dato que hoy, reorganizado; no se toca `preFightAnalysis`/`betScoringEngine`.

### 4. Árbol de menús resultante

```
Menú principal (sin cambios estructurales)
├── 📸 Análisis            → entrada genérica, sin fight_id (como hoy)
├── 🧾 Ledger               → entrada genérica, sin fight_id (como hoy)
│   ├── 📝 Registrar apuesta
│   ├── ✅ Cerrar apuesta   (fallback manual — auto-settlement sigue siendo el camino principal)
│   ├── 📌 Pendientes
│   └── 🗂 Historial de mutaciones
├── 📰 Evento
│   └── [predicción, 1 mensaje por pelea]
│       └── [📝 Registrar apuesta] [🔍 Analizar mis quotes]   ← fight_id enganchado
├── ⚙️ Configuración
└── 💳 Créditos / 🆘 Ayuda
```

Simétricamente: si el usuario entra por `Análisis` y manda screenshots, y el bot identifica de qué pelea son, la respuesta suma `[📝 Registrar apuesta]` con ese `fight_id` — mismo mecanismo que desde `Evento`, entrada distinta.

### 5. Bugs que viajan junto (no son rediseño de menú, pero surgieron en esta sesión)

- **`current_event` no filtra por promoción**: `buildLiveOddsEventContext`/`buildEventStateFromOddsRows` (`bettingWizard.js`) toman cualquier fila de `odds_events_index` bajo `mma_mixed_martial_arts` más cercana a "ahora", sin verificar que sea UFC. Confirmado en producción 2026-08-12: `current_event` = "Matt Adams vs Anthony Wint" (evento real pero de otra promoción, no UFC). Mismo tipo de fix que `resolveNextEventFromOddsRows` (Fase B, `oddsEventResolver.js`) ya aplica para `next_event`, pendiente de extender a la detección de evento en vivo.

## Fuera de alcance (queda en Wishlist)

- **Ítem 43 (nuevo, agregado esta sesión):** sección "Historial" para consultar eventos/peleadores/peleas viejas — pedido explícito del usuario, desarrollo diferido.
- **Ítem 40:** archivo de eventos pasados dentro de `Evento` — relacionado con el ítem 43, no se aborda en este cambio.
- **Ítem 41:** selector de pelea + modo continuo de screenshots dentro de `Analizar Cuotas` — el mecanismo de `fight_id` en callbacks que se construye acá es el mismo que ítem 41 necesitaría; no se implementa el modo continuo completo en este cambio.
- Editar mensajes de Telegram en vez de reenviarlos (se evaluó y se descartó para este alcance — ver conversación de brainstorming).

## Aceptación

- Ningún mensaje de texto libre puede cambiar la acción activa por matching de keywords; sólo un botón puede.
- El incidente de referencia (`"le puse $2000 a Hooper por Sumisión @2.40"` con acción activa `record_bet`) resulta en un `record_user_bet` exitoso, no en `store_user_odds`.
- Sin acción activa y sin botón reciente, el bot muestra el menú en vez de adivinar.
- Un botón de pelea (desde `Evento` o desde `Análisis`) deja el `fight_id` correcto disponible para el siguiente mensaje, verificable sin que el usuario repita evento/pelea.
- `current_event` no se declara "live" para un evento que no es UFC.
- Suite completa + gate de calidad + paridad en verde antes de cualquier deploy; ledger sin drift verificado post-deploy (mismo patrón que Fases A/B/C).
