import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import OpenAI from 'openai';
import '../../core/env.js';
import { startTelegramBot } from '../../core/telegramBot.js';
import {
  getCreditState,
  listCreditTransactions,
  spendCredits,
  addCredits,
  getUsageCounters,
  getLatestChatIdForUser,
  upsertUser,
  upsertChat,
} from '../../core/sqliteStore.js';
import { createBillingApiClient } from '../../platform/billing/billingApiClient.js';
import { createBillingUserStoreBridge } from '../../platform/billing/billingBridge.js';
import { createHealthServer } from '../../platform/runtime/healthServer.js';
import { enforcePolicyPack } from '../../platform/policy/policyGuard.js';
import {
  addNutritionIntakes,
  addNutritionUsageRecord,
  addNutritionWeighin,
  appendNutritionJournal,
  calculateProfileStatus,
  ensureNutritionSchema,
  getLatestNutritionWeighin,
  listNutritionIntakesByDate,
  listRecentNutritionIntakes,
  getNutritionProfile,
  getNutritionSummary,
  setNutritionUserState,
  upsertNutritionProfile,
} from './nutritionStore.js';
import { startNutritionDbReliabilityLoop } from './nutritionReliability.js';
import {
  formatMacroLine,
  parseIntakePayload,
  parseProfileUpdatePayload,
  parseWeighinPayload,
  resolveNutritionModuleFromAction,
  resolveTemporalContext,
} from './nutritionDomain.js';

const DEFAULT_MODEL = process.env.BOT_MODEL || process.env.BETTING_MODEL || 'gpt-4.1-mini';
const DEFAULT_TOPUP_PACKS = process.env.MP_TOPUP_PACKS || '';
const APP_PUBLIC_URL = process.env.APP_PUBLIC_URL || '';
const CREDIT_TOPUP_URL = process.env.CREDIT_TOPUP_URL || '';
const CREDIT_ENFORCE = String(process.env.CREDIT_ENFORCE ?? 'true').toLowerCase() !== 'false';
const DEFAULT_USER_TIMEZONE =
  process.env.DEFAULT_USER_TIMEZONE || 'America/Argentina/Buenos_Aires';

function normalizeRouteInput(input = '') {
  if (typeof input === 'string') {
    return {
      message: input,
      metadata: {},
    };
  }

  if (input && typeof input === 'object') {
    return {
      message: String(input.message || ''),
      metadata: input,
    };
  }

  return {
    message: '',
    metadata: {},
  };
}

function resolvePromptPath(manifest = {}, projectRoot = process.cwd()) {
  const configured = String(manifest?.domain_pack?.prompt_file || '').trim();
  if (configured) {
    return path.resolve(projectRoot, configured);
  }
  return path.resolve(projectRoot, 'src', 'bots', 'nutrition', 'prompt.md');
}

function loadPromptFile(manifest = {}) {
  const promptPath = resolvePromptPath(manifest);
  if (!promptPath || !fs.existsSync(promptPath)) {
    return '';
  }
  return fs.readFileSync(promptPath, 'utf8').trim();
}

function parseTopupPacks(raw = '') {
  const packs = [];
  const rows = String(raw || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  for (const row of rows) {
    const [creditsRaw, amountRaw] = row.split(':').map((item) => item.trim());
    const credits = Number(creditsRaw);
    const amount = Number(amountRaw);
    if (!Number.isFinite(credits) || credits <= 0) continue;
    if (!Number.isFinite(amount) || amount <= 0) continue;
    packs.push({ credits, amount });
  }
  return packs.sort((a, b) => a.credits - b.credits);
}

function formatArs(amount = 0) {
  try {
    return new Intl.NumberFormat('es-AR', {
      style: 'currency',
      currency: 'ARS',
      maximumFractionDigits: 0,
    }).format(Number(amount) || 0);
  } catch {
    return `$${Math.round(Number(amount) || 0).toLocaleString('es-AR')}`;
  }
}

function resolveTopupUrl(userId = '') {
  const safeUserId = encodeURIComponent(String(userId || '').trim());
  if (!safeUserId) return '';

  const appBase = String(APP_PUBLIC_URL || '').trim().replace(/\/$/, '');
  if (appBase) {
    return `${appBase}/topup/checkout?user_id=${safeUserId}`;
  }

  const fallback = String(CREDIT_TOPUP_URL || '').trim();
  if (!fallback) return '';

  if (fallback.includes('{user_id}') || fallback.includes('{telegram_user_id}')) {
    return fallback
      .replaceAll('{user_id}', safeUserId)
      .replaceAll('{telegram_user_id}', safeUserId);
  }

  const separator = fallback.includes('?') ? '&' : '?';
  return `${fallback}${separator}user_id=${safeUserId}`;
}

function buildCreditsReply({
  state = {},
  usage = {},
  transactions = [],
  topupUrl = '',
  topupPacks = [],
} = {}) {
  const lines = [
    '💳 Estado de creditos',
    `- Disponibles: ${(Number(state.availableCredits) || 0).toFixed(2)}`,
    `- Free: ${(Number(state.freeCredits) || 0).toFixed(2)}`,
    `- Paid: ${(Number(state.paidCredits) || 0).toFixed(2)}`,
  ];

  if (state.weekId) {
    lines.push(`- Semana free activa: ${state.weekId}`);
  }

  lines.push(
    `- Consumo multimedia: ${Number(usage.imagesToday) || 0} imagen(es) hoy | ${(
      (Number(usage.audioSecondsWeek) || 0) / 60
    ).toFixed(1)} min audio esta semana`
  );

  if (Array.isArray(transactions) && transactions.length) {
    lines.push('', 'Ultimos movimientos:');
    for (const tx of transactions.slice(0, 5)) {
      const amount = Number(tx.amount) || 0;
      const signed = amount > 0 ? `+${amount.toFixed(2)}` : amount.toFixed(2);
      const when = String(tx.createdAt || '').replace('T', ' ').slice(0, 16) || 'sin fecha';
      const type = String(tx.type || 'tx').toUpperCase();
      const reason = tx.reason ? ` (${tx.reason})` : '';
      lines.push(`- ${when}: ${signed} [${type}]${reason}`);
    }
  }

  if (topupPacks.length) {
    lines.push('', 'Packs de recarga:');
    for (const pack of topupPacks) {
      lines.push(`- ${pack.credits} creditos = ${formatArs(pack.amount)}`);
    }
  }

  if (topupUrl) {
    lines.push('', `Link para elegir pack: ${topupUrl}`);
  }

  return lines.join('\n');
}

function extractOutputText(response = {}) {
  if (typeof response?.output_text === 'string' && response.output_text.trim()) {
    return response.output_text.trim();
  }

  const output = Array.isArray(response?.output) ? response.output : [];
  for (const item of output) {
    if (item?.type !== 'message') continue;
    const content = Array.isArray(item.content) ? item.content : [];
    for (const chunk of content) {
      const text = chunk?.text;
      if (typeof text === 'string' && text.trim()) {
        return text.trim();
      }
    }
  }

  return '';
}

function extractUsageSnapshot(response = {}) {
  const usage = response?.usage;
  if (!usage || typeof usage !== 'object') return null;
  const inputTokens = Number(usage.input_tokens ?? usage.prompt_tokens);
  const outputTokens = Number(usage.output_tokens ?? usage.completion_tokens);
  const totalTokens = Number(
    usage.total_tokens ??
      (Number.isFinite(inputTokens) && Number.isFinite(outputTokens)
        ? inputTokens + outputTokens
        : NaN)
  );
  const reasoningTokens = Number(
    usage.reasoning_tokens ?? usage.output_tokens_details?.reasoning_tokens
  );
  const cachedTokens = Number(
    usage.cached_tokens ?? usage.input_tokens_details?.cached_tokens
  );

  const toNonNegativeOrNull = (value) =>
    Number.isFinite(value) && value >= 0 ? Math.round(value) : null;

  return {
    inputTokens: toNonNegativeOrNull(inputTokens),
    outputTokens: toNonNegativeOrNull(outputTokens),
    totalTokens: toNonNegativeOrNull(totalTokens),
    reasoningTokens: toNonNegativeOrNull(reasoningTokens),
    cachedTokens: toNonNegativeOrNull(cachedTokens),
    rawUsage: usage,
  };
}

function toPositiveNumber(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return Number(fallback) || 0;
  return parsed;
}

function roundCost(value = 0) {
  const numeric = Number(value) || 0;
  return Math.round(numeric * 100) / 100;
}

function estimateRequestCost({ manifest = {}, mediaStats = {} } = {}) {
  const costs = manifest?.credit_policy?.costs || {};
  const analysisCost = toPositiveNumber(costs.analysis ?? costs.decision, 0);
  const imageCost = toPositiveNumber(costs.image ?? costs.image_overage, 0);
  const audioMinuteCost = toPositiveNumber(
    costs.audio_minute ?? costs.audio_minute_overage,
    0
  );

  const imageCount = Number(mediaStats?.imageCount) || 0;
  const audioMinutes = (Number(mediaStats?.audioSeconds) || 0) / 60;

  return roundCost(analysisCost + imageCount * imageCost + audioMinutes * audioMinuteCost);
}

function buildSpendIdempotencyKey({ botId = '', userId = '', messageId = '', guidedAction = '' } = {}) {
  const keySeed = [
    String(botId || '').trim(),
    String(userId || '').trim(),
    String(messageId || '').trim(),
    String(guidedAction || '').trim() || 'analysis',
  ].join('|');
  return crypto.createHash('sha256').update(keySeed).digest('hex').slice(0, 40);
}

function formatSummaryReply({
  localDate = '',
  localTime = '',
  summary = {},
  status = 'sin objetivo configurado',
  latestWeighin = null,
} = {}) {
  const lines = [
    `Fecha: ${localDate} | Hora: ${localTime}`,
    '',
    formatMacroLine('📊 Hoy: ', summary.today || {}),
    formatMacroLine('📅 Rolling 7d: ', summary.rolling7d || {}),
    formatMacroLine('🗓️ Rolling 14d: ', summary.rolling14d || {}),
    `🎯 Estado: ${status}`,
  ];

  if (latestWeighin?.weightKg) {
    lines.push(
      `⚖️ Último pesaje: ${Number(latestWeighin.weightKg).toFixed(1)} kg (${latestWeighin.localDate} ${latestWeighin.localTime})`
    );
  }
  return lines.join('\n');
}

function formatProfileReply(profile = {}) {
  const lines = ['✅ Perfil actualizado'];
  lines.push(`- Objetivo: ${profile?.mainGoal || 'sin definir'}`);
  lines.push(
    `- Target kcal: ${
      Number.isFinite(Number(profile?.targetCaloriesKcal))
        ? Math.round(Number(profile.targetCaloriesKcal))
        : 'sin definir'
    }`
  );
  lines.push(
    `- Target proteína: ${
      Number.isFinite(Number(profile?.targetProteinG))
        ? Math.round(Number(profile.targetProteinG))
        : 'sin definir'
    } g`
  );
  lines.push(`- Timezone: ${profile?.timezone || DEFAULT_USER_TIMEZONE}`);
  if (profile?.restrictions) {
    lines.push(`- Restricciones/notas: ${profile.restrictions}`);
  }
  return lines.join('\n');
}

function shouldTrackOutlier(summary = {}) {
  const today = Number(summary?.today?.caloriesKcal) || 0;
  const rolling7 = Number(summary?.rolling7d?.caloriesKcal) || 0;
  const daysWithData = Number(summary?.rolling7d?.daysWithData) || 0;
  if (daysWithData < 3 || rolling7 <= 0) return false;
  return today >= rolling7 * 1.35 || today <= rolling7 * 0.65;
}

function normalizeText(value = '') {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function looksLikeSummaryQuestion(text = '') {
  return /\b(resumen|summary|rolling|promedio|hoy|como vengo|totales|macros|progreso|mis datos)\b/.test(
    text
  );
}

function looksLikeProfileQuestion(text = '') {
  return /\b(perfil|objetivo|target|calorias objetivo|proteina objetivo)\b/.test(text);
}

function looksLikeRecentIntakesQuestion(text = '') {
  return /\b(que comi|que consumi|ingestas|comidas de hoy|historial de comidas|ultimas comidas)\b/.test(
    text
  );
}

function looksLikeWeighinQuestion(text = '') {
  return /\b(ultimo pesaje|ultimo peso|peso actual|cuanto peso|balanza|peso)\b/.test(text);
}

function formatRecentIntakesReply({
  title = '🧾 Ingestas recientes',
  rows = [],
  localDate = '',
} = {}) {
  if (!Array.isArray(rows) || !rows.length) {
    if (localDate) {
      return `🧾 No tengo ingestas registradas para ${localDate}.`;
    }
    return '🧾 Todavía no tengo ingestas registradas.';
  }

  const lines = [title];
  for (const row of rows.slice(0, 8)) {
    const qValue = Number(row?.quantityValue);
    const quantity = Number.isFinite(qValue)
      ? `${qValue}${row?.quantityUnit ? ` ${row.quantityUnit}` : ''}`
      : row?.quantityUnit || 'porcion';
    lines.push(
      `- ${row.localDate} ${row.localTime} | ${row.foodItem} (${quantity}) | ${Math.round(
        Number(row.caloriesKcal) || 0
      )} kcal`
    );
  }
  return lines.join('\n');
}

function resolveDbFirstLearningReply({
  cleanMessage = '',
  userId = '',
  userTimeZone = DEFAULT_USER_TIMEZONE,
  profile = {},
} = {}) {
  const normalized = normalizeText(cleanMessage);
  if (!normalized) return null;

  if (looksLikeSummaryQuestion(normalized)) {
    const temporal = resolveTemporalContext({
      rawMessage: cleanMessage || 'hoy',
      userTimeZone,
    });
    const summary = getNutritionSummary(userId, temporal.localDate);
    const status = calculateProfileStatus(profile, summary.today);
    const latestWeighin = getLatestNutritionWeighin(userId);
    return formatSummaryReply({
      localDate: temporal.localDate,
      localTime: temporal.localTime,
      summary,
      status,
      latestWeighin,
    });
  }

  if (looksLikeProfileQuestion(normalized)) {
    return formatProfileReply(profile || {});
  }

  if (looksLikeRecentIntakesQuestion(normalized)) {
    const temporal = resolveTemporalContext({
      rawMessage: cleanMessage || 'hoy',
      userTimeZone,
    });
    const byDate = listNutritionIntakesByDate(userId, temporal.localDate, { limit: 24 });
    if (byDate.length) {
      return formatRecentIntakesReply({
        title: `🧾 Ingestas ${temporal.localDate}`,
        rows: byDate,
        localDate: temporal.localDate,
      });
    }
    const recent = listRecentNutritionIntakes(userId, { limit: 12 });
    return formatRecentIntakesReply({
      title: '🧾 Últimas ingestas (sin registros para ese día)',
      rows: recent,
    });
  }

  if (looksLikeWeighinQuestion(normalized)) {
    const latestWeighin = getLatestNutritionWeighin(userId);
    if (!latestWeighin) {
      return '⚖️ Todavía no tengo pesajes registrados.';
    }
    return [
      '⚖️ Último pesaje',
      `- Fecha: ${latestWeighin.localDate} ${latestWeighin.localTime}`,
      `- Peso: ${Number(latestWeighin.weightKg).toFixed(1)} kg`,
      latestWeighin.bodyFatPercent ? `- Grasa: ${Number(latestWeighin.bodyFatPercent).toFixed(1)}%` : null,
      latestWeighin.muscleMassKg
        ? `- Masa muscular: ${Number(latestWeighin.muscleMassKg).toFixed(1)} kg`
        : null,
    ]
      .filter(Boolean)
      .join('\n');
  }

  return null;
}

function formatWriteFailureReply(action = '', errorCode = '') {
  const suffix = errorCode ? ` (detalle: ${errorCode})` : '';
  if (action === 'log_intake') {
    return `❌ No pude guardar la ingesta en la DB${suffix}. Reintentá en formato: \`13:30 200g pollo + 150g arroz\`.`;
  }
  if (action === 'log_weighin') {
    return `❌ No pude guardar el pesaje en la DB${suffix}. Reintentá con: \`81.4 kg\`.`;
  }
  if (action === 'update_profile') {
    return `❌ No pude guardar el perfil en la DB${suffix}. Reintentá con campos concretos (objetivo, kcal, proteína, timezone).`;
  }
  return `❌ No pude guardar el registro en la DB${suffix}.`;
}

function formatIdempotencyNotice(idempotencyStatus = '') {
  const normalized = String(idempotencyStatus || '').toLowerCase();
  if (normalized === 'replayed' || normalized === 'replayed_payload_mismatch') {
    return 'ℹ️ Ese mensaje ya estaba procesado; no dupliqué datos.';
  }
  return '';
}

function buildLearningInstructions({ promptSnippet = '' } = {}) {
  return [
    promptSnippet ||
      'Sos un asistente nutricional educativo. Responde breve, claro y accionable.',
    '',
    'Modo: aprendizaje conversacional no clinico.',
    'Reglas:',
    '- No diagnosticar ni prescribir tratamientos medicos.',
    '- No registrar ni mutar ingestas/pesajes/perfil en este modulo.',
    '- Si piden registrar datos, indicar que cambien al modulo operativo correspondiente.',
    '- Mantener respuestas cortas y practicas.',
  ].join('\n');
}

export async function bootstrapNutritionBot({ manifest = {} } = {}) {
  ensureNutritionSchema();

  const botId = String(manifest?.bot_id || process.env.BOT_ID || 'nutrition').trim();
  const displayName = String(manifest?.display_name || botId).trim();
  const policyPackId = String(
    manifest?.risk_policy || process.env.BOT_POLICY_PACK || 'nutrition_guidance_non_clinical'
  );
  const model = process.env.BOT_MODEL || process.env.BETTING_MODEL || DEFAULT_MODEL;
  const promptSnippet = loadPromptFile(manifest);
  const chatIdByUser = new Map();
  const dbPath = String(process.env.DB_PATH || manifest?.storage?.db_path || '').trim();
  const defaultBackupDir = dbPath ? path.join(path.dirname(dbPath), 'backups') : '';
  const nutritionDbReliability = startNutritionDbReliabilityLoop({
    dbPath,
    backupDir: String(process.env.NUTRITION_DB_BACKUP_DIR || defaultBackupDir).trim(),
  });

  const billingClient = createBillingApiClient({ botId });
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

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const router = {
    async routeMessage(input = '') {
      const { message, metadata } = normalizeRouteInput(input);
      const userId = String(metadata?.user?.id || '').trim();
      const chatId = String(metadata?.chat?.id || metadata?.chatId || '').trim();
      const guidedAction = String(metadata?.guidedAction || 'log_intake').trim();
      const sourceMessageId = String(
        metadata?.telegramMessageId || metadata?.message_id || ''
      ).trim();
      const mediaStats = metadata?.mediaStats || {};
      const inputItems = Array.isArray(metadata?.inputItems) ? metadata.inputItems : [];

      if (userId && chatId) {
        chatIdByUser.set(userId, chatId);
      }

      if (userId) {
        upsertUser({
          userId,
          username: metadata?.user?.username || null,
          firstName: metadata?.user?.firstName || null,
          lastName: metadata?.user?.lastName || null,
        });
      }
      if (chatId) {
        upsertChat({
          chatId,
          type: metadata?.chat?.type || 'private',
          title: metadata?.chat?.title || null,
        });
      }

      if (!userId) {
        return 'No pude identificar tu usuario en Telegram. Reintentá desde un chat directo.';
      }

      const moduleState = resolveNutritionModuleFromAction(guidedAction);
      setNutritionUserState(userId, moduleState);

      if (guidedAction === 'view_credits') {
        const [state, usage, transactions] = await Promise.all([
          billingBridge.refreshCreditState(userId),
          billingBridge.refreshUsageCounters(userId),
          billingBridge.refreshCreditTransactions(userId, { limit: 6 }),
        ]);

        return buildCreditsReply({
          state,
          usage,
          transactions,
          topupUrl: resolveTopupUrl(userId),
          topupPacks: parseTopupPacks(DEFAULT_TOPUP_PACKS),
        });
      }

      const cleanMessage = String(message || '').trim();
      const hasMedia = inputItems.length > 0;

      const estimatedCost = estimateRequestCost({
        manifest,
        mediaStats,
      });

      if (CREDIT_ENFORCE && estimatedCost > 0) {
        const state = await billingBridge.refreshCreditState(userId);
        const available = Number(state?.availableCredits) || 0;
        if (available < estimatedCost) {
          const topupUrl = resolveTopupUrl(userId);
          return [
            '💳 Saldo insuficiente para esta consulta.',
            `- Necesario: ${estimatedCost.toFixed(2)} creditos`,
            `- Disponible: ${available.toFixed(2)} creditos`,
            topupUrl ? `- Recarga: ${topupUrl}` : '',
          ]
            .filter(Boolean)
            .join('\n');
        }
      }

      const profile = getNutritionProfile(userId) || {};
      const userTimeZone = String(profile?.timezone || DEFAULT_USER_TIMEZONE).trim();
      let replyText = '';
      let shouldCharge = false;
      let usageSnapshot = null;

      try {

      if (guidedAction === 'update_profile') {
        if (!cleanMessage) {
          return [
            '🧭 Pasame al menos un campo para actualizar tu perfil.',
            'Ejemplo: `objetivo bajar grasa`, `2200 kcal`, `170g proteina`, `timezone America/Argentina/Buenos_Aires`.',
          ].join('\n');
        }

        const parsed = parseProfileUpdatePayload(cleanMessage);
        if (!parsed.ok) {
          return [
            'No detecté campos de perfil para actualizar.',
            'Probá con: `objetivo ...`, `2200 kcal`, `170g proteina`, `timezone ...`, `restricciones: ...`.',
          ].join('\n');
        }

        const updated = upsertNutritionProfile(userId, parsed.updates, {
          idempotency: {
            sourceMessageId,
            operationType: 'update_profile',
          },
        });
        if (!updated?.ok) {
          return formatWriteFailureReply('update_profile', updated?.error || 'db_write_failed');
        }
        const idempotencyNotice = formatIdempotencyNotice(updated.idempotencyStatus);
        replyText = [formatProfileReply(updated.profile || {}), idempotencyNotice]
          .filter(Boolean)
          .join('\n');
        shouldCharge = true;
      } else if (guidedAction === 'view_summary') {
        const temporal = resolveTemporalContext({
          rawMessage: cleanMessage || 'hoy',
          userTimeZone,
        });
        const summary = getNutritionSummary(userId, temporal.localDate);
        const status = calculateProfileStatus(profile, summary.today);
        const latestWeighin = getLatestNutritionWeighin(userId);
        replyText = formatSummaryReply({
          localDate: temporal.localDate,
          localTime: temporal.localTime,
          summary,
          status,
          latestWeighin,
        });
        shouldCharge = true;
      } else if (guidedAction === 'log_weighin') {
        if (hasMedia && !cleanMessage) {
          return [
            '⚖️ En V1 no hago OCR de pesaje.',
            'Mandame texto con el peso: `81.4 kg` (y opcionales si querés).',
          ].join('\n');
        }
        const parsed = parseWeighinPayload({
          rawMessage: cleanMessage,
          userTimeZone,
        });
        if (!parsed.ok) {
          return [
            'No pude detectar el peso en tu mensaje.',
            'Formato mínimo: `81.4 kg`.',
          ].join('\n');
        }

        const weighinWrite = addNutritionWeighin(
          userId,
          {
            ...parsed.weighin,
            loggedAt: parsed.temporal.loggedAt,
            localDate: parsed.temporal.localDate,
            localTime: parsed.temporal.localTime,
            timezone: parsed.temporal.timeZone,
            rawInput: cleanMessage,
          },
          {
            idempotency: {
              sourceMessageId,
              operationType: 'log_weighin',
            },
          }
        );
        if (!weighinWrite?.ok) {
          return formatWriteFailureReply('log_weighin', weighinWrite?.error || 'db_write_failed');
        }

        const idempotencyNotice = formatIdempotencyNotice(weighinWrite.idempotencyStatus);
        replyText = [
          `Fecha: ${parsed.temporal.localDate} | Hora: ${parsed.temporal.localTime}`,
          '✅ Pesaje registrado.',
          `⚖️ Peso: ${Number(parsed.weighin.weightKg).toFixed(1)} kg`,
          idempotencyNotice,
        ]
          .filter(Boolean)
          .join('\n');
        shouldCharge = true;
      } else if (guidedAction === 'learning_chat') {
        const dbFirstReply = resolveDbFirstLearningReply({
          cleanMessage,
          userId,
          userTimeZone,
          profile,
        });
        if (dbFirstReply) {
          replyText = dbFirstReply;
          shouldCharge = true;
        } else {
          const runtimePrompt = buildLearningInstructions({ promptSnippet });
          if (!cleanMessage && !hasMedia) {
            return 'Decime qué querés aprender (ejemplo: distribución de macros, timing de proteína, etc.).';
          }

          const userInput = hasMedia
            ? [
                {
                  role: 'user',
                  content: [
                    {
                      type: 'input_text',
                      text: cleanMessage || 'Consulta nutricional en modo aprendizaje.',
                    },
                    ...inputItems,
                  ],
                },
              ]
            : cleanMessage;

          const response = await openai.responses.create({
            model,
            instructions: runtimePrompt,
            input: userInput,
          });
          usageSnapshot = extractUsageSnapshot(response);
          if (usageSnapshot) {
            addNutritionUsageRecord(userId, {
              guidedAction,
              model,
              inputTokens: usageSnapshot.inputTokens,
              outputTokens: usageSnapshot.outputTokens,
              totalTokens: usageSnapshot.totalTokens,
              reasoningTokens: usageSnapshot.reasoningTokens,
              cachedTokens: usageSnapshot.cachedTokens,
              rawUsage: usageSnapshot.rawUsage,
            });
          }
          const rawReply =
            extractOutputText(response) ||
            'No pude generar una respuesta útil en este turno. Reintentá con más contexto.';
          replyText = enforcePolicyPack({
            text: rawReply,
            policyPackId,
          });
          shouldCharge = true;
        }
      } else {
        if (hasMedia && !cleanMessage) {
          return [
            '🍽 En V1 no hago OCR de alimentos.',
            'Mandame texto simple: `hora + lo ingerido`.',
            'Ejemplo: `13:40 200g pollo + 150g arroz`.',
          ].join('\n');
        }

        const parsed = parseIntakePayload({
          rawMessage: cleanMessage,
          userTimeZone,
        });

        if (!parsed.ok) {
          if (parsed.error === 'partial_resolution' && parsed.unresolvedItems?.length) {
            return [
              'Necesito aclarar algunos items antes de registrar.',
              `No pude interpretar: ${parsed.unresolvedItems.join(', ')}`,
              'Mandalo en formato simple por item: `hora alimento cantidad`.',
            ].join('\n');
          }
          return [
            'No pude detectar una ingesta registrable.',
            'Formato recomendado: `13:30 200g pollo + 150g arroz`.',
          ].join('\n');
        }

        const intakeWrite = addNutritionIntakes(
          userId,
          {
            loggedAt: parsed.temporal.loggedAt,
            localDate: parsed.temporal.localDate,
            localTime: parsed.temporal.localTime,
            timezone: parsed.temporal.timeZone,
            rawInput: cleanMessage,
            items: parsed.items,
          },
          {
            idempotency: {
              sourceMessageId,
              operationType: 'log_intake',
            },
          }
        );
        if (!intakeWrite?.ok) {
          return formatWriteFailureReply('log_intake', intakeWrite?.error || 'db_write_failed');
        }

        const summary = getNutritionSummary(userId, parsed.temporal.localDate);
        const status = calculateProfileStatus(profile, summary.today);
        if (shouldTrackOutlier(summary)) {
          appendNutritionJournal(userId, {
            localDate: parsed.temporal.localDate,
            localTime: parsed.temporal.localTime,
            event: 'calorie_outlier',
            notes: `Hoy ${Math.round(summary.today.caloriesKcal)} kcal vs rolling7 ${Math.round(
              summary.rolling7d.caloriesKcal
            )} kcal`,
          });
        }

        replyText = [
          `Fecha: ${parsed.temporal.localDate} | Hora: ${parsed.temporal.localTime}`,
          'OK, quedó anotado.',
          formatMacroLine('📊 Hoy: ', summary.today),
          formatMacroLine('📅 Rolling 7d: ', summary.rolling7d),
          formatMacroLine('🗓️ Rolling 14d: ', summary.rolling14d),
          `🎯 Estado: ${status}`,
          formatIdempotencyNotice(intakeWrite.idempotencyStatus),
        ]
          .filter(Boolean)
          .join('\n');
        shouldCharge = true;
      }

      if (CREDIT_ENFORCE && estimatedCost > 0 && shouldCharge) {
        const idempotencyKey = buildSpendIdempotencyKey({
          botId,
          userId,
          messageId: metadata?.telegramMessageId || metadata?.message_id || crypto.randomUUID(),
          guidedAction,
        });

        await billingBridge.spendCredits(userId, estimatedCost, {
          reason: 'analysis',
          idempotencyKey,
          metadata: {
            guidedAction,
            model,
            mediaStats,
            tokenUsage: usageSnapshot
              ? {
                  inputTokens: usageSnapshot.inputTokens,
                  outputTokens: usageSnapshot.outputTokens,
                  totalTokens: usageSnapshot.totalTokens,
                  reasoningTokens: usageSnapshot.reasoningTokens,
                  cachedTokens: usageSnapshot.cachedTokens,
                }
              : null,
          },
        });
      }

      return replyText || 'No pude completar la acción solicitada.';
      } catch (error) {
        console.error('[nutrition-runtime] routeMessage failed', {
          guidedAction,
          userId,
          sourceMessageId,
          error: error?.message || String(error),
        });
        return formatWriteFailureReply(guidedAction, 'unexpected_error');
      }
    },
  };

  const telegram = startTelegramBot(router, {
    interactionMode:
      manifest?.interaction_mode || process.env.TELEGRAM_INTERACTION_MODE || 'guided_strict',
    guidedMenuId: manifest?.domain_pack?.guided_menu || 'nutrition_v1',
    guidedLedgerEnabled: false,
    token:
      process.env[String(manifest?.telegram_token_env || 'TELEGRAM_BOT_TOKEN')] ||
      process.env.TELEGRAM_BOT_TOKEN,
  });

  createHealthServer(Number(process.env.PORT || '3000'), {
    appName: displayName,
    botId,
    billingClient,
    onTopupApplied: async (event = {}) => {
      if (!telegram?.sendSystemMessage) return;
      const userId = String(event.user_id || '').trim();
      if (!userId) return;

      const chatId =
        chatIdByUser.get(userId) ||
        String(getLatestChatIdForUser(userId) || '').trim();
      if (!chatId) return;

      const state = await billingBridge.refreshCreditState(userId);
      const lines = [
        '✅ Recarga acreditada',
        `- +${(Number(event.credits) || 0).toFixed(2)} creditos`,
        `- Saldo actual: ${(Number(state?.availableCredits) || 0).toFixed(2)} creditos`,
      ];
      await telegram.sendSystemMessage({
        chatId,
        text: lines.join('\n'),
      });
    },
  });

  return {
    ok: true,
    botId,
    stopReliabilityLoop: () => nutritionDbReliability?.stop?.(),
  };
}
