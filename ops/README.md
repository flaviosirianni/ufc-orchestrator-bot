# Bot Factory Operations (OCI)

## Layout operativo

- Codigo: `/home/ubuntu/apps/bot-factory`
- Data por bot: `/home/ubuntu/bot-data/<bot_id>/bot.db`
- Data billing: `/home/ubuntu/bot-data/billing/billing.db`
- Env billing: `/etc/bot-factory/billing.env`
- Env por bot: `/etc/bot-factory/<bot_id>.env`

## Servicios systemd

Copiar unidades:

```bash
sudo cp ops/systemd/billing-service.service /etc/systemd/system/billing-service.service
sudo cp ops/systemd/bot-factory@.service /etc/systemd/system/bot-factory@.service
sudo systemctl daemon-reload
```

Activar billing:

```bash
sudo systemctl enable --now billing-service
sudo systemctl status billing-service --no-pager -l
```

Activar bot UFC:

```bash
sudo systemctl enable --now bot-factory@ufc
sudo systemctl status bot-factory@ufc --no-pager -l
```

Activar otros bots:

```bash
sudo systemctl enable --now bot-factory@nutrition
sudo systemctl enable --now bot-factory@medical_reader
```

## Logs

```bash
sudo journalctl -u billing-service -f
sudo journalctl -u bot-factory@ufc -f
```

## Nginx

Templates disponibles:

- `ops/nginx/bot-factory-subdomains.conf`
- `ops/nginx/bot-factory-paths.conf`

Validar y recargar:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

## Scripts utiles

- Backup SQLite multi-servicio:
  - `ops/scripts/backup-bot-factory.sh`
- Check rapido de servicios:
  - `ops/scripts/check-bot-factory-services.sh`

## Runbook de incidentes

### Diagnóstico rápido
```bash
systemctl status "bot-factory@ufc" "bot-factory@nutrition" billing-service
curl -s http://localhost:3301/health | jq '{ok,runtime:.runtime.telegram}'
curl -s http://localhost:3302/health | jq '{ok,runtime:.runtime.telegram}'
journalctl -u "bot-factory@ufc" -n 50 --no-pager
journalctl -u bot-factory-guard.service -n 20 --no-pager
```

### Caso: 409 Conflict sostenido (> 5 min)
1. `curl -s http://localhost:3301/health | jq '.runtime.telegram.degraded'`
2. Si `true`: el guard lo resolverá en el próximo ciclo (≤60s). Si no hay guard activo: `systemctl start bot-factory-guard.service`.
3. Si persiste: `systemctl restart bot-factory@ufc` manual.
4. Si sigue: rotar token Telegram → actualizar `/etc/bot-factory/ufc.env` → `systemctl restart bot-factory@ufc`.

### Caso: Bot arranca pero no responde en Telegram
1. Verificar `/health` en el puerto correspondiente.
2. `journalctl -u "bot-factory@ufc" -n 100` — buscar errores de DB o bootstrap.
3. Si `idleMs` > 5 min, el watchdog (4 min) debería haber actuado. Verificar `recoveryCount` y `degraded`.
4. Si `degraded: true`, esperar que el guard reinicie (ventana de 30 min) o reiniciar manual.

### Caso: systemctl restart no recupera
1. `journalctl -u "bot-factory@ufc" -n 200 | grep -i 'error\|fail\|db'`
2. `ls -lh /home/ubuntu/bot-data/*.db`
3. `systemctl cat "bot-factory@ufc" | grep EnvironmentFile` → verificar `/etc/bot-factory/ufc.env`

### Ventanas y límites configurables
| Var | Default | Propósito |
|-----|---------|-----------|
| `TELEGRAM_POLLING_RECOVERY_WINDOW_MS` | 3600000 (1h) | Ventana para contar recoveries |
| `TELEGRAM_POLLING_RECOVERY_MAX_PER_WINDOW` | 10 | Max recoveries antes de degraded |
| `TELEGRAM_POLLING_CONFLICT_RECOVERY_COOLDOWN_MS` | 60000 | Cooldown entre recoveries por 409 |
| `RESTART_WINDOW_SEC` | 1800 (30min) | Cooldown del guard entre restarts |
| `STALE_IDLE_SEC` | 300 (5min) | Idle que dispara restart si hay conflictos |

### Orden de rollout recomendado
1. Deploy app changes en **nutrition** (canary). Observar `/health` 24h.
2. Deploy app changes en **ufc**.
3. Instalar guard script + timer en servidor.
4. Smoke test: `curl /health` en ambos puertos + `/start` en Telegram.
