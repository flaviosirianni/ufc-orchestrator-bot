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
