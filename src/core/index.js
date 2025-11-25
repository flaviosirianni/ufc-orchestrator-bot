import '../core/env.js';
import http from 'node:http';
import { startTelegramBot } from './telegramBot.js';
import { createRouterChain } from './routerChain.js';
import * as sheetOps from '../tools/sheetOpsTool.js';
import * as fightsScalper from '../tools/fightsScalperTool.js';
import { createBettingWizard } from '../agents/bettingWizard.js';

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
  const bettingWizard = createBettingWizard({
    sheetOps,
    fightsScalper,
  });

  console.log('[bootstrap] Betting Wizard instance type:', {
    isPromise: bettingWizard instanceof Promise,
    hasHandleMessage: typeof bettingWizard?.handleMessage === 'function',
  });

  const router = createRouterChain({
    sheetOps,
    fightsScalper,
    bettingWizard,
  });

  startTelegramBot(router);

  const port = Number(process.env.PORT || 3000);
  createHealthServer(port);
}

bootstrap();
