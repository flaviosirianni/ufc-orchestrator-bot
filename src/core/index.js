import '../core/env.js';
import http from 'node:http';
import { startTelegramBot } from './telegramBot.js';
import { createRouterChain } from './routerChain.js';
import * as sheetOps from '../tools/sheetOpsTool.js';
import * as fightsScalper from '../tools/fightsScalperTool.js';
import * as webIntel from '../tools/webIntelTool.js';
import { createBettingWizard } from '../agents/bettingWizard.js';
import { createConversationStore } from './conversationStore.js';
import { createSessionLogger } from './sessionLogger.js';
import {
  getUserProfile,
  updateUserProfile,
  addBetRecord,
  getBetHistory,
  getLedgerSummary,
  addOddsSnapshot,
  getLatestOddsSnapshot,
  addUsageRecord,
  getCreditState,
  spendCredits,
  addCredits,
  getUsageCounters,
  getDbPath,
} from './sqliteStore.js';

function createHealthServer(port, { addCredits } = {}) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'POST' && url.pathname === '/webhooks/credits') {
      const token = url.searchParams.get('token');
      const expected = process.env.CREDIT_WEBHOOK_TOKEN || '';
      if (expected && token !== expected) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'forbidden' }));
        return;
      }

      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        let payload = null;
        try {
          payload = raw ? JSON.parse(raw) : {};
        } catch {
          payload = null;
        }

        if (!payload || !payload.telegram_user_id || !payload.credits) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'invalid_payload' }));
          return;
        }

        if (typeof addCredits === 'function') {
          addCredits(String(payload.telegram_user_id), Number(payload.credits), {
            reason: payload.reason || 'webhook_topup',
            metadata: payload.metadata || null,
          });
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('UFC Orchestrator Bot is running.');
  });

  server.listen(port, () => {
    console.log(`Health check server listening on port ${port}`);
  });

  return server;
}

function bootstrap() {
  const conversationStore = createConversationStore();
  const sessionLogger = createSessionLogger();
  console.log('[bootstrap] SQLite DB:', getDbPath());

  fightsScalper.startFightHistorySync({
    intervalMs: Number(process.env.FIGHT_HISTORY_SYNC_INTERVAL_MS ?? '21600000'),
  });

  const bettingWizard = createBettingWizard({
    sheetOps,
    fightsScalper,
    webIntel,
    conversationStore,
    userStore: {
      getUserProfile,
      updateUserProfile,
      addBetRecord,
      getBetHistory,
      getLedgerSummary,
      addOddsSnapshot,
      getLatestOddsSnapshot,
      recordUsage: addUsageRecord,
      getCreditState,
      spendCredits,
      addCredits,
      getUsageCounters,
    },
  });

  console.log('[bootstrap] Betting Wizard instance type:', {
    isPromise: bettingWizard instanceof Promise,
    hasHandleMessage: typeof bettingWizard?.handleMessage === 'function',
  });

  const router = createRouterChain({
    sheetOps,
    fightsScalper,
    bettingWizard,
    conversationStore,
    sessionLogger,
  });

  startTelegramBot(router);

  const port = Number(process.env.PORT || 3000);
  createHealthServer(port, { addCredits });
}

bootstrap();
