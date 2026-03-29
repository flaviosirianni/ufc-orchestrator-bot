# AGENTS.md

## Wishlist Documentation Policy

Cuando el usuario pida agregar items a `WISHLIST.md`, documentarlos con nivel implementable y no solo conceptual.

Cada item debe incluir:

- Objetivo de negocio/UX.
- Problema observado (idealmente con ejemplo real).
- Comportamiento deseado para el usuario final.
- Diseno tecnico sugerido (componentes, reglas, guardrails, estados).
- Criterios de aceptacion verificables.
- Pruebas de regresion necesarias.
- Prioridad y estado.

Si falta informacion para algun campo, dejarlo explicitamente marcado como decision abierta.

## Server Operations Playbook (Codex)

Estas reglas son para este repo y deben aplicarse por defecto cuando el usuario pida "subir/refrescar/deploy" cambios en el bot online.

### Objetivo operativo

- Minimizar friccion: implementar local -> push -> refresh en servidor en el mismo flujo.
- Evitar drift entre local y prod.
- Evitar errores comunes (ruta incorrecta, servicio incorrecto, commitear WAL/SHM).

### Identidad del servidor (fuente de verdad)

- SSH alias esperado: `ufc-oci` (definido en `~/.ssh/config`).
- Servicio `systemd`: `ufc-orchestrator`.
- `WorkingDirectory` real del servicio: leer siempre con:
  - `ssh ufc-oci 'sudo cat /etc/systemd/system/ufc-orchestrator.service'`
- Actualmente el `WorkingDirectory` productivo es:
  - `/home/ubuntu/apps/ufc-orchestrator-bot`

### Flujo estandar de deploy (si el usuario no indica otra cosa)

1. Validar local:
   - Ejecutar tests relevantes (ideal: `npm test`).
2. Preparar commit:
   - No incluir `data/bot.db-wal` ni `data/bot.db-shm` en commit.
   - Incluir solo archivos funcionales/documentacion/tests requeridos.
3. Commit + push:
   - `git add <archivos>`
   - `git commit -m "<mensaje claro>"`
   - `git push origin main`
4. Refrescar servidor:
   - `ssh ufc-oci 'cd /home/ubuntu/apps/ufc-orchestrator-bot && git pull --ff-only && sudo systemctl restart ufc-orchestrator && sudo systemctl status ufc-orchestrator --no-pager -l | sed -n "1,25p"'`
5. Verificacion post-restart:
   - Logs recientes:
     - `ssh ufc-oci 'sudo journalctl -u ufc-orchestrator -n 40 --no-pager'`
   - Confirmar que arranco sin crash y que sigue `active (running)`.

### Variables de modo de interaccion (Telegram)

- Modo guiado estricto por defecto:
  - `TELEGRAM_INTERACTION_MODE=guided_strict`
  - `GUIDED_QUOTES_TEXT_FALLBACK=true`
- Si se necesita rollback funcional rapido de UX:
  - pasar temporalmente a `TELEGRAM_INTERACTION_MODE=hybrid`
  - reiniciar servicio.

### Checklist de smoke manual tras deploy

- En Telegram enviar `/start` en chat nuevo.
- Verificar menu esperado segun modo.
- Recordar que botones viejos en mensajes viejos no se actualizan solos (comportamiento de Telegram).
- Probar al menos 1 flujo critico del cambio desplegado.

### Guardrails

- No asumir ruta de repo en servidor: verificar por `systemd` si hay dudas.
- No hacer comandos destructivos (`reset --hard`, etc.) sin pedido explicito del usuario.
- Si `git pull --ff-only` falla, detener y reportar estado (no forzar merge sin confirmacion).
