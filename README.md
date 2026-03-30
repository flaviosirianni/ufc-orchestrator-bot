# UFC Orchestrator Bot

UFC Orchestrator Bot is a Telegram automation system that combines OpenAI tool-calling, Google Sheets data, and web signals to streamline UFC betting research. The assistant preserves chat context per user so follow-up questions like "pelea 1" stay coherent.

## Bot Factory (Core + Bots)

Este repo ahora soporta un modelo **multi-bot** con separacion de plataforma y dominio:

- `src/platform/*`: runtime reusable (launcher, policy packs, billing client/bridge, health runtime).
- `src/services/billing/*`: `billing-service` compartido (wallet global + transacciones + webhook MP).
- `src/bots/<bot_id>/*`: cada bot con su propio `bot.manifest.json`, prompt y bootstrap.
- `src/bots/ufc`: UFC migrado al contrato de Bot Factory (bot v1).
- `src/bots/nutrition` y `src/bots/medical_reader`: bots scaffolded de ejemplo.
- Los bots scaffolded nacen con menu guiado minimo (sin ledger) y policy pack activo.

### Contrato de Bot (`bot.manifest.json`)

Campos estandar:

- `bot_id` (string unico).
- `display_name`.
- `telegram_token_env`.
- `interaction_mode` (`guided_strict|hybrid`).
- `domain_pack` (prompt/tools/menu).
- `credit_policy` (costos por tipo de uso).
- `risk_policy` (pack de guardrails transversal).
- `storage.db_path` (SQLite dominio por bot).

### Startup en local

Bot runtime (default `BOT_ID=ufc`):

```bash
npm run start:bot
```

Billing compartido:

```bash
npm run start:billing
```

Elegir bot:

```bash
BOT_ID=nutrition npm run start:bot
BOT_ID=medical_reader npm run start:bot
```

### Scaffold de nuevos bots

Generador:

```bash
npm run scaffold:bot -- --id <bot_id> --template expert_advisor
npm run scaffold:bot -- --id <bot_id> --template document_reader
```

Salida:

- `src/bots/<bot_id>/bot.manifest.json`
- `src/bots/<bot_id>/index.js`
- `src/bots/<bot_id>/prompt.md`
- `.env.<bot_id>.example`

### Operacion OCI

Plantillas incluidas:

- `ops/systemd/billing-service.service`
- `ops/systemd/bot-factory@.service`
- `ops/nginx/bot-factory-subdomains.conf`
- `ops/nginx/bot-factory-paths.conf`
- `ops/README.md` (runbook rapido)
- `BOT_FACTORY.md` (blueprint de contratos + fases)

## Architecture Overview

```
User → Telegram Bot → Router (intent + context) → Betting Wizard Agent → Fight History Cache + Web Intel + Google Sheets → Response back to Telegram
```

### Core Components

- **Telegram Bot** – Polling client built with `node-telegram-bot-api` that forwards user messages to the orchestrator router.
- **Router Chain** – Lightweight intent gate: defaults to Betting Wizard and only routes explicit sheet/raw-history commands.
- **Conversation Store** – In-memory per-chat memory (card, selected fight, recent turns) for follow-up coherence.
- **Betting Wizard Agent** – Responses API agent with built-in `web_search` plus function tools for fight history and user memory.
- **Sheet Ops Tool** – Google Sheets integration backed by the official `googleapis` client and service account credentials.
- **Fights Data Tool** – Reads the Google Sheet and extracts fighter history relevant to the user’s query (no external scraping).

## Project Structure

```
/src
  /platform
    launcher.js          # Entrypoint multi-bot por BOT_ID
    manifest.js          # Validacion del contrato bot.manifest.json
    /billing             # Cliente y bridge de billing compartido
    /policy              # Guardrails transversales por dominio
    /runtime             # Health/topup runtime reusable
  /services
    /billing             # Billing service (wallet global + MP webhook)
  /bots
    /ufc                 # Bot UFC migrado al contrato factory
    /nutrition           # Bot scaffolded (template expert_advisor)
    /medical_reader      # Bot scaffolded (template document_reader)
    /templates           # Templates para scaffold de nuevos bots
  /core
    index.js             # Shim de compatibilidad que delega a platform/launcher
    routerChain.js       # Message intent detection and orchestration
    conversationStore.js # Per-chat memory and fight reference resolver
    telegramBot.js       # Telegram bot configuration and polling loop
    sqliteStore.js       # SQLite domain persistence (ledger/event intel/local fallback credits)
    eventIntel.js        # Next-event discovery + fighter news monitor
    env.js               # Tiny .env loader (no third-party dependency)
  /agents
    bettingWizard.js     # Conversational UFC analyst (OpenAI tool-calling)
  /tools
    sheetOpsTool.js      # Google Sheets helpers using the official SDK
    fightsScalperTool.js # Fighter history extractor built on top of the sheet tool
.env.example
package.json
README.md
```

## Prerequisites

- Node.js 18+
- Access to the OpenAI API
- Telegram bot token (via BotFather)
- Google Cloud project with a Sheets-enabled service account

## Google Sheets Setup

1. Create a Google Cloud project and enable the **Google Sheets API**.
2. Create a **Service Account** and download the JSON key. Rename it to `service-account.json` and store it at the project root (already ignored by Git) if you prefer file-based credentials.
3. Share your target Google Sheet with the service account email so it can read/write data.
4. Copy the service account email and private key into `.env` (see `.env.example`). Escape newline characters in the private key with `\n`.

## Environment Variables

Create a `.env` file based on `.env.example`:

```
BOT_ID=ufc
INTERACTION_MODE=guided_strict
BOT_POLICY_PACK=general_safe_advice
BOT_ENV_FILE=
OPENAI_API_KEY=sk-...
TELEGRAM_BOT_TOKEN=...
TELEGRAM_INTERACTION_MODE=guided_strict
GUIDED_QUOTES_TEXT_FALLBACK=true
TELEGRAM_CALLBACK_DEDUP_WINDOW_MS=2500
TELEGRAM_CALLBACK_DEDUP_MAX_KEYS_PER_CHAT=80
BOT_ALLOWED_TELEGRAM_USER_IDS=
DEFAULT_USER_TIMEZONE=America/Argentina/Buenos_Aires
NUTRITION_SMART_MODELS=gpt-5.4,gpt-5.2,gpt-4.1-mini
UFC_DB_BACKUP_ENABLED=true
UFC_DB_BACKUP_DIR=/home/ubuntu/bot-data/ufc/backups
UFC_DB_BACKUP_INTERVAL_MS=21600000
UFC_DB_BACKUP_RETENTION_DAYS=14
NUTRITION_DB_BACKUP_ENABLED=true
NUTRITION_DB_BACKUP_DIR=/home/ubuntu/bot-data/nutrition/backups
NUTRITION_DB_BACKUP_INTERVAL_MS=21600000
NUTRITION_DB_BACKUP_RETENTION_DAYS=14
NUTRITION_TELEGRAM_BOT_TOKEN=
MEDICAL_READER_TELEGRAM_BOT_TOKEN=
BILLING_BASE_URL=
BILLING_API_TOKEN=
BILLING_TIMEOUT_MS=8000
BILLING_PORT=3200
BILLING_DB_PATH=/home/ubuntu/bot-data/billing/billing.db
BILLING_PUBLIC_URL=
BILLING_EVENT_WEBHOOK_URLS=
SHEET_ID=...
GOOGLE_SERVICE_ACCOUNT_EMAIL=...
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
BETTING_MODEL=gpt-4o-mini
BETTING_DECISION_MODEL=gpt-5.2
BETTING_TEMPERATURE=0.35
BETTING_MAX_RECENT_TURNS=8
STAKE_MIN_AMOUNT_DEFAULT=2000
STAKE_MIN_UNITS_DEFAULT=2.5
STAKE_EVENT_UTILIZATION_CONSERVADOR=28
STAKE_EVENT_UTILIZATION_MODERADO=35
STAKE_EVENT_UTILIZATION_AGRESIVO=45
STAKE_MAX_PICK_EXPOSURE_CONSERVADOR=16
STAKE_MAX_PICK_EXPOSURE_MODERADO=22
STAKE_MAX_PICK_EXPOSURE_AGRESIVO=30
STAKE_EVENT_FIGHTS_DEFAULT=6
STAKE_EVENT_DYNAMIC_FLOOR_PCT=75
KNOWLEDGE_FILE=./Knowledge/ufc_bets_playbook.md
KNOWLEDGE_MAX_CHARS=9000
DB_PATH=/var/lib/ufc-orchestrator/bot.db
CONVERSATION_TTL_MS=86400000
CONVERSATION_MAX_TURNS=20
CONVERSATION_MAX_TURN_CHARS=1600
MAX_MEDIA_BYTES=26214400
AUDIO_TRANSCRIBE_MODEL=gpt-4o-mini-transcribe
MAX_AUDIO_TRANSCRIPT_CHARS=4000
MEDIA_GROUP_FLUSH_MS=900
CREDIT_ENFORCE=true
CREDIT_FREE_WEEKLY=5
CREDIT_DECISION_COST=1
CREDIT_IMAGE_DAILY_FREE=5
CREDIT_IMAGE_OVERAGE_COST=0.5
CREDIT_AUDIO_WEEKLY_FREE_MINUTES=10
CREDIT_AUDIO_OVERAGE_COST=0.2
CREDIT_TOPUP_URL=
CREDIT_WEBHOOK_TOKEN=
APP_PUBLIC_URL=
MP_ACCESS_TOKEN=
MP_WEBHOOK_TOKEN=
MP_NOTIFICATION_URL=
MP_TOPUP_PACKS=10:1000,20:1800
MP_TOPUP_DEFAULT_CREDITS=10
MP_TOPUP_TITLE=Recarga de creditos UFC
MP_CURRENCY_ID=ARS
MP_SUCCESS_URL=
MP_PENDING_URL=
MP_FAILURE_URL=
FIGHT_HISTORY_RANGE=Fight History!A:Z
FIGHT_HISTORY_SYNC_INTERVAL_MS=21600000
FIGHT_HISTORY_CACHE_DIR=./data
MAIN_CARD_FIGHTS_COUNT=5
WEB_NEWS_DAYS=3
WEB_EVENT_LOOKUP_DAYS=120
WEB_NEXT_EVENT_LOOKUP_DAYS=45
WEB_NEWS_MAX_ITEMS=6
EVENT_INTEL_DISCOVERY_INTERVAL_MS=21600000
EVENT_INTEL_NEWS_BASE_TICK_MS=3600000
EVENT_INTEL_NEWS_SCAN_MS_FAR=28800000
EVENT_INTEL_NEWS_SCAN_MS_NEAR=14400000
EVENT_INTEL_NEWS_SCAN_MS_FINAL=7200000
EVENT_INTEL_NEWS_LOOKBACK_DAYS=4
EVENT_INTEL_NEWS_MAX_PER_FIGHTER=6
EVENT_INTEL_NEWS_USER_LIMIT=8
EVENT_INTEL_PROJECTION_NEWS_LIMIT=80
EVENT_INTEL_NEWS_DEFAULT_MIN_IMPACT=medium
ODDS_API_KEY=
ODDS_API_BASE_URL=https://api.the-odds-api.com/v4
ODDS_API_TIMEOUT_MS=12000
ODDS_API_MMA_SPORT_KEY=mma_mixed_martial_arts
ODDS_API_DEFAULT_REGIONS=us
ODDS_API_DEFAULT_MARKETS=h2h
ODDS_API_DEFAULT_ODDS_FORMAT=decimal
ODDS_API_DEFAULT_DATE_FORMAT=iso
ODDS_INTEL_ODDS_INTERVAL_MS=7200000
ODDS_INTEL_EVENTS_INTERVAL_MS=21600000
ODDS_INTEL_SCORES_INTERVAL_MS=14400000
ODDS_INTEL_MIN_REQUESTS_REMAINING=20
ODDS_INTEL_SCORES_DAYS_FROM=2
ODDS_INTEL_LOOKAHEAD_DAYS=45
PRE_FIGHT_ANALYSIS_INTERVAL_MS=10800000
PRE_FIGHT_ANALYSIS_REASONING_VERSION=v1_news_odds
PRE_FIGHT_ANALYSIS_CHANGE_THRESHOLD=6
ODDS_API_CACHE_TTL_SPORTS_MS=86400000
ODDS_API_CACHE_TTL_ODDS_MS=1200000
ODDS_API_CACHE_TTL_SCORES_MS=300000
ODDS_API_CACHE_TTL_EVENTS_MS=3600000
ODDS_API_CACHE_TTL_EVENT_ODDS_MS=600000
ODDS_API_CACHE_TTL_EVENT_MARKETS_MS=1200000
ODDS_API_CACHE_TTL_PARTICIPANTS_MS=86400000
ODDS_API_CACHE_TTL_HISTORICAL_ODDS_MS=604800000
ODDS_API_CACHE_TTL_HISTORICAL_EVENTS_MS=604800000
ODDS_API_CACHE_TTL_HISTORICAL_EVENT_ODDS_MS=604800000
PORT=3000
```

The lightweight loader in `src/core/env.js` populates `process.env` without relying on `dotenv`.

`DB_PATH` should point outside the git repo in hosted environments (for example `/var/lib/ufc-orchestrator/bot.db`) to avoid shipping runtime data in version control.

## Installation & Local Development

```bash
npm install
npm run start:billing
BOT_ID=ufc npm run start:bot
```

`start:billing` levanta la billetera global compartida. `start:bot` levanta una instancia de bot por `BOT_ID`.
Podés seguir usando `npm run start` para lanzar el bot default (`BOT_ID=ufc`).

### Local Fight History Cache

- On startup, `fightsScalper` syncs `Fight History` from Google Sheets into `data/fight_history.json`.
- A background sync runs every 6 hours by default (`FIGHT_HISTORY_SYNC_INTERVAL_MS=21600000`).
- Betting Wizard can call `get_fighter_history` against this cache whenever the model needs stats for analysis.

### Conversational Memory

- The bot keeps per-chat memory (recent turns, detected event card, and selected fight references).
- Follow-up inputs like `que opinas de la pelea 1` are auto-resolved to fighter names from the last card in context.
- Memory expiration is configurable with `CONVERSATION_TTL_MS`.

### Guided Interaction Mode (Telegram)

- Default mode is `guided_strict` (`TELEGRAM_INTERACTION_MODE=guided_strict`).
- En `guided_strict`, el menú depende del `domain_pack.guided_menu` del manifest:
  - `ufc_v1`: menú UFC guiado (análisis/ledger/créditos/ayuda).
  - `nutrition_v1`: módulos guiados de nutrición (`Registrar ingesta`, `Registrar pesaje`, `Perfil/objetivos`, `Resumen`, `Aprendizaje`, `Créditos`, `Ayuda`).
- Para UFC (`ufc_v1`), el menú visible es:
  - `Analizar cuotas`
  - `Ledger`
  - `Creditos`
  - `Ayuda`
- Free-form text is blocked by default and re-routed to the guided flow, except when it looks like structured odds input.
- Structured text fallback is controlled with `GUIDED_QUOTES_TEXT_FALLBACK=true|false`.
- In this bot, "quotes" means sportsbook odds/cuotas for a specific fight.
- For actionable quote analysis, the recommended input is a full screenshot of the betting page for that fight (no crop). Text fallback format: `evento, pelea, mercado, cuota`.
- In guided ledger:
  - `Registrar`: screenshot ticket first, text fallback `evento, pelea, pick, cuota, stake`.
  - `Cerrar`: screenshot resultado first, text fallback `bet_id + WON/LOST/PUSH`.
  - `Pendientes` and `Historial`: consultas de lectura del ledger.
- Rollback to previous behavior is immediate by setting `TELEGRAM_INTERACTION_MODE=hybrid` and restarting the process.
- QA privado opcional por allowlist: `BOT_ALLOWED_TELEGRAM_USER_IDS=123,456`.

#### Nutrition V1 Notes

- `Aprendizaje` es el único módulo con chat libre.
- Fuera de `Aprendizaje`, el bot reencauza al módulo operativo seleccionado.
- `Registrar ingesta` y `Aprendizaje` usan la familia de modelos configurada en `NUTRITION_SMART_MODELS` (fallback automático por disponibilidad).
- En `Aprendizaje`, si el mensaje pide datos personales (`resumen`, `cómo vengo`, `qué comí`, `perfil`, `último peso`), se responde **DB-first** con datos reales de SQLite antes de usar chat libre.
- V1 no incluye OCR de platos/comidas generales ni lookup online automático de productos de marca.
- Si en ingesta aparece un producto de paquete no bien identificado, el bot pide foto de tabla nutricional y puede guardar/actualizar ese producto en `INFO_NUTRICIONAL` (catálogo global).
- Si no se informa hora/fecha en ingesta o pesaje, usa hora local del usuario (`DEFAULT_USER_TIMEZONE` o perfil).
- Escrituras de `ingesta`, `pesaje` y `perfil` tienen idempotencia por mensaje Telegram (`user_id + operation + message_id`) para evitar duplicados por reintentos.
- Si una escritura falla, el bot devuelve error explícito y no confirma “anotado”.

#### Nutrition DB Reliability

- Backup automático rotativo para Nutrition DB (configurable por env):
  - `NUTRITION_DB_BACKUP_ENABLED=true|false`
  - `NUTRITION_DB_BACKUP_DIR=/home/ubuntu/bot-data/nutrition/backups`
  - `NUTRITION_DB_BACKUP_INTERVAL_MS=21600000` (default 6h)
  - `NUTRITION_DB_BACKUP_RETENTION_DAYS=14`
- En cada ciclo: verificación `PRAGMA quick_check` + validación de tablas críticas + backup `.sqlite`.
- Comandos manuales:
  - `npm run nutrition:db:verify`
  - `npm run nutrition:db:backup`

#### UFC DB Reliability

- Backup automático rotativo para UFC DB (configurable por env):
  - `UFC_DB_BACKUP_ENABLED=true|false`
  - `UFC_DB_BACKUP_DIR=/home/ubuntu/bot-data/ufc/backups`
  - `UFC_DB_BACKUP_INTERVAL_MS=21600000` (default 6h)
  - `UFC_DB_BACKUP_RETENTION_DAYS=14`
- En cada ciclo: verificación `PRAGMA quick_check` + validación de tablas críticas + backup `.sqlite`.
- Comandos manuales:
  - `npm run ufc:db:verify`
  - `npm run ufc:db:backup`

### Web Enrichment Before Analysis

- Betting Wizard uses OpenAI `web_search` via the Responses API for live event/card validation.
- For schedule queries, prompts instruct source priority (`ufc.com` → `espn.com` → other sources) and require live verification before answering.
- By default the bot does not show citations unless the user asks for sources explicitly (`fuentes`, `links`, etc.).

### Event Intel (next event + fighter news)

- A background monitor keeps `next_event` reconciled (event name/date + main card fighters).
- Another job scans fighter news on a dynamic cadence (far/near/final week) and stores deduped items in SQLite.
- New user-facing flows:
  - `Últimas novedades`: latest relevant news for the next UFC event.
  - `Proyecciones`: fight-by-fight projection snapshot with confidence and only relevant signals.
  - `Alertas noticias`: `activar`, `desactivar`, `estado`, `toggle` per-user (stored in `user_intel_prefs`).

### The Odds API Integration (tier-aware)

- A dedicated tool wraps The Odds API V4 endpoints with SQLite cache to minimize token usage.
- Implemented endpoint coverage:
  - `sports`
  - `sports/{sport}/odds`
  - `sports/{sport}/scores`
  - `sports/{sport}/events`
  - `sports/{sport}/events/{eventId}/odds`
  - `sports/{sport}/events/{eventId}/markets`
  - `sports/{sport}/participants`
  - historical equivalents for odds/events/event-odds
- Background monitor (`oddsIntel`) syncs:
  - upcoming MMA/UFC events index,
  - bookmaker odds snapshots,
  - scores (for completion tracking).
- Pre-analysis monitor (`preFightAnalysis`) materializes fight projection snapshots in DB so the wizard can render precomputed recommendations quickly.
- Quota guardrails:
  - stores `x-requests-*` headers on each call,
  - skips non-critical syncs when remaining quota falls below `ODDS_INTEL_MIN_REQUESTS_REMAINING`.
- Date guardrail: The Odds API requires `commenceTimeFrom/commenceTimeTo/date` as `YYYY-MM-DDTHH:MM:SSZ` (no milliseconds). The tool now normalizes this automatically.
- Plan guardrail: historical endpoints return `HISTORICAL_UNAVAILABLE_ON_FREE_USAGE_PLAN` on free tier; current integration logs this cleanly and does not rely on historical data for baseline operation.
- Product note: The Odds API does not provide fighter news articles or deep fighter statistics; for that, the bot keeps using web/news intelligence.

### Media Inputs (Fotos y Audio)

- El bot acepta fotos y las envía como `input_image` al Responses API.
- Si el usuario manda un album (varias fotos juntas), espera un instante y analiza todas juntas antes de responder.
- Los audios (voice o audio) se transcriben con la Audio API (`gpt-4o-mini-transcribe`) y luego se pasa el texto resultante a Responses.
- La conversión de audio requiere `ffmpeg` (se incluye `ffmpeg-static` por defecto).

### Odds Guardadas (por usuario)

- Cuando el usuario envía cuotas, el bot las guarda en SQLite (tabla `odds_snapshots`).
- Antes de pedir cuotas nuevas para una pelea, el bot intenta reutilizar las últimas cuotas guardadas del usuario.

### Créditos y límites (Free tier + recargas)

- El bot puede aplicar créditos por análisis con cuotas (gpt-5.2), exceso de imágenes o audio.
- Free tier por defecto: 5 créditos semanales, 5 fotos/día, 10 minutos de audio/semana.
- Variables clave: `CREDIT_FREE_WEEKLY`, `CREDIT_IMAGE_DAILY_FREE`, `CREDIT_AUDIO_WEEKLY_FREE_MINUTES`.
- Si faltan créditos, responde con un mensaje de recarga (usa `CREDIT_TOPUP_URL`).
- `CREDIT_TOPUP_URL` acepta placeholders `{user_id}` o `{telegram_user_id}` para generar links dinámicos por usuario.
- En `Creditos`, el bot muestra equivalencias de packs `ARS -> créditos` usando `MP_TOPUP_PACKS`.
- Recarga manual (admin):
  ```bash
  npm run credits:add -- --user <telegram_user_id> --credits 20
  ```
- Webhook simple para recargas:
  - Endpoint: `POST /webhooks/credits?token=SECRETO`
  - Body JSON:
    ```json
    { "telegram_user_id": "1806836602", "credits": 20, "reason": "mercadopago" }
    ```
  - Configurá `CREDIT_WEBHOOK_TOKEN` en `.env` y usá ese token en la URL.

### Mercado Pago Checkout Pro (recarga real)

- Endpoints expuestos por el bot:
  - `GET /topup/checkout?user_id=<telegram_user_id>&credits=<pack>`
  - `GET /topup/checkout?user_id=<telegram_user_id>` (selector web de pack)
  - `POST /webhooks/mercadopago` (webhook de Mercado Pago)
  - `GET /topup/result?status=...` (pantalla web de resultado, sin descarga de archivo)
  - `GET /topup/config` (estado de configuración)
- Configuración mínima en `.env`:
  - `MP_ACCESS_TOKEN` (token de producción o de pruebas según ambiente)
  - `MP_TOPUP_PACKS` en formato `creditos:monto` (ej: `10:1000,20:1800`)
  - `APP_PUBLIC_URL` (URL pública donde corre tu bot)
  - `CREDIT_TOPUP_URL` recomendado:
    - `https://tu-dominio.com/topup/checkout?user_id={user_id}`
- Seguridad opcional:
  - `MP_WEBHOOK_TOKEN`: si lo seteás, Mercado Pago debe llamar al webhook con `?token=...`.
  - `MP_NOTIFICATION_URL`: fuerza la URL de notificación enviada en la preferencia. Si no se setea, se usa `APP_PUBLIC_URL/webhooks/mercadopago`.
- Flujo:
  - El usuario abre el link de `/topup/checkout` (sin `credits`) y elige pack.
  - El backend crea una preferencia en Checkout Pro (`/checkout/preferences`).
  - Mercado Pago notifica a `/webhooks/mercadopago`.
  - El backend consulta `/v1/payments/{id}` y acredita créditos solo si `status=approved`.
  - Si acredita, el bot envía notificación automática por Telegram con créditos sumados y saldo actualizado.
  - La acreditación es idempotente por `payment_id` (evita doble recarga por reintentos del webhook).

### History Scraper (interno)

- Agente interno para completar Fight History usando Responses API + `web_search`.
- Flujo: lee la ultima fecha cargada en Google Sheets y trae todos los eventos posteriores hasta hoy.
- Ejecucion manual:
  ```bash
  npm run history:sync
  ```
- Configuracion en `.env`:
  - `HISTORY_SCRAPER_MODEL`
  - `HISTORY_SCRAPER_MAX_EVENTS`
  - `HISTORY_SCRAPER_DRY_RUN`
  - `HISTORY_SCRAPER_DOMAINS`
  - `HISTORY_SCRAPER_LOG_PATH` (log JSONL de eventos procesados)

### Running Tests

```bash
npm test
```

This executes Node-based assertions for router, memory, tools, web intel, and betting wizard orchestration.

## Quick Telegram Smoke Test

1. Run `npm run start` and keep the process alive.
2. Open Telegram, find your bot, and send `/start`.
3. Send one message for each flow:
   - Betting Wizard: `Analizame Pereira vs Ankalaev y dame una estrategia conservadora.`
   - Sheet Ops: `leer Fight History!A1:E10`
   - Fights Scalper: `historial de Pereira vs Ankalaev`
4. Confirm you get responses in chat and check local logs for router decisions.

## Running on Replit

1. Import the repository into Replit.
2. Add the environment variables through the **Secrets** UI (they persist per Repl).
3. Upload `service-account.json` via the file explorer if you prefer file-based credentials.
4. Update the Replit run command to `npm run start`.
5. Polling works without exposing a public port, but you can still expose port `3000` for the included health check.

## Deployment Notes

- **Render**: Use a Web Service with a Node.js runtime, set environment variables in the dashboard, and optionally configure a webhook URL for Telegram.
- **Oracle Cloud**: Deploy via Oracle Functions or an Always Free Compute instance. Ensure outbound internet access for Telegram, Google APIs, and OpenAI.

## Extending to WhatsApp

To adapt this orchestrator for WhatsApp, swap out the Telegram bot module for a WhatsApp Business API (or Twilio WhatsApp) listener. The router and core agent orchestration can remain unchanged; only the inbound/outbound transport layer needs to change.

## Next Steps

Future enhancements could include:

- Adding vector-based long-term memory for historical fight analysis.
- Scheduling automatic sheet refreshes before major UFC events.
- Capturing analytics and logging conversational metrics.
