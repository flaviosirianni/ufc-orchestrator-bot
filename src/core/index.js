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
  listUserBets,
  previewBetMutation,
  applyBetMutation,
  addOddsSnapshot,
  getLatestOddsSnapshot,
  addUsageRecord,
  getCreditState,
  spendCredits,
  addCredits,
  creditFromMercadoPagoPayment,
  getUsageCounters,
  getDbPath,
} from './sqliteStore.js';
import {
  createTopupPreference,
  getPaymentById,
  extractTopupCreditFromPayment,
  getMercadoPagoConfig,
} from './mercadoPago.js';
function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve(null);
      }
    });
  });
}

function createHealthServer(
  port,
  { addCredits, creditFromMercadoPagoPayment } = {}
) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'POST' && url.pathname === '/webhooks/credits') {
      const token = url.searchParams.get('token');
      const expected = process.env.CREDIT_WEBHOOK_TOKEN || '';
      if (expected && token !== expected) {
        sendJson(res, 403, { ok: false, error: 'forbidden' });
        return;
      }

      const payload = await readJsonBody(req);
      if (!payload || !payload.telegram_user_id || !payload.credits) {
        sendJson(res, 400, { ok: false, error: 'invalid_payload' });
        return;
      }

      if (typeof addCredits === 'function') {
        addCredits(String(payload.telegram_user_id), Number(payload.credits), {
          reason: payload.reason || 'webhook_topup',
          metadata: payload.metadata || null,
        });
      }

      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/topup/checkout') {
      const userId =
        url.searchParams.get('user_id') ||
        url.searchParams.get('telegram_user_id') ||
        '';
      const creditsRequested = url.searchParams.get('credits');
      const format = String(url.searchParams.get('format') || '').toLowerCase();

      const preference = await createTopupPreference({
        userId,
        creditsRequested,
      });

      if (!preference.ok) {
        sendJson(res, preference.status || 400, {
          ok: false,
          error: preference.error || 'could_not_create_preference',
          packs: preference.packs || undefined,
        });
        return;
      }

      if (format === 'json') {
        sendJson(res, 200, {
          ok: true,
          userId,
          credits: preference.credits,
          amount: preference.amount,
          preferenceId: preference.preference?.id || null,
          redirectUrl: preference.redirectUrl || null,
        });
        return;
      }

      if (!preference.redirectUrl) {
        sendJson(res, 500, {
          ok: false,
          error: 'missing_checkout_redirect_url',
        });
        return;
      }

      res.writeHead(302, { Location: preference.redirectUrl });
      res.end();
      return;
    }

    if (req.method === 'POST' && url.pathname === '/webhooks/mercadopago') {
      const expectedToken = process.env.MP_WEBHOOK_TOKEN || '';
      const token = url.searchParams.get('token') || '';
      if (expectedToken && token !== expectedToken) {
        sendJson(res, 403, { ok: false, error: 'forbidden' });
        return;
      }

      const payload = await readJsonBody(req);
      const topic = String(
        payload?.type ||
          url.searchParams.get('type') ||
          url.searchParams.get('topic') ||
          ''
      ).toLowerCase();
      const paymentId = String(
        payload?.data?.id ||
          (topic === 'payment' ? payload?.id : '') ||
          url.searchParams.get('id') ||
          ''
      ).trim();

      if (topic && topic !== 'payment') {
        sendJson(res, 200, { ok: true, ignored: true, reason: 'non_payment_topic' });
        return;
      }

      if (!paymentId) {
        sendJson(res, 200, { ok: true, ignored: true, reason: 'missing_payment_id' });
        return;
      }

      const paymentResponse = await getPaymentById(paymentId);
      if (!paymentResponse.ok) {
        sendJson(res, 502, {
          ok: false,
          error: 'could_not_fetch_payment',
          paymentId,
        });
        return;
      }

      const payment = paymentResponse.body || {};
      const parsed = extractTopupCreditFromPayment(payment);
      if (!parsed.ok) {
        sendJson(res, 200, {
          ok: true,
          ignored: true,
          reason: parsed.error || 'missing_credit_metadata',
          paymentId,
        });
        return;
      }

      if (parsed.status !== 'approved') {
        sendJson(res, 200, {
          ok: true,
          processed: false,
          paymentId,
          paymentStatus: parsed.status,
        });
        return;
      }

      if (typeof creditFromMercadoPagoPayment !== 'function') {
        sendJson(res, 500, { ok: false, error: 'credit_handler_unavailable' });
        return;
      }

      const creditResult = creditFromMercadoPagoPayment({
        paymentId: parsed.paymentId,
        userId: parsed.userId,
        credits: parsed.credits,
        amount: parsed.transactionAmount,
        status: parsed.status,
        rawPayload: payment,
      });

      if (!creditResult.ok) {
        sendJson(res, 500, {
          ok: false,
          error: creditResult.error || 'could_not_apply_credit',
          paymentId: parsed.paymentId,
        });
        return;
      }

      sendJson(res, 200, {
        ok: true,
        paymentId: parsed.paymentId,
        telegramUserId: parsed.userId,
        credits: parsed.credits,
        alreadyProcessed: Boolean(creditResult.alreadyProcessed),
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/topup/result') {
      const status = String(url.searchParams.get('status') || 'unknown');
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(`Topup status: ${status}`);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/topup/config') {
      sendJson(res, 200, { ok: true, ...getMercadoPagoConfig() });
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
      listUserBets,
      previewBetMutation,
      applyBetMutation,
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
  createHealthServer(port, { addCredits, creditFromMercadoPagoPayment });
}

bootstrap();
