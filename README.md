# UFC Orchestrator Bot

UFC Orchestrator Bot is a Telegram automation system that coordinates LangChain agents and Google Sheets to streamline UFC betting research. The orchestrator exposes a conversational assistant that can surface fighter history from a curated sheet and route requests to a LangChain-powered analyst.

## Architecture Overview

```
User → Telegram Bot → LangChain Router → Betting Wizard Agent → Sheet Ops Tool / Fights Data Tool → Google Sheet → Response back to Telegram
```

### Core Components

- **Telegram Bot** – Polling client built with `node-telegram-bot-api` that forwards user messages to the orchestrator router.
- **Router Chain** – Intent detector that selects between sheet checks and betting analysis.
- **Betting Wizard Agent** – A LangChain-powered reasoning agent that uses the Sheet Ops and Fights Data tools to craft insights and betting angles.
- **Sheet Ops Tool** – Google Sheets integration backed by the official `googleapis` client and service account credentials.
- **Fights Data Tool** – Reads the Google Sheet and extracts fighter history relevant to the user’s query (no external scraping).

## Project Structure

```
/src
  /core
    index.js             # Entry point that wires everything together
    routerChain.js       # Message intent detection and orchestration
    telegramBot.js       # Telegram bot configuration and polling loop
    env.js               # Tiny .env loader (no third-party dependency)
  /agents
    bettingWizard.js     # LangChain agent that generates betting strategies
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
PORT=3000
```

The lightweight loader in `src/core/env.js` populates `process.env` without relying on `dotenv`.

## Installation & Local Development

```bash
npm install
npm run start
```

The `start` script launches the Telegram bot with polling enabled. Keep the process running and send messages to your bot from Telegram to interact with the orchestrator.

### Running Tests

```bash
npm test
```

This executes a small Node-based assertion suite that validates router behaviour.

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

To adapt this orchestrator for WhatsApp, swap out the Telegram bot module for a WhatsApp Business API (or Twilio WhatsApp) listener. The router and LangChain agents can remain unchanged—only the inbound/outbound transport layer needs to change.

## Next Steps

Future enhancements could include:

- Adding vector-based memory for historical fight analysis.
- Scheduling automatic sheet refreshes before major UFC events.
- Capturing analytics and logging conversational metrics.
