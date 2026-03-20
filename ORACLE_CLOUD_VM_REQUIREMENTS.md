# Oracle Cloud VM Requirements - UFC Orchestrator Bot

Documento de requisitos implementables para mover este proyecto a una VM en Oracle Cloud Infrastructure (OCI).

## 1) Alcance

Este checklist cubre:

- Provisioning de VM en OCI.
- Setup de red, seguridad y DNS.
- Instalacion de runtime para Node.js + SQLite.
- Configuracion de secretos y variables de entorno.
- Ejecucion en background (`systemd`).
- Exposicion segura de endpoints HTTP (si se usan recargas/webhooks).
- Backup y operacion basica en produccion.

## 2) Arquitectura Objetivo

- 1 VM Linux (Ubuntu 22.04 LTS recomendado).
- Proceso Node.js corriendo el bot (`npm run start`).
- SQLite local en disco persistente (`DB_PATH=./data/bot.db` por defecto).
- Telegram en modo polling (no requiere webhook de Telegram).
- HTTP server local en `PORT` (default `3000`) para:
  - `/webhooks/credits`
  - `/webhooks/mercadopago`
  - `/topup/checkout`
  - `/topup/result`
  - `/topup/config`
- `nginx` + TLS delante del proceso Node si se exponen endpoints publicos.

## 3) Requisitos OCI (Infra)

## Cuenta y recursos

- Tenant OCI activo.
- Compartment dedicado para este bot.
- Cuota disponible para:
  - 1 instancia de compute.
  - 1 IP publica reservada.
  - 1 VCN + subnet publica.
  - (Recomendado) Object Storage para backups.

## Compute

- OS: Ubuntu 22.04 LTS.
- Shape:
  - Minimo funcional: `VM.Standard.E2.1.Micro` (trafico bajo).
  - Recomendado estable: `VM.Standard.A1.Flex` (>= 1 OCPU, >= 6 GB RAM).
- Boot volume: minimo 50 GB.
- Acceso SSH con key pair (sin password auth).

## Red (VCN/Subnet)

- Subnet publica con Internet Gateway.
- Route rule `0.0.0.0/0 -> Internet Gateway`.
- NSG/Security List:
  - Ingress `22/tcp` desde tu IP admin.
  - Ingress `443/tcp` desde `0.0.0.0/0` (si hay webhooks/topup publicos).
  - Ingress `80/tcp` opcional para desafio Let's Encrypt.
  - No exponer `3000/tcp` publicamente.
  - Egress `443/tcp` abierto a Internet para APIs externas.

## 4) Dependencias del Sistema Operativo

Instalar en la VM:

- `git`
- `curl`
- `build-essential`
- `python3`
- `make`
- `g++`
- `sqlite3`
- `nginx` (si se publica HTTP)
- `certbot` + plugin de `nginx` (si se usa TLS automatico)

Node.js:

- Requerido por proyecto: Node `>=18`.
- Recomendado para produccion nueva: Node `20 LTS`.

Validaciones minimas:

```bash
node -v
npm -v
sqlite3 --version
```

## 5) Requisitos de Aplicacion

## Codigo y ejecucion

- Clonar repo en ruta estable (ej. `/opt/ufc-orchestrator-bot`).
- Instalar dependencias con `npm ci`.
- Ejecutar con `npm run start`.
- Usuario de sistema dedicado (ej. `ufcbot`), no correr como `root`.

## Persistencia

- Confirmar carpeta `data/` con permisos de escritura para el usuario del servicio.
- Persistir estos archivos entre reinicios:
  - `data/bot.db`
  - `data/bot.db-wal`
  - `data/bot.db-shm`

## Variables de entorno obligatorias (core)

Sin estas variables, el bot no opera correctamente:

- `OPENAI_API_KEY`
- `TELEGRAM_BOT_TOKEN`
- `SHEET_ID`
- `GOOGLE_SERVICE_ACCOUNT_EMAIL`
- `GOOGLE_PRIVATE_KEY`

Variables importantes adicionales:

- `DB_PATH` (default `./data/bot.db`)
- `PORT` (default `3000`)
- `ODDS_API_KEY` (necesaria para modulo de odds/proyecciones)
- `APP_PUBLIC_URL` (necesaria si se usan links de topup o webhooks publicos)
- `CREDIT_WEBHOOK_TOKEN` (recomendado si expones `/webhooks/credits`)
- `MP_ACCESS_TOKEN`, `MP_*` (si se usa Mercado Pago)

Referencia completa: `.env.example`.

## 6) Seguridad Operativa

- Guardar secretos solo en `.env` del servidor (`chmod 600`).
- No commitear `.env` ni `service-account.json`.
- Habilitar firewall host (ej. `ufw`) y permitir solo puertos necesarios.
- Forzar HTTPS para endpoints de webhook/pagos.
- Usar token en query para `/webhooks/credits` y `/webhooks/mercadopago` cuando corresponda.
- Rotar claves/API keys periodicamente.

## 7) Proceso en Background (`systemd`)

Crear servicio `ufc-orchestrator.service`:

```ini
[Unit]
Description=UFC Orchestrator Bot
After=network.target

[Service]
Type=simple
User=ufcbot
WorkingDirectory=/opt/ufc-orchestrator-bot
ExecStart=/usr/bin/npm run start
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

Comandos:

```bash
sudo systemctl daemon-reload
sudo systemctl enable ufc-orchestrator
sudo systemctl start ufc-orchestrator
sudo systemctl status ufc-orchestrator
journalctl -u ufc-orchestrator -f
```

## 8) Reverse Proxy y TLS (`nginx`)

Si vas a usar recargas/webhooks, exponer por dominio con HTTPS:

- DNS `A` record -> IP publica reservada de la VM.
- `nginx` escuchando 443 y proxyeando a `http://127.0.0.1:3000`.
- Certificado TLS (Let's Encrypt recomendado).

Bloques minimos a publicar:

- `GET /topup/checkout`
- `GET /topup/result`
- `GET /topup/config`
- `POST /webhooks/credits`
- `POST /webhooks/mercadopago`

## 9) Backups y Recuperacion

Como la app usa SQLite con WAL, respaldar con `sqlite3 .backup` (no copiar solo `bot.db` en caliente).

Backup sugerido (ejecucion programada):

```bash
sqlite3 /opt/ufc-orchestrator-bot/data/bot.db ".backup '/opt/ufc-orchestrator-bot/data/db_backups/bot-$(date +%F-%H%M).db'"
```

Politica recomendada:

- Frecuencia: cada 6 horas.
- Retencion local: 7-14 dias.
- Copia externa: Object Storage OCI diario.
- Prueba de restore: al menos 1 vez por mes.

## 10) Checklist de Go-Live

Antes de abrir trafico:

- VM provisionada con shape y disco definidos.
- NSG/firewall aplicado.
- Node/npm/sqlite instalados y validados.
- Repo clonado + `npm ci` ejecutado.
- `.env` completo (basado en `.env.example`).
- Servicio `systemd` activo y estable tras reboot.
- Health check responde en `http://127.0.0.1:3000/`.
- Si hay dominio: TLS emitido y renovacion automatica validada.
- Si hay pagos: webhook de Mercado Pago probado end-to-end en sandbox.
- Backup automatico activo.

## 11) Criterios de Aceptacion

La migracion a OCI VM se considera lista cuando:

1. El bot responde mensajes en Telegram por 24h sin caidas del proceso.
2. El servicio sobrevive reinicio de VM sin intervencion manual.
3. Los endpoints de topup/webhooks (si aplican) responden por HTTPS.
4. Se genera al menos 1 backup valido y se verifica restore en entorno de prueba.
5. No hay secretos expuestos en git ni en logs.

