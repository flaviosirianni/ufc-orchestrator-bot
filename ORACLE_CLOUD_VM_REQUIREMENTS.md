# Oracle Cloud VM Requirements - Bot Factory (Multi-Bot)

Documento implementable para operar esta base de codigo en una VM de OCI con arquitectura multi-bot.

## 1) Alcance

Incluye:

- Provisioning de VM.
- Seguridad de red y DNS.
- Runtime Node.js + SQLite.
- Configuracion de secretos/env por servicio.
- Ejecucion con `systemd` (billing + bots).
- Exposicion HTTPS de checkout/webhooks/health con `nginx`.
- Backup y recuperacion.

## 2) Arquitectura objetivo

- 1 VM Linux (Ubuntu 22.04 LTS recomendado).
- 1 servicio interno de billing:
  - `npm run start:billing`
  - wallet global + MP checkout/webhook.
- N servicios de bots (uno por `BOT_ID`):
  - `npm run start:bot`
  - Telegram polling + runtime por dominio.
- DB SQLite separada:
  - Billing: `/home/ubuntu/bot-data/billing/billing.db`
  - Dominio por bot: `/home/ubuntu/bot-data/<bot_id>/bot.db`
- `nginx` + TLS delante de puertos internos.

Referencias operativas del repo:

- `ops/systemd/billing-service.service`
- `ops/systemd/bot-factory@.service`
- `ops/nginx/bot-factory-subdomains.conf`
- `ops/nginx/bot-factory-paths.conf`
- `ops/README.md`

## 3) Requisitos OCI

### Cuenta y recursos

- Tenant OCI activo.
- Compartment dedicado.
- Recursos minimos:
  - 1 instancia compute.
  - 1 IP publica reservada.
  - 1 VCN + subnet publica.
  - (Recomendado) Object Storage para backups.

### Compute

- OS: Ubuntu 22.04 LTS.
- Shape:
  - Minimo laboratorio: `VM.Standard.E2.1.Micro`.
  - Recomendado: `VM.Standard.A1.Flex` (>= 2 OCPU, >= 8 GB RAM).
- Boot volume: 50 GB minimo.
- SSH por key pair (sin password auth).

### Red

- Subnet publica + Internet Gateway.
- Regla `0.0.0.0/0 -> Internet Gateway`.
- NSG/Security List:
  - Ingress `22/tcp` desde IP admin.
  - Ingress `443/tcp` publico.
  - Ingress `80/tcp` opcional (Let's Encrypt).
  - No exponer puertos internos Node al exterior.
  - Egress `443/tcp` habilitado.

## 4) Dependencias SO

Instalar:

- `git`
- `curl`
- `build-essential`
- `python3`
- `make`
- `g++`
- `sqlite3`
- `nginx`
- `certbot` + plugin de `nginx`

Node:

- Requerido: Node >= 18.
- Recomendado: Node 20 LTS.

Validacion minima:

```bash
node -v
npm -v
sqlite3 --version
```

## 5) App y datos

- Clonar en ruta estable:
  - `/home/ubuntu/apps/bot-factory`
- Instalar deps:
  - `npm ci`
- Crear rutas de datos:
  - `/home/ubuntu/bot-data/billing/`
  - `/home/ubuntu/bot-data/ufc/`
  - `/home/ubuntu/bot-data/nutrition/`
  - `/home/ubuntu/bot-data/medical_reader/`

## 6) Variables de entorno

### Billing (`/etc/bot-factory/billing.env`)

- `BILLING_PORT`
- `BILLING_DB_PATH`
- `BILLING_API_TOKEN`
- `BILLING_PUBLIC_URL`
- `MP_ACCESS_TOKEN`
- `MP_WEBHOOK_TOKEN`
- `MP_TOPUP_PACKS`
- `APP_PUBLIC_URL`

### Bot (`/etc/bot-factory/<bot_id>.env`)

- `BOT_ID`
- `OPENAI_API_KEY`
- `TELEGRAM_BOT_TOKEN` o `<BOT>_TELEGRAM_BOT_TOKEN` segun manifest
- `DB_PATH`
- `INTERACTION_MODE`
- `BOT_POLICY_PACK`
- `BILLING_BASE_URL`
- `BILLING_API_TOKEN`
- `APP_PUBLIC_URL`
- Variables de dominio (ej UFC odds/news/sheets)

## 7) systemd

Copiar unidades del repo:

```bash
sudo cp /home/ubuntu/apps/bot-factory/ops/systemd/billing-service.service /etc/systemd/system/
sudo cp /home/ubuntu/apps/bot-factory/ops/systemd/bot-factory@.service /etc/systemd/system/
sudo systemctl daemon-reload
```

Arranque:

```bash
sudo systemctl enable --now billing-service
sudo systemctl enable --now bot-factory@ufc
sudo systemctl enable --now bot-factory@nutrition
sudo systemctl enable --now bot-factory@medical_reader
```

Logs:

```bash
sudo journalctl -u billing-service -f
sudo journalctl -u bot-factory@ufc -f
```

## 8) Nginx + TLS

- Elegir template:
  - subdominios: `ops/nginx/bot-factory-subdomains.conf`
  - paths: `ops/nginx/bot-factory-paths.conf`
- Copiar a `sites-available`, linkear y recargar.
- TLS por certbot.

Validacion:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

## 9) Backup y recovery

Usar `.backup` SQLite (no copiar solo archivo principal en caliente).

Ejemplo billing:

```bash
sqlite3 /home/ubuntu/bot-data/billing/billing.db ".backup '/home/ubuntu/bot-data/backups/billing-$(date +%F-%H%M).db'"
```

Ejemplo bot UFC:

```bash
sqlite3 /home/ubuntu/bot-data/ufc/bot.db ".backup '/home/ubuntu/bot-data/backups/ufc-$(date +%F-%H%M).db'"
```

Politica sugerida:

- Cada 6h local.
- Retencion 7-14 dias.
- Copia diaria a Object Storage.
- Restore test mensual.
- Script base incluido: `ops/scripts/backup-bot-factory.sh`.

## 10) Checklist go-live

- Billing activo y estable.
- Cada bot objetivo activo y estable.
- Reinicio de VM recupera servicios automaticamente.
- Endpoints HTTPS operativos (`/topup/checkout`, `/topup/result`, webhook MP).
- Smoke Telegram por bot (menu + analisis + creditos).
- Backups generando correctamente.

## 11) Criterios de aceptacion

La migracion OCI queda lista cuando:

1. Billing + al menos 2 bots corren en paralelo por 24h sin caidas.
2. Reinicio de VM recupera todos los servicios sin intervencion manual.
3. Topup MP acredita una sola vez ante reintentos de webhook.
4. Datos de dominio no se mezclan entre bots.
5. Wallet global comparte saldo correctamente entre bots.
