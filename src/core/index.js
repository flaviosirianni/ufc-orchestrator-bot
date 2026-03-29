import '../core/env.js';
import http from 'node:http';
import { startTelegramBot } from './telegramBot.js';
import { createRouterChain } from './routerChain.js';
import * as sheetOps from '../tools/sheetOpsTool.js';
import * as fightsScalper from '../tools/fightsScalperTool.js';
import * as webIntel from '../tools/webIntelTool.js';
import { createOddsApiTool } from '../tools/oddsApiTool.js';
import { createBettingWizard } from '../agents/bettingWizard.js';
import { createConversationStore } from './conversationStore.js';
import { createSessionLogger } from './sessionLogger.js';
import { startAutoSettlementMonitor } from './autoSettlement.js';
import { startEventIntelMonitor } from './eventIntel.js';
import { startOddsIntelMonitor } from './oddsIntel.js';
import { startPreFightAnalysisMonitor } from './preFightAnalysis.js';
import {
  getUserProfile,
  updateUserProfile,
  addBetRecord,
  getBetHistory,
  getLedgerSummary,
  listUserBets,
  previewBetMutation,
  applyBetMutation,
  previewCompositeBetMutations,
  applyCompositeBetMutations,
  undoLastBetMutation,
  addOddsSnapshot,
  getLatestOddsSnapshot,
  addUsageRecord,
  getCreditState,
  listCreditTransactions,
  spendCredits,
  addCredits,
  creditFromMercadoPagoPayment,
  getUsageCounters,
  getFightHistoryCacheSnapshot,
  upsertFightHistoryCacheSnapshot,
  listPendingBetsForAutoSettlement,
  getLatestChatIdForUser,
  getEventWatchState,
  upsertEventWatchState,
  insertFighterNewsItems,
  listLatestRelevantNews,
  getUserIntelPrefs,
  updateUserIntelPrefs,
  getOddsApiCacheEntry,
  upsertOddsApiCacheEntry,
  logOddsApiUsage,
  getLatestOddsApiQuotaState,
  listLatestOddsMarketsForFight,
  listLatestOddsMarketsForEvent,
  listUpcomingOddsEvents,
  listRecentOddsEvents,
  upsertOddsEventsIndex,
  insertOddsMarketSnapshots,
  getLatestProjectionForFight,
  insertFightProjectionSnapshots,
  listLatestProjectionSnapshotsForEvent,
  getLatestBetScoringForFight,
  listLatestBetScoringForEvent,
  insertFightBetScoringSnapshots,
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

function escapeHtml(value = '') {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatMoneyByCurrency(amount = 0, currencyId = 'ARS') {
  const value = Number(amount) || 0;
  const currency = String(currencyId || 'ARS').toUpperCase();
  try {
    return new Intl.NumberFormat('es-AR', {
      style: 'currency',
      currency,
      maximumFractionDigits: 0,
    }).format(value);
  } catch {
    return `$${Math.round(value).toLocaleString('es-AR')}`;
  }
}

function formatCreditsValue(value = 0) {
  const amount = Number(value) || 0;
  return amount.toFixed(2);
}

function buildTopupChooserHtml({ userId = '', packs = [], currencyId = 'ARS' } = {}) {
  const encodedUserId = encodeURIComponent(String(userId || '').trim());
  const packItems = (Array.isArray(packs) ? packs : [])
    .map((pack) => {
      const credits = Number(pack?.credits) || 0;
      const amount = Number(pack?.amount) || 0;
      if (!credits || !amount) return '';
      const href = `/topup/checkout?user_id=${encodedUserId}&credits=${credits}`;
      return `<li><a href="${escapeHtml(href)}">${credits} creditos - ${escapeHtml(
        formatMoneyByCurrency(amount, currencyId)
      )}</a></li>`;
    })
    .filter(Boolean)
    .join('');

  return [
    '<!doctype html>',
    '<html lang="es">',
    '<head>',
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    '<title>Recargar creditos UFC</title>',
    '<style>',
    'body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 24px; color: #111827; }',
    'main { max-width: 560px; margin: 0 auto; }',
    'h1 { font-size: 1.4rem; margin-bottom: 0.5rem; }',
    'p { color: #4b5563; }',
    'ul { list-style: none; padding: 0; margin: 1rem 0; display: grid; gap: 10px; }',
    'a { display: block; padding: 12px 14px; border: 1px solid #d1d5db; border-radius: 10px; text-decoration: none; color: #111827; font-weight: 600; }',
    'a:hover { border-color: #2563eb; background: #eff6ff; }',
    '.muted { margin-top: 1rem; font-size: 0.92rem; color: #6b7280; }',
    '</style>',
    '</head>',
    '<body>',
    '<main>',
    '<h1>Elegi un pack de recarga</h1>',
    '<p>Selecciona cuantos creditos queres cargar. Luego se abre Mercado Pago para completar el pago.</p>',
    `<ul>${packItems || '<li>No hay packs configurados.</li>'}</ul>`,
    '<p class="muted">Al confirmar el pago aprobado, los creditos se acreditan automaticamente en tu usuario de Telegram.</p>',
    '</main>',
    '</body>',
    '</html>',
  ].join('');
}

function buildTopupResultHtml(status = 'unknown') {
  const normalized = String(status || 'unknown').trim().toLowerCase();
  const titleByStatus = {
    success: '✅ Recarga acreditada',
    approved: '✅ Recarga acreditada',
    pending: '🕓 Pago pendiente',
    failure: '❌ Pago no completado',
    rejected: '❌ Pago rechazado',
    cancelled: '❌ Pago cancelado',
  };
  const title = titleByStatus[normalized] || 'ℹ️ Estado de recarga';

  const bodyByStatus = {
    success:
      'Tu pago fue confirmado. Si el bot no te avisó todavía en Telegram, abrí el chat y tocá `Creditos` para refrescar el saldo.',
    approved:
      'Tu pago fue confirmado. Si el bot no te avisó todavía en Telegram, abrí el chat y tocá `Creditos` para refrescar el saldo.',
    pending:
      'Mercado Pago indicó estado pendiente. Cuando se apruebe, los créditos se acreditan automáticamente.',
    failure:
      'El pago no se completó. Podés volver al checkout y reintentar con otro medio de pago.',
    rejected:
      'El pago fue rechazado. Podés volver al checkout y reintentar con otro medio de pago.',
    cancelled: 'Cancelaste el pago. Si querés, podés iniciar una recarga nueva desde Telegram.',
  };
  const body =
    bodyByStatus[normalized] ||
    'Volvé al chat de Telegram y revisá `Creditos` para ver el estado actualizado.';

  return [
    '<!doctype html>',
    '<html lang="es">',
    '<head>',
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    '<title>Estado de recarga</title>',
    '<style>',
    'body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 24px; color: #111827; background: #f8fafc; }',
    'main { max-width: 580px; margin: 0 auto; background: #ffffff; border: 1px solid #e5e7eb; border-radius: 14px; padding: 18px; }',
    'h1 { margin: 0 0 10px; font-size: 1.2rem; }',
    'p { margin: 0 0 10px; line-height: 1.45; color: #334155; }',
    '.hint { margin-top: 12px; font-size: 0.95rem; color: #64748b; }',
    '</style>',
    '</head>',
    '<body>',
    '<main>',
    `<h1>${escapeHtml(title)}</h1>`,
    `<p>${escapeHtml(body)}</p>`,
    '<p class="hint">Ya podés cerrar esta pestaña y volver a Telegram.</p>',
    '</main>',
    '</body>',
    '</html>',
  ].join('');
}

function normalizeText(value = '') {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function toFightKey(a = '', b = '') {
  const left = normalizeText(a);
  const right = normalizeText(b);
  if (!left || !right) return '';
  return [left, right].sort().join('::');
}

function mapOddsEventIndexRows(payload = [], fallbackSportKey = 'mma_mixed_martial_arts') {
  const events = Array.isArray(payload) ? payload : [];
  return events
    .map((item) => {
      const eventId = String(item?.id || '').trim();
      if (!eventId) return null;
      const homeTeam = String(item?.home_team || '').trim();
      const awayTeam = String(item?.away_team || '').trim();
      return {
        eventId,
        sportKey: String(item?.sport_key || fallbackSportKey || '').trim() || fallbackSportKey,
        eventName: homeTeam && awayTeam ? `${homeTeam} vs ${awayTeam}` : eventId,
        eventNormKey: toFightKey(homeTeam, awayTeam),
        commenceTime: item?.commence_time || null,
        homeTeam: homeTeam || null,
        awayTeam: awayTeam || null,
        completed: item?.completed === true,
        scores: Array.isArray(item?.scores) ? item.scores : null,
      };
    })
    .filter(Boolean);
}

function createHealthServer(
  port,
  {
    addCredits,
    creditFromMercadoPagoPayment,
    getCreditState,
    getLatestChatIdForUser,
    notifyUser,
  } = {}
) {
  const weeklyFreeCredits = Number(process.env.CREDIT_FREE_WEEKLY ?? '5');

  async function notifyTopupApplied({
    userId,
    credits = 0,
    amount = null,
    paymentId = '',
    sourceLabel = 'topup',
  } = {}) {
    const safeUserId = String(userId || '').trim();
    if (!safeUserId) return;
    if (
      typeof notifyUser !== 'function' ||
      typeof getLatestChatIdForUser !== 'function' ||
      typeof getCreditState !== 'function'
    ) {
      return;
    }

    const chatId = getLatestChatIdForUser(safeUserId);
    if (!chatId) return;

    const creditState = getCreditState(safeUserId, weeklyFreeCredits) || {
      availableCredits: 0,
      freeCredits: 0,
      paidCredits: 0,
    };

    const lines = [
      '✅ Recarga acreditada',
      `• +${formatCreditsValue(credits)} creditos`,
      `• Saldo actual: ${formatCreditsValue(creditState.availableCredits)} creditos`,
      `• Free: ${formatCreditsValue(creditState.freeCredits)} | Paid: ${formatCreditsValue(
        creditState.paidCredits
      )}`,
    ];
    if (Number.isFinite(Number(amount)) && Number(amount) > 0) {
      lines.push(`• Monto: ${formatMoneyByCurrency(amount, 'ARS')}`);
    }
    if (paymentId) {
      lines.push(`• Ref: ${String(paymentId).trim()}`);
    }
    lines.push(`• Fuente: ${sourceLabel}`);

    await notifyUser({
      chatId,
      text: lines.join('\n'),
    });
  }

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

      let applied = null;
      if (typeof addCredits === 'function') {
        applied = addCredits(String(payload.telegram_user_id), Number(payload.credits), {
          reason: payload.reason || 'webhook_topup',
          metadata: payload.metadata || null,
        });
      }

      if (applied?.ok) {
        try {
          await notifyTopupApplied({
            userId: String(payload.telegram_user_id),
            credits: Number(payload.credits) || 0,
            amount: Number(payload.amount) || null,
            sourceLabel: payload.reason || 'webhook_topup',
          });
        } catch (error) {
          console.error('[topup] notification failed (webhooks/credits):', error);
        }
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
      const wantsJson = format === 'json';

      if (!String(creditsRequested || '').trim() && !wantsJson) {
        if (!String(userId || '').trim()) {
          sendJson(res, 400, { ok: false, error: 'missing_user_id' });
          return;
        }
        const mpConfig = getMercadoPagoConfig();
        const chooserHtml = buildTopupChooserHtml({
          userId,
          packs: mpConfig?.packs || [],
          currencyId: mpConfig?.currencyId || 'ARS',
        });
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(chooserHtml);
        return;
      }

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

      if (wantsJson) {
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

      if (!creditResult.alreadyProcessed) {
        try {
          await notifyTopupApplied({
            userId: parsed.userId,
            credits: parsed.credits,
            amount: parsed.transactionAmount,
            paymentId: parsed.paymentId,
            sourceLabel: 'mercadopago',
          });
        } catch (error) {
          console.error('[topup] notification failed (mercadopago):', error);
        }
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
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(buildTopupResultHtml(status));
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
  const oddsApi = createOddsApiTool({
    store: {
      getOddsApiCacheEntry,
      upsertOddsApiCacheEntry,
      logOddsApiUsage,
    },
  });

  fightsScalper.configureFightHistoryStore({
    getCacheSnapshot: getFightHistoryCacheSnapshot,
    upsertCacheSnapshot: upsertFightHistoryCacheSnapshot,
  });

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
      previewCompositeBetMutations,
      applyCompositeBetMutations,
      undoLastBetMutation,
      addOddsSnapshot,
      getLatestOddsSnapshot,
      recordUsage: addUsageRecord,
      getCreditState,
      listCreditTransactions,
      spendCredits,
      addCredits,
      getUsageCounters,
      getEventWatchState,
      upsertEventWatchState,
      listLatestRelevantNews,
      getUserIntelPrefs,
      updateUserIntelPrefs,
      listLatestOddsMarketsForFight,
      listLatestOddsMarketsForEvent,
      listUpcomingOddsEvents,
      listRecentOddsEvents,
      getLatestOddsApiQuotaState,
      listLatestProjectionSnapshotsForEvent,
      getLatestBetScoringForFight,
      listLatestBetScoringForEvent,
      refreshLiveScores: async ({ force = true, daysFrom = 3 } = {}) => {
        try {
          const result = await oddsApi.getScores({
            sport: process.env.ODDS_API_MMA_SPORT_KEY || 'mma_mixed_martial_arts',
            daysFrom,
            dateFormat: process.env.ODDS_API_DEFAULT_DATE_FORMAT || 'iso',
            force,
          });
          if (!result?.ok || !Array.isArray(result?.data)) {
            return {
              ok: false,
              error: result?.error || 'scores_sync_failed',
              meta: result?.meta || null,
            };
          }

          const rows = mapOddsEventIndexRows(
            result.data,
            process.env.ODDS_API_MMA_SPORT_KEY || 'mma_mixed_martial_arts'
          );
          const upserted = rows.length
            ? upsertOddsEventsIndex(rows, { markScoresSyncAt: true })
            : { upsertedCount: 0 };
          return {
            ok: true,
            upsertedCount: Number(upserted?.upsertedCount) || 0,
            meta: result?.meta || null,
          };
        } catch (error) {
          return {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      },
      resolveLiveEventContext: async ({ referenceDate } = {}) => {
        const ref = referenceDate instanceof Date ? referenceDate : new Date();
        const refIsoDate = ref.toISOString().slice(0, 10);
        return webIntel.buildWebContextForMessage(
          `quien pelea en la cartelera ufc del ${refIsoDate}?`,
          {
            force: true,
            referenceDate: ref,
          }
        );
      },
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

  const telegram = startTelegramBot(router);

  startAutoSettlementMonitor({
    intervalMs: Number(process.env.AUTO_SETTLEMENT_INTERVAL_MS ?? '180000'),
    getFightHistoryCacheSnapshot,
    listPendingBetsForAutoSettlement,
    applyBetMutation,
    getLatestChatIdForUser,
    notify: async ({ chatId, text }) => {
      if (!telegram?.sendSystemMessage) return;
      await telegram.sendSystemMessage({ chatId, text });
    },
  });

  startEventIntelMonitor({
    buildWebContextForMessage: webIntel.buildWebContextForMessage,
    fetchGoogleNewsRss: webIntel.fetchGoogleNewsRss,
    getEventWatchState,
    upsertEventWatchState,
    insertFighterNewsItems,
  });

  startOddsIntelMonitor({
    oddsApi,
    getLatestOddsApiQuotaState,
    upsertOddsEventsIndex,
    insertOddsMarketSnapshots,
    getEventWatchState,
  });

  startPreFightAnalysisMonitor({
    getEventWatchState,
    listLatestRelevantNews,
    listLatestOddsMarketsForFight,
    getLatestProjectionForFight,
    insertFightProjectionSnapshots,
    insertFightBetScoringSnapshots,
  });

  const port = Number(process.env.PORT || 3000);
  createHealthServer(port, {
    addCredits,
    creditFromMercadoPagoPayment,
    getCreditState,
    getLatestChatIdForUser,
    notifyUser: async ({ chatId, text } = {}) => {
      if (!chatId || !text) return;
      if (!telegram?.sendSystemMessage) return;
      await telegram.sendSystemMessage({ chatId, text });
    },
  });
}

bootstrap();
