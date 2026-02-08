# UFC Orchestrator Bot

UFC Orchestrator Bot is a Telegram automation system that combines OpenAI tool-calling, Google Sheets data, and web signals to streamline UFC betting research. The assistant preserves chat context per user so follow-up questions like "pelea 1" stay coherent.

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
  /core
    index.js             # Entry point that wires everything together
    routerChain.js       # Message intent detection and orchestration
    conversationStore.js # Per-chat memory and fight reference resolver
    telegramBot.js       # Telegram bot configuration and polling loop
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
OPENAI_API_KEY=sk-...
TELEGRAM_BOT_TOKEN=...
SHEET_ID=...
GOOGLE_SERVICE_ACCOUNT_EMAIL=...
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
BETTING_MODEL=gpt-4o-mini
BETTING_DECISION_MODEL=gpt-5.2
BETTING_TEMPERATURE=0.35
BETTING_MAX_RECENT_TURNS=8
KNOWLEDGE_FILE=./Knowledge/ufc_bets_playbook.md
KNOWLEDGE_MAX_CHARS=9000
DB_PATH=./data/bot.db
CONVERSATION_TTL_MS=86400000
CONVERSATION_MAX_TURNS=20
CONVERSATION_MAX_TURN_CHARS=1600
MAX_MEDIA_BYTES=26214400
AUDIO_TRANSCRIBE_MODEL=gpt-4o-mini-transcribe
MAX_AUDIO_TRANSCRIPT_CHARS=4000
MEDIA_GROUP_FLUSH_MS=900
FIGHT_HISTORY_RANGE=Fight History!A:Z
FIGHT_HISTORY_SYNC_INTERVAL_MS=21600000
FIGHT_HISTORY_CACHE_DIR=./data
MAIN_CARD_FIGHTS_COUNT=5
WEB_NEWS_DAYS=3
WEB_EVENT_LOOKUP_DAYS=120
WEB_NEXT_EVENT_LOOKUP_DAYS=45
WEB_NEWS_MAX_ITEMS=6
PORT=3000
```

The lightweight loader in `src/core/env.js` populates `process.env` without relying on `dotenv`.

## Installation & Local Development

```bash
npm install
npm run start
```

The `start` script launches the Telegram bot with polling enabled. Keep the process running and send messages to your bot from Telegram to interact with the orchestrator.

### Local Fight History Cache

- On startup, `fightsScalper` syncs `Fight History` from Google Sheets into `data/fight_history.json`.
- A background sync runs every 6 hours by default (`FIGHT_HISTORY_SYNC_INTERVAL_MS=21600000`).
- Betting Wizard can call `get_fighter_history` against this cache whenever the model needs stats for analysis.

### Conversational Memory

- The bot keeps per-chat memory (recent turns, detected event card, and selected fight references).
- Follow-up inputs like `que opinas de la pelea 1` are auto-resolved to fighter names from the last card in context.
- Memory expiration is configurable with `CONVERSATION_TTL_MS`.

### Web Enrichment Before Analysis

- Betting Wizard uses OpenAI `web_search` via the Responses API for live event/card validation.
- For schedule queries, prompts instruct source priority (`ufc.com` → `espn.com` → other sources) and require live verification before answering.
- By default the bot does not show citations unless the user asks for sources explicitly (`fuentes`, `links`, etc.).

### Media Inputs (Fotos y Audio)

- El bot acepta fotos y las envía como `input_image` al Responses API.
- Si el usuario manda un album (varias fotos juntas), espera un instante y analiza todas juntas antes de responder.
- Los audios (voice o audio) se transcriben con la Audio API (`gpt-4o-mini-transcribe`) y luego se pasa el texto resultante a Responses.
- La conversión de audio requiere `ffmpeg` (se incluye `ffmpeg-static` por defecto).

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
