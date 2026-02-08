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
  addUsageRecord,
  getDbPath,
} from './sqliteStore.js';

function createHealthServer(port) {
  const server = http.createServer((req, res) => {
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
      recordUsage: addUsageRecord,
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
  createHealthServer(port);
}

bootstrap();
