import '../../core/env.js';
import { startTelegramBot } from '../../core/telegramBot.js';
import { createRouterChain } from '../../core/routerChain.js';
import * as sheetOps from '../../tools/sheetOpsTool.js';
import * as fightsScalper from '../../tools/fightsScalperTool.js';
import * as ufcStats from '../../tools/ufcStatsTool.js';
import * as webIntel from '../../tools/webIntelTool.js';
import { createOddsApiTool } from '../../tools/oddsApiTool.js';
import { createBettingWizard } from '../../agents/bettingWizard.js';
import { createConversationStore } from '../../core/conversationStore.js';
import { createSessionLogger } from '../../core/sessionLogger.js';
import { startAutoSettlementMonitor } from '../../core/autoSettlement.js';
import { startEventIntelMonitor } from '../../core/eventIntel.js';
import { startOddsIntelMonitor } from '../../core/oddsIntel.js';
import { startPreFightAnalysisMonitor } from '../../core/preFightAnalysis.js';
import {
  getDb,
  getUserProfile,
  updateUserProfile,
  getActiveEventBudgetSession,
  upsertEventBudgetSession,
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
  creditFromMercadoPagoPayment,
  getEventFightMirror,
  getEventFighterMirror,
  upsertEventFightMirror,
  upsertEventFighterMirror,
  clearEventMirror,
  getEventMirrorBuiltAt,
} from '../../core/sqliteStore.js';
import { initEventMirrorService } from '../../core/eventMirrorService.js';
import { startUfcDbReliabilityLoop } from './ufcReliability.js';
import { createBillingApiClient } from '../../platform/billing/billingApiClient.js';
import { createBillingUserStoreBridge } from '../../platform/billing/billingBridge.js';
import { createHealthServer } from '../../platform/runtime/healthServer.js';
import {
  createDisabledTelegramRuntime,
  resolveManifestTelegramToken,
} from '../../platform/runtime/telegramRuntime.js';
import { enforcePolicyPack } from '../../platform/policy/policyGuard.js';
import {
  getMercadoPagoConfig,
  createTopupPreference,
  getPaymentById,
  extractTopupCreditFromPayment,
} from '../../core/mercadoPago.js';

export const manifestPath = 'src/bots/ufc/bot.manifest.json';

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

function formatCreditsValue(value = 0) {
  return (Number(value) || 0).toFixed(2);
}

export async function bootstrapBot({ manifest } = {}) {
  const conversationStore = createConversationStore();
  const sessionLogger = createSessionLogger();
  getDb();
  console.log('[bootstrap][ufc] SQLite DB:', getDbPath());
  startUfcDbReliabilityLoop({
    dbPath: getDbPath(),
  });

  const billingClient = createBillingApiClient({
    botId: manifest?.bot_id || 'ufc',
  });

  const billingBridge = createBillingUserStoreBridge({
    billingClient,
    fallbackUserStore: {
      getCreditState,
      listCreditTransactions,
      spendCredits,
      addCredits,
      getUsageCounters,
    },
  });

  const oddsApi = createOddsApiTool({
    store: {
      getOddsApiCacheEntry,
      upsertOddsApiCacheEntry,
      logOddsApiUsage,
    },
  });

  ufcStats.initUfcStatsTool({ dbPath: process.env.UFC_STATS_DB_PATH });

  if (process.env.UFC_ENABLE_LEGACY_SHEETS === 'true') {
    fightsScalper.configureFightHistoryStore({
      getCacheSnapshot: getFightHistoryCacheSnapshot,
      upsertCacheSnapshot: upsertFightHistoryCacheSnapshot,
    });
    fightsScalper.startFightHistorySync({
      intervalMs: Number(process.env.FIGHT_HISTORY_SYNC_INTERVAL_MS ?? '21600000'),
    });
    console.log('[bootstrap][ufc] Legacy Sheets sync enabled (UFC_ENABLE_LEGACY_SHEETS=true)');
  } else {
    console.log('[bootstrap][ufc] Using ufc_stats.db as fight data source (Sheets sync disabled)');
  }

  initEventMirrorService({
    ufcStats,
    store: {
      getEventWatchState,
      getEventFightMirror,
      upsertEventFightMirror,
      upsertEventFighterMirror,
      clearEventMirror,
    },
    refreshMs: Number(process.env.EVENT_FIGHT_MIRROR_REFRESH_MS ?? '3600000'),
  });

  const bettingWizard = createBettingWizard({
    sheetOps,
    fightsScalper,
    ufcStats,
    webIntel,
    conversationStore,
    userStore: {
      getUserProfile,
      updateUserProfile,
      getActiveEventBudgetSession,
      upsertEventBudgetSession,
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
      getCreditState: (userId, weeklyFreeCredits = 5) => {
        if (billingBridge.isExternalBillingEnabled) {
          return billingBridge.refreshCreditState(userId);
        }
        return getCreditState(userId, weeklyFreeCredits);
      },
      listCreditTransactions: (userId, options = {}) => {
        if (billingBridge.isExternalBillingEnabled) {
          return billingBridge.refreshCreditTransactions(userId, options);
        }
        return listCreditTransactions(userId, options);
      },
      spendCredits: (userId, amount, options = {}) => {
        if (billingBridge.isExternalBillingEnabled) {
          return billingBridge.spendCredits(userId, amount, options);
        }
        return spendCredits(userId, amount, options);
      },
      addCredits: (userId, amount, options = {}) => {
        if (billingBridge.isExternalBillingEnabled) {
          return billingBridge.addCredits(userId, amount, options);
        }
        return addCredits(userId, amount, options);
      },
      getUsageCounters: (params = {}) => {
        if (billingBridge.isExternalBillingEnabled) {
          return billingBridge.refreshUsageCounters(params.userId);
        }
        return getUsageCounters(params);
      },
      getEventWatchState,
      upsertEventWatchState,
      listLatestRelevantNews,
      getUserIntelPrefs,
      updateUserIntelPrefs,
      getEventFightMirror,
      getEventFighterMirror,
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

  const rawRouter = createRouterChain({
    sheetOps,
    fightsScalper,
    bettingWizard,
    conversationStore,
    sessionLogger,
  });

  const router = {
    async routeMessage(input = '') {
      const reply = await rawRouter.routeMessage(input);
      return enforcePolicyPack({
        text: reply,
        policyPackId: manifest?.risk_policy || 'general_safe_advice',
      });
    },
  };

  const { token: telegramToken, tokenEnvName } = resolveManifestTelegramToken(manifest);
  const botId = manifest?.bot_id || 'ufc';
  const telegram = telegramToken
    ? startTelegramBot(router, {
        interactionMode:
          manifest?.interaction_mode || process.env.TELEGRAM_INTERACTION_MODE || 'guided_strict',
        token: telegramToken,
      })
    : createDisabledTelegramRuntime({
        botId,
        tokenEnvName,
      });

  if (!telegramToken) {
    console.warn(
      `[bootstrap][${botId}] Telegram polling disabled: missing env var ${tokenEnvName}.`
    );
  }

  startAutoSettlementMonitor({
    intervalMs: Number(process.env.AUTO_SETTLEMENT_INTERVAL_MS ?? '180000'),
    getFightHistoryRows: ufcStats.getFightHistoryRows,
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
  const legacyTopup = {
    async getConfig() {
      const config = getMercadoPagoConfig();
      return {
        ok: true,
        enabled: Boolean(config?.enabled),
        packs: Array.isArray(config?.packs) ? config.packs : [],
        currency_id: config?.currencyId || 'ARS',
        title: process.env.MP_TOPUP_TITLE || 'Recargar creditos',
      };
    },
    async createCheckout({ userId, packId } = {}) {
      const preference = await createTopupPreference({
        userId,
        creditsRequested: packId || null,
      });
      if (!preference?.ok) {
        return {
          ok: false,
          status: Number(preference?.status) || 400,
          error_code: preference?.error || 'could_not_create_preference',
          packs: preference?.packs || [],
        };
      }
      return {
        ok: true,
        user_id: String(userId || '').trim(),
        credits: Number(preference?.credits) || 0,
        amount: Number(preference?.amount) || 0,
        preference_id: preference?.preference?.id || null,
        redirect_url: preference?.redirectUrl || null,
      };
    },
    async addCredits({ userId, credits, reason = 'manual_topup', metadata = null } = {}) {
      const result = addCredits(String(userId || '').trim(), Number(credits) || 0, {
        reason,
        metadata,
      });
      if (!result?.ok) {
        return {
          ok: false,
          error_code: result?.error || 'could_not_add_credits',
        };
      }
      return {
        ok: true,
        user_id: String(userId || '').trim(),
        credits: Number(credits) || 0,
      };
    },
    async handleMercadoPagoWebhook({ payload = {}, queryParams } = {}) {
      const expectedToken = String(process.env.MP_WEBHOOK_TOKEN || '').trim();
      const incomingToken = String(queryParams?.get('token') || '').trim();
      if (expectedToken && incomingToken !== expectedToken) {
        return {
          status: 403,
          payload: { ok: false, error_code: 'forbidden' },
        };
      }

      const topic = String(
        payload?.type ||
          queryParams?.get('type') ||
          queryParams?.get('topic') ||
          ''
      )
        .toLowerCase()
        .trim();
      const paymentId = String(
        payload?.data?.id ||
          (topic === 'payment' ? payload?.id : '') ||
          queryParams?.get('id') ||
          ''
      ).trim();

      if (topic && topic !== 'payment') {
        return {
          status: 200,
          payload: {
            ok: true,
            ignored: true,
            reason: 'non_payment_topic',
          },
        };
      }

      if (!paymentId) {
        return {
          status: 200,
          payload: {
            ok: true,
            ignored: true,
            reason: 'missing_payment_id',
          },
        };
      }

      const paymentResponse = await getPaymentById(paymentId);
      if (!paymentResponse?.ok) {
        return {
          status: 502,
          payload: {
            ok: false,
            error_code: 'could_not_fetch_payment',
            payment_id: paymentId,
          },
        };
      }

      const parsed = extractTopupCreditFromPayment(paymentResponse?.body || {});
      if (!parsed?.ok) {
        return {
          status: 200,
          payload: {
            ok: true,
            ignored: true,
            reason: parsed?.error || 'missing_credit_metadata',
            payment_id: paymentId,
          },
        };
      }

      if (parsed.status !== 'approved') {
        return {
          status: 200,
          payload: {
            ok: true,
            processed: false,
            payment_id: paymentId,
            payment_status: parsed.status,
          },
        };
      }

      const creditResult = creditFromMercadoPagoPayment({
        paymentId: parsed.paymentId,
        userId: parsed.userId,
        credits: parsed.credits,
        amount: parsed.transactionAmount,
        status: parsed.status,
        rawPayload: paymentResponse?.body || null,
      });

      if (!creditResult?.ok) {
        return {
          status: 500,
          payload: {
            ok: false,
            error_code: creditResult?.error || 'could_not_apply_credit',
            payment_id: parsed.paymentId,
          },
        };
      }

      return {
        status: 200,
        payload: {
          ok: true,
          payment_id: parsed.paymentId,
          user_id: parsed.userId,
          credits: parsed.credits,
          alreadyProcessed: Boolean(creditResult?.alreadyProcessed),
        },
        event: {
          user_id: parsed.userId,
          credits: parsed.credits,
          payment_id: parsed.paymentId,
          amount: parsed.transactionAmount,
        },
      };
    },
  };

  createHealthServer(port, {
    appName: manifest?.display_name || 'UFC Bot',
    botId,
    billingClient,
    legacyTopup,
    onTopupApplied: async (event = {}) => {
      if (!telegram?.sendSystemMessage) return;
      const userId = String(event.user_id || '').trim();
      if (!userId) return;
      const chatId = getLatestChatIdForUser(userId);
      if (!chatId) return;
      const state = billingBridge.isExternalBillingEnabled
        ? await billingBridge.refreshCreditState(userId)
        : getCreditState(userId, Number(process.env.CREDIT_FREE_WEEKLY || '5'));

      const lines = [
        '✅ Recarga acreditada',
        `• +${formatCreditsValue(event.credits)} creditos`,
        `• Saldo actual: ${formatCreditsValue(state?.availableCredits || 0)} creditos`,
      ];
      if (event.payment_id) {
        lines.push(`• Ref: ${event.payment_id}`);
      }

      await telegram.sendSystemMessage({
        chatId,
        text: lines.join('\n'),
      });
    },
  });

  return {
    ok: true,
    botId,
  };
}
