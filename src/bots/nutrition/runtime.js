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
  findFoodCatalogCandidates,
  getFoodCatalogPreview,
  getLatestNutritionWeighin,
  listFoodCatalogEntries,
  listNutritionUserProductDefaults,
  listNutritionIntakesByDate,
  listRecentNutritionIntakes,
  findNutritionUserPreferredCatalogEntries,
  setNutritionUserProductDefault,
  removeNutritionUserProductDefault,
  bumpNutritionUserProductDefaultUsage,
  getNutritionProfile,
  getNutritionSummary,
  setNutritionUserState,
  upsertFoodCatalogEntry,
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
const DEFAULT_SMART_MODELS = 'gpt-5.4,gpt-5.2,gpt-4.1-mini';
const DEFAULT_TOPUP_PACKS = process.env.MP_TOPUP_PACKS || '';
const APP_PUBLIC_URL = process.env.APP_PUBLIC_URL || '';
const CREDIT_TOPUP_URL = process.env.CREDIT_TOPUP_URL || '';
const CREDIT_ENFORCE = String(process.env.CREDIT_ENFORCE ?? 'true').toLowerCase() !== 'false';
const DEFAULT_USER_TIMEZONE =
  process.env.DEFAULT_USER_TIMEZONE || 'America/Argentina/Buenos_Aires';
const IMAGE_INTAKE_DRAFT_TTL_MS = 20 * 60 * 1000;

function parseModelCandidates(raw = '') {
  return String(raw || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function isUnavailableModelError(error) {
  const status = Number(error?.status || error?.response?.status || 0);
  if (status === 404 || status === 400) {
    const message = String(error?.message || '').toLowerCase();
    if (
      message.includes('model') &&
      (message.includes('not found') ||
        message.includes('does not exist') ||
        message.includes('unsupported') ||
        message.includes('not available'))
    ) {
      return true;
    }
  }
  return false;
}

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

function mergeUsageSnapshots(current = null, next = null) {
  if (!next) return current;
  if (!current) return next;
  const sum = (a, b) => {
    const x = Number(a);
    const y = Number(b);
    const hasX = Number.isFinite(x);
    const hasY = Number.isFinite(y);
    if (!hasX && !hasY) return null;
    return (hasX ? x : 0) + (hasY ? y : 0);
  };
  return {
    inputTokens: sum(current.inputTokens, next.inputTokens),
    outputTokens: sum(current.outputTokens, next.outputTokens),
    totalTokens: sum(current.totalTokens, next.totalTokens),
    reasoningTokens: sum(current.reasoningTokens, next.reasoningTokens),
    cachedTokens: sum(current.cachedTokens, next.cachedTokens),
    rawUsage: {
      merged: true,
      parts: [current.rawUsage || null, next.rawUsage || null].filter(Boolean),
    },
  };
}

function stripCodeFence(text = '') {
  const raw = String(text || '').trim();
  if (!raw.startsWith('```')) return raw;
  return raw
    .replace(/^```[a-zA-Z0-9_-]*\s*/u, '')
    .replace(/```$/u, '')
    .trim();
}

function extractJsonObject(text = '') {
  const raw = stripCodeFence(String(text || ''));
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {
    // noop
  }

  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const candidate = raw.slice(start, end + 1);
    try {
      return JSON.parse(candidate);
    } catch {
      return null;
    }
  }
  return null;
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
  todayIntakes = [],
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

  lines.push('', ...buildIntakeDetailsBlock({
    title: '🧾 Ingestas de hoy',
    rows: todayIntakes,
    includeTime: true,
    chronological: true,
    emptyLine: '- (sin ingestas registradas hoy)',
  }));

  return lines.join('\n');
}

function formatNumberCompact(value = 0, { decimals = 2 } = {}) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '0';
  return numeric.toFixed(decimals).replace(/\.?0+$/u, '');
}

function formatQuantityText(value = null, unit = '') {
  const q = Number(value);
  const normalizedUnit = String(unit || '').trim();
  if (Number.isFinite(q)) {
    return `${formatNumberCompact(q)}${normalizedUnit ? ` ${normalizedUnit}` : ''}`;
  }
  return normalizedUnit || 'porcion';
}

function normalizeConfidenceLabel(value = '', fallback = 'media') {
  const normalized = normalizeText(value);
  if (normalized === 'alta' || normalized === 'media' || normalized === 'baja') {
    return normalized;
  }
  if (normalized === 'high') return 'alta';
  if (normalized === 'medium') return 'media';
  if (normalized === 'low') return 'baja';
  return fallback;
}

function formatIntakeDetailLine(row = {}, { includeTime = false, includeConfidence = false } = {}) {
  const food = String(row?.foodItem || '').trim() || 'item';
  const quantity = formatQuantityText(row?.quantityValue, row?.quantityUnit);
  const kcal = formatNumberCompact(row?.caloriesKcal);
  const protein = formatNumberCompact(row?.proteinG);
  const carbs = formatNumberCompact(row?.carbsG);
  const fat = formatNumberCompact(row?.fatG);
  const confidence = normalizeConfidenceLabel(row?.confidence, 'media');
  const prefix = includeTime && row?.localTime ? `${row.localTime} | ` : '';
  const confidenceSuffix = includeConfidence ? ` | Conf: ${confidence}` : '';
  return `- ${prefix}${food} (${quantity}) | ${kcal} kcal | P ${protein} g | C ${carbs} g | G ${fat} g${confidenceSuffix}`;
}

function buildIntakeDetailsBlock({
  title = '🧾 Detalle registrado',
  rows = [],
  includeTime = false,
  includeConfidence = false,
  chronological = false,
  emptyLine = '- (sin datos)',
} = {}) {
  if (!Array.isArray(rows) || !rows.length) {
    return [title, emptyLine];
  }

  const ordered = chronological ? [...rows].reverse() : rows;
  return [
    title,
    ...ordered.map((row) => formatIntakeDetailLine(row, { includeTime, includeConfidence })),
  ];
}

function parseProfileProductPreferenceCommand(message = '') {
  const raw = String(message || '').trim();
  const normalized = normalizeText(raw);
  if (!normalized) return null;

  if (
    /\b(listar|lista|ver|mostrar)\b.*\b(productos|preferencias|fijos|defaults)\b/.test(normalized) ||
    /\b(mis productos|productos fijos)\b/.test(normalized)
  ) {
    return { action: 'list_defaults' };
  }

  const removeMatch = raw.match(
    /\b(?:quitar|eliminar|borrar)\s+(?:producto|preferencia|default)\s+(.+)$/i
  );
  if (removeMatch) {
    return {
      action: 'remove_default',
      alias: sanitizeUserAliasCandidate(removeMatch[1]),
    };
  }

  const removeNaturalMatch = raw.match(/\b(?:quitar|eliminar|borrar)\s+mi\s+(.+)$/i);
  if (removeNaturalMatch) {
    const aliasCandidate = sanitizeUserAliasCandidate(removeNaturalMatch[1]);
    if (looksLikePackagedAlias(aliasCandidate)) {
      return {
        action: 'remove_default',
        alias: aliasCandidate,
      };
    }
  }

  const setMatch = raw.match(
    /\b(?:producto|preferencia|default|alias)\s+(.+?)\s*(?:=|=>|->)\s*(.+)$/i
  );
  if (setMatch) {
    return {
      action: 'set_default',
      alias: sanitizeUserAliasCandidate(setMatch[1]),
      productQuery: String(setMatch[2] || '').trim(),
    };
  }

  const naturalSetMatch = raw.match(/\b(?:mi|m[ií])\s+(.+?)\s+(?:es|=)\s+(.+)$/i);
  if (naturalSetMatch) {
    const aliasCandidate = sanitizeUserAliasCandidate(naturalSetMatch[1]);
    if (looksLikePackagedAlias(aliasCandidate)) {
      return {
        action: 'set_default',
        alias: aliasCandidate,
        productQuery: String(naturalSetMatch[2] || '').trim(),
      };
    }
  }

  return null;
}

function resolveCatalogEntryForProfilePreference(query = '') {
  const text = String(query || '').trim();
  if (!text) {
    return { status: 'missing_query' };
  }
  const idMatch = text.match(/(?:^#|(?:\bid\b\s*[:=]?\s*))(\d+)/i);
  const allRows = listFoodCatalogEntries();
  if (idMatch) {
    const id = Number(idMatch[1]);
    const byId = allRows.find((row) => Number(row?.id) === id) || null;
    return byId ? { status: 'matched', entry: byId } : { status: 'not_found' };
  }

  const merged = mergeCatalogRows(
    findFoodCatalogCandidates(text, { limit: 50 }),
    allRows.slice(0, 200)
  );
  const scored = merged
    .map((row) => ({
      row,
      score: scoreCatalogCandidate(row, text),
    }))
    .sort((a, b) => b.score - a.score);
  if (!scored.length || scored[0].score < 20) {
    return { status: 'not_found' };
  }

  const best = scored[0];
  const alternatives = scored
    .slice(0, 5)
    .filter((item) => item.score >= Math.max(20, best.score - 12))
    .map((item) => item.row);
  if (alternatives.length > 1) {
    return {
      status: 'ambiguous',
      best: best.row,
      alternatives,
    };
  }
  return { status: 'matched', entry: best.row };
}

function formatCatalogAlternatives(rows = []) {
  if (!Array.isArray(rows) || !rows.length) return '';
  return rows
    .slice(0, 5)
    .map((row) => {
      const id = Number(row?.id);
      const name = String(row?.productName || '').trim();
      const brand = String(row?.brand || '').trim();
      return `- #${Number.isFinite(id) ? id : '?'} ${name}${brand ? ` (${brand})` : ''}`;
    })
    .join('\n');
}

function formatUserProductDefaultsReply(rows = []) {
  if (!Array.isArray(rows) || !rows.length) {
    return [
      '🧴 Productos fijos por usuario',
      '- Aún no configuraste ninguno.',
      'Ejemplo para guardar: `producto leche proteica = Leche Proteica La Serenisima`',
    ].join('\n');
  }

  const lines = ['🧴 Productos fijos por usuario'];
  for (const row of rows.slice(0, 12)) {
    const id = Number(row?.catalogItemId || row?.id);
    const alias = String(row?.aliasLabel || '').trim() || '(sin alias)';
    const name = String(row?.productName || '').trim() || 'producto';
    const brand = String(row?.brand || '').trim();
    lines.push(
      `- ${alias} => #${Number.isFinite(id) ? id : '?'} ${name}${brand ? ` (${brand})` : ''}`
    );
  }
  lines.push('Para cambiar uno: `producto <alias> = <producto>`');
  lines.push('Para quitar uno: `quitar producto <alias>`');
  return lines.join('\n');
}

function mapDefaultRowsToPreferredCatalogRows(rows = []) {
  if (!Array.isArray(rows) || !rows.length) return [];
  const mapped = [];
  for (const row of rows) {
    const catalogId = Number(row?.catalogItemId);
    if (!Number.isFinite(catalogId) || catalogId <= 0) continue;
    mapped.push({
      id: catalogId,
      productName: String(row?.productName || '').trim(),
      brand: String(row?.brand || '').trim(),
      normalizedName: normalizeCatalogToken(row?.productName || row?.normalizedName || ''),
      normalizedBrand: normalizeCatalogToken(row?.brand || row?.normalizedBrand || ''),
      portionG: Number(row?.portionG),
      caloriesKcal: Number(row?.caloriesKcal),
      proteinG: Number(row?.proteinG),
      carbsG: Number(row?.carbsG),
      fatG: Number(row?.fatG),
      source: String(row?.source || 'base_estandar').trim() || 'base_estandar',
      preferenceAlias: String(row?.aliasLabel || '').trim(),
      preferenceUsageCount: Number(row?.usageCount || 0),
    });
  }
  return mapped;
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

function looksLikeLabelIntent(text = '') {
  return /\b(etiqueta|tabla nutricional|info nutricional|rotulo|r[oó]tulo)\b/.test(
    normalizeText(text)
  );
}

function formatCatalogCandidatesPreview(rows = []) {
  if (!Array.isArray(rows) || !rows.length) return '(sin candidatos)';
  return rows
    .slice(0, 40)
    .map((row) => {
      const name = String(row?.productName || '').trim();
      const brand = String(row?.brand || '').trim();
      return `- ${name}${brand ? ` | ${brand}` : ''}`;
    })
    .filter(Boolean)
    .join('\n');
}

async function createSmartResponse({
  openai,
  modelCandidates = [],
  instructions = '',
  input,
} = {}) {
  let lastError = null;
  for (const candidate of modelCandidates) {
    try {
      const response = await openai.responses.create({
        model: candidate,
        instructions,
        input,
      });
      return { ok: true, response, model: candidate };
    } catch (error) {
      lastError = error;
      if (isUnavailableModelError(error)) {
        continue;
      }
      throw error;
    }
  }
  if (lastError) {
    throw lastError;
  }
  throw new Error('No smart model candidates configured');
}

async function normalizeIntakeWithModel({
  openai,
  modelCandidates = [],
  rawMessage = '',
  userTimeZone = DEFAULT_USER_TIMEZONE,
  catalogCandidates = [],
} = {}) {
  const instructions = [
    'Sos un normalizador de ingestas para un bot de nutricion.',
    'Objetivo: convertir el mensaje del usuario a un texto simple parseable o pedir aclaracion puntual.',
    'Salida obligatoria: JSON puro sin markdown.',
    'Schema:',
    '{',
    '  "action":"normalize_intake|ask_label_photo|ask_clarification|reject",',
    '  "normalized_text":"string",',
    '  "clarification_question":"string",',
    '  "should_request_label_photo":true|false,',
    '  "packaged_product":{"product_name":"string","brand":"string"}',
    '}',
    'Reglas:',
    '- Si el mensaje describe una ingesta logueable, usar action=normalize_intake.',
    '- En normalized_text, usa formato breve: "HH:MM cantidad unidad alimento + ...".',
    '- Si no hay hora/fecha, no inventes; deja la frase sin fecha/hora.',
    '- Si parece producto de paquete/marca no claro para macros exactos, usa should_request_label_photo=true.',
    '- Si claramente falta un dato critico, usa ask_clarification con una sola pregunta.',
    '- Si no es ingesta, usa reject.',
  ].join('\n');

  const inputText = [
    `Timezone usuario: ${userTimeZone}`,
    '',
    'Mensaje usuario:',
    rawMessage,
    '',
    'Catalogo candidatos (usar nombre exacto si aplica):',
    formatCatalogCandidatesPreview(catalogCandidates),
  ].join('\n');

  const smart = await createSmartResponse({
    openai,
    modelCandidates,
    instructions,
    input: [
      {
        role: 'user',
        content: [{ type: 'input_text', text: inputText }],
      },
    ],
  });
  const outputText = extractOutputText(smart.response);
  const json = extractJsonObject(outputText) || {};
  return {
    ok: true,
    model: smart.model,
    usage: extractUsageSnapshot(smart.response),
    action: String(json.action || '').trim() || 'reject',
    normalizedText: String(json.normalized_text || '').trim(),
    clarificationQuestion: String(json.clarification_question || '').trim(),
    shouldRequestLabelPhoto: Boolean(json.should_request_label_photo),
    packagedProduct: {
      productName: String(json?.packaged_product?.product_name || '').trim(),
      brand: String(json?.packaged_product?.brand || '').trim(),
    },
  };
}

function normalizeCatalogToken(value = '') {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

function scoreCatalogCandidate(entry = {}, nameHint = '', brandHint = '') {
  const normalizedNameHint = normalizeCatalogToken(nameHint);
  if (!normalizedNameHint) return 0;

  const entryName = normalizeCatalogToken(entry?.productName || entry?.normalizedName || '');
  if (!entryName) return 0;

  let score = 0;
  if (entryName === normalizedNameHint) {
    score += 100;
  } else if (normalizedNameHint.includes(entryName)) {
    score += 80;
  } else if (entryName.includes(normalizedNameHint)) {
    score += 60;
  }

  const hintTokens = normalizedNameHint.split(' ').filter(Boolean);
  const entryTokens = new Set(entryName.split(' ').filter(Boolean));
  const overlap = hintTokens.filter((token) => entryTokens.has(token)).length;
  score += overlap * 10;

  const normalizedBrandHint = normalizeCatalogToken(brandHint);
  const entryBrand = normalizeCatalogToken(entry?.brand || entry?.normalizedBrand || '');
  if (normalizedBrandHint && entryBrand) {
    if (entryBrand === normalizedBrandHint) {
      score += 20;
    } else if (entryBrand.includes(normalizedBrandHint) || normalizedBrandHint.includes(entryBrand)) {
      score += 10;
    }
  }

  const preferenceAlias = normalizeCatalogToken(entry?.preferenceAlias || entry?.aliasLabel || '');
  if (preferenceAlias) {
    if (preferenceAlias === normalizedNameHint) {
      score += 45;
    } else if (normalizedNameHint.includes(preferenceAlias) || preferenceAlias.includes(normalizedNameHint)) {
      score += 25;
    }
    const usageCount = Number(entry?.preferenceUsageCount ?? entry?.usageCount);
    if (Number.isFinite(usageCount) && usageCount > 0) {
      score += Math.min(20, usageCount);
    }
  }

  return score;
}

function mergeCatalogRows(primary = [], fallback = []) {
  const merged = [];
  const seen = new Set();
  for (const row of [...primary, ...fallback]) {
    if (!row || !Number.isFinite(Number(row.id))) continue;
    const id = Number(row.id);
    if (seen.has(id)) continue;
    seen.add(id);
    merged.push(row);
  }
  return merged;
}

function formatCatalogRowsForStructuredParser(rows = []) {
  if (!Array.isArray(rows) || !rows.length) return '(sin filas de catalogo)';
  return rows
    .slice(0, 180)
    .map((row) => {
      const id = Number(row?.id);
      const name = String(row?.productName || '').trim();
      const brand = String(row?.brand || '').trim();
      const portionG = Number(row?.portionG);
      const caloriesKcal = Number(row?.caloriesKcal);
      const proteinG = Number(row?.proteinG);
      const carbsG = Number(row?.carbsG);
      const fatG = Number(row?.fatG);
      return [
        `id=${Number.isFinite(id) ? id : '?'}`,
        `name=${name || '-'}`,
        `brand=${brand || '-'}`,
        `portion_g=${Number.isFinite(portionG) ? portionG : '-'}`,
        `kcal=${Number.isFinite(caloriesKcal) ? caloriesKcal : '-'}`,
        `p=${Number.isFinite(proteinG) ? proteinG : '-'}`,
        `c=${Number.isFinite(carbsG) ? carbsG : '-'}`,
        `g=${Number.isFinite(fatG) ? fatG : '-'}`,
      ].join(' | ');
    })
    .join('\n');
}

function formatUserDefaultsForStructuredParser(rows = []) {
  if (!Array.isArray(rows) || !rows.length) return '(sin productos fijos por usuario)';
  return rows
    .slice(0, 80)
    .map((row) => {
      const alias = String(row?.aliasLabel || '').trim();
      const id = Number(row?.catalogItemId || row?.id);
      const name = String(row?.productName || '').trim();
      const brand = String(row?.brand || '').trim();
      const usageCount = Number(row?.usageCount || row?.preferenceUsageCount || 0);
      return [
        `alias=${alias || '-'}`,
        `catalog_id=${Number.isFinite(id) ? id : '?'}`,
        `name=${name || '-'}`,
        `brand=${brand || '-'}`,
        `usage=${Number.isFinite(usageCount) ? usageCount : 0}`,
      ].join(' | ');
    })
    .join('\n');
}

function looksLikePackagedAlias(value = '') {
  const text = normalizeCatalogToken(value);
  if (!text) return false;
  return /\b(granola|whey|prote|protein|proteico|leche|yogur|yogurt|ser pro|pro\+|barrita|barra|galleta|cookie|cereal|polvo|suplemento)\b/.test(
    text
  );
}

function sanitizeUserAliasCandidate(value = '') {
  const cleaned = String(value || '')
    .replace(/[`"'“”]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.,;:!?]+$/g, '');
  if (!cleaned) return '';
  if (cleaned.length > 80) return '';
  if (cleaned.split(' ').length > 12) return '';
  return cleaned;
}

function isValidIsoDate(value = '') {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '').trim());
}

function isValidHourMinute(value = '') {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || '').trim());
}

function toPositiveFiniteOrNull(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function parseFlexibleNumber(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  const text = String(value || '').trim().toLowerCase();
  if (!text) return null;

  const normalized = text.replace(',', '.');
  const direct = Number(normalized);
  if (Number.isFinite(direct)) return direct;

  const fraction = normalized.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (fraction) {
    const numerator = Number(fraction[1]);
    const denominator = Number(fraction[2]);
    if (Number.isFinite(numerator) && Number.isFinite(denominator) && denominator !== 0) {
      return numerator / denominator;
    }
  }

  if (normalized === 'media' || normalized === 'medio') return 0.5;
  if (normalized === 'un cuarto' || normalized === 'cuarto') return 0.25;
  if (normalized === 'tres cuartos') return 0.75;

  return null;
}

function roundMacro(value = 0) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function computeQuantityFactor(quantityValue = null, quantityUnit = '', portionG = 100) {
  const q = Number(quantityValue);
  if (!Number.isFinite(q) || q <= 0) return 1;

  const unit = normalizeCatalogToken(quantityUnit);
  const p = Number(portionG) || 100;

  if (unit === 'kg' || unit === 'kilo' || unit === 'kilos') return (q * 1000) / p;
  if (unit === 'g' || unit === 'gr' || unit === 'gramo' || unit === 'gramos') return q / p;
  if (unit === 'l' || unit === 'litro' || unit === 'litros') return (q * 1000) / p;
  if (unit === 'ml' || unit === 'cc') return q / p;
  return q;
}

function buildPhotoHintLine() {
  return '📷 Si hay duda, mandame foto del plato/ticket o etiqueta nutricional y lo ajusto con más precisión.';
}

function parseStructuredEstimatedTotals(item = {}) {
  const caloriesKcal = Number(item?.estimatedTotals?.caloriesKcal);
  const proteinG = Number(item?.estimatedTotals?.proteinG);
  const carbsG = Number(item?.estimatedTotals?.carbsG);
  const fatG = Number(item?.estimatedTotals?.fatG);
  const isValid =
    Number.isFinite(caloriesKcal) &&
    caloriesKcal >= 0 &&
    Number.isFinite(proteinG) &&
    proteinG >= 0 &&
    Number.isFinite(carbsG) &&
    carbsG >= 0 &&
    Number.isFinite(fatG) &&
    fatG >= 0;
  if (!isValid) return null;
  return {
    caloriesKcal: roundMacro(caloriesKcal),
    proteinG: roundMacro(proteinG),
    carbsG: roundMacro(carbsG),
    fatG: roundMacro(fatG),
  };
}

function resolveCatalogEntryFromStructuredItem(
  item = {},
  catalogRows = [],
  { userId = '', userDefaultRows = [] } = {}
) {
  const numericId = Number(item?.catalogId);
  if (Number.isFinite(numericId) && numericId > 0) {
    const byId = catalogRows.find((row) => Number(row?.id) === numericId);
    if (byId) {
      return { entry: byId, matchedPreferenceAlias: null };
    }
  }

  const hint = String(item?.foodName || '').trim();
  if (!hint) return { entry: null, matchedPreferenceAlias: null };

  const preferredRows = Array.isArray(userDefaultRows) && userDefaultRows.length
    ? userDefaultRows
    : findNutritionUserPreferredCatalogEntries(userId, hint, { limit: 40 });
  const candidates = mergeCatalogRows(
    preferredRows,
    mergeCatalogRows(findFoodCatalogCandidates(hint, { limit: 60 }), catalogRows)
  );
  let best = null;
  let bestScore = 0;
  for (const candidate of candidates) {
    const score = scoreCatalogCandidate(candidate, hint, item?.brand || '');
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  if (!best || bestScore < 20) return { entry: null, matchedPreferenceAlias: null };
  return {
    entry: best,
    matchedPreferenceAlias: String(best?.preferenceAlias || best?.aliasLabel || '').trim() || null,
  };
}

function resolveTemporalFromStructured({
  rawMessage = '',
  userTimeZone = DEFAULT_USER_TIMEZONE,
  temporal = {},
} = {}) {
  const baseline = resolveTemporalContext({
    rawMessage,
    userTimeZone,
  });
  const localDate = isValidIsoDate(temporal?.localDate)
    ? String(temporal.localDate).trim()
    : baseline.localDate;
  const localTime = isValidHourMinute(temporal?.localTime)
    ? String(temporal.localTime).trim()
    : baseline.localTime;

  const explicitTemporal = resolveTemporalContext({
    rawMessage: `${localDate} ${localTime}`,
    userTimeZone,
  });
  return {
    ...explicitTemporal,
    localDate,
    localTime,
    timeZone: explicitTemporal.timeZone || baseline.timeZone,
  };
}

function buildParsedIntakeFromStructured({
  userId = '',
  rawMessage = '',
  userTimeZone = DEFAULT_USER_TIMEZONE,
  structured = {},
  catalogRows = [],
  userDefaultRows = [],
  inferenceSource = 'text',
} = {}) {
  const temporal = resolveTemporalFromStructured({
    rawMessage,
    userTimeZone,
    temporal: structured.temporal || {},
  });
  const normalizedItems = Array.isArray(structured?.items) ? structured.items : [];
  if (!normalizedItems.length) {
    return {
      ok: false,
      error: 'missing_intake_items',
      temporal,
      items: [],
      unresolvedItems: [],
    };
  }

  const items = [];
  const unresolvedItems = [];
  for (const structuredItem of normalizedItems) {
    const resolved = resolveCatalogEntryFromStructuredItem(
      structuredItem,
      catalogRows,
      { userId, userDefaultRows }
    );
    const entry = resolved?.entry || null;
    const estimatedTotals = parseStructuredEstimatedTotals(structuredItem);
    if (!entry) {
      if (estimatedTotals && String(structuredItem?.foodName || '').trim()) {
        items.push({
          foodItem: String(structuredItem.foodName || '').trim(),
          quantityValue:
            toPositiveFiniteOrNull(structuredItem?.quantityValue) ??
            toPositiveFiniteOrNull(structuredItem?.quantity) ??
            1,
          quantityUnit: String(structuredItem?.quantityUnit || 'porcion').trim() || 'porcion',
          caloriesKcal: estimatedTotals.caloriesKcal,
          proteinG: estimatedTotals.proteinG,
          carbsG: estimatedTotals.carbsG,
          fatG: estimatedTotals.fatG,
          confidence: normalizeConfidenceLabel(structuredItem?.confidence, 'baja'),
          source: 'estimacion_gpt',
          brandOrNotes: String(structuredItem?.brand || '').trim() || null,
          inferenceSource,
        });
        continue;
      }
      unresolvedItems.push(
        String(structuredItem?.foodName || structuredItem?.catalogId || 'item').trim() || 'item'
      );
      continue;
    }

    const quantityValue =
      toPositiveFiniteOrNull(structuredItem?.quantityValue) ??
      toPositiveFiniteOrNull(structuredItem?.quantity) ??
      1;
    const quantityUnit = String(structuredItem?.quantityUnit || 'porcion').trim() || 'porcion';
    const factor = computeQuantityFactor(quantityValue, quantityUnit, entry.portionG);

    items.push({
      foodItem: entry.productName,
      quantityValue,
      quantityUnit,
      caloriesKcal: roundMacro((Number(entry.caloriesKcal) || 0) * factor),
      proteinG: roundMacro((Number(entry.proteinG) || 0) * factor),
      carbsG: roundMacro((Number(entry.carbsG) || 0) * factor),
      fatG: roundMacro((Number(entry.fatG) || 0) * factor),
      confidence: normalizeConfidenceLabel(structuredItem?.confidence, 'media'),
      source: entry.source || 'base_estandar',
      brandOrNotes: entry.brand || null,
      catalogItemId: Number(entry.id) || null,
      inputAlias: String(structuredItem?.foodName || '').trim() || null,
      matchedPreferenceAlias: resolved?.matchedPreferenceAlias || null,
      inferenceSource,
    });
  }

  if (!items.length) {
    return {
      ok: false,
      error: 'no_resolved_items',
      temporal,
      items,
      unresolvedItems,
    };
  }
  if (unresolvedItems.length) {
    return {
      ok: false,
      error: 'partial_resolution',
      temporal,
      items,
      unresolvedItems,
    };
  }
  return {
    ok: true,
    temporal,
    items,
    unresolvedItems: [],
  };
}

async function parseStructuredIntakeWithModel({
  openai,
  modelCandidates = [],
  rawMessage = '',
  userTimeZone = DEFAULT_USER_TIMEZONE,
  catalogRows = [],
  userDefaultRows = [],
} = {}) {
  const instructions = [
    'Sos un parser de ingestas de nutricion.',
    'Tu salida debe ser JSON puro (sin markdown) usando este schema:',
    '{',
    '  "action":"log_intake|ask_label_photo|ask_clarification|reject",',
    '  "temporal":{"local_date":"YYYY-MM-DD|null","local_time":"HH:MM|null"},',
    '  "items":[{"catalog_id":number|null,"food_name":"string","brand":"string","quantity_value":number|string|null,"quantity_unit":"string","confidence":"alta|media|baja","estimated_totals":{"calories_kcal":number,"protein_g":number,"carbs_g":number,"fat_g":number}|null}],',
    '  "clarification_question":"string",',
    '  "should_request_label_photo":true|false',
    '}',
    'Reglas:',
    '- Si es una ingesta registrable: action=log_intake y al menos 1 item.',
    '- Usa catalog_id cuando encuentres producto en el catalogo recibido.',
    '- Prioriza primero "productos fijos por usuario" (alias personales), luego catalogo general.',
    '- No inventes catalog_id; si no existe, deja null y completa food_name.',
    '- Si hay temporalidad explicita, mapea local_date/local_time; si no, usa null.',
    '- Si no hay match de catálogo pero se entiende el item, estimá macros del item en estimated_totals y confidence media/baja (no bloquear).',
    '- Solo pedir aclaracion si de verdad no se puede estimar ni identificar el item.',
    '- Si detectas producto de paquete ambiguo para macros exactos, should_request_label_photo=true (podés estimar igual para registrar ahora).',
    '- Entendé lenguaje natural rioplatense y verbos operativos: "registrame", "anotá", "sumá", "me comí", "desayuné", "almorcé", "cené", "tomé".',
    '- Soportá horarios: "18:30", "18.30", "18h", "18hs", "a las 18", "hoy", "ayer".',
    '- Soportá cantidades coloquiales: "1/2", "media", "un cuarto", "2 tostadas", "1 flat white", "cookie de cafetería".',
    '- Separadores comunes: coma, "y", "+", "con".',
    '- Si action=ask_clarification, la pregunta debe ser breve y accionable.',
    '- Nunca devuelvas texto fuera del JSON.',
    '- Ejemplo valido: {"action":"log_intake","temporal":{"local_date":null,"local_time":"18:30"},"items":[{"catalog_id":null,"food_name":"flat white con leche entera","brand":"","quantity_value":1,"quantity_unit":"unidad","confidence":"media","estimated_totals":{"calories_kcal":180,"protein_g":8,"carbs_g":12,"fat_g":10}},{"catalog_id":null,"food_name":"cookie de cafeteria mantecosa","brand":"","quantity_value":"1/2","quantity_unit":"unidad","confidence":"baja","estimated_totals":{"calories_kcal":160,"protein_g":2,"carbs_g":18,"fat_g":9}}],"clarification_question":"","should_request_label_photo":true}',
    '- Si el mensaje no es ingesta, action=reject.',
  ].join('\n');

  const inputText = [
    `Timezone usuario: ${userTimeZone}`,
    '',
    'Mensaje usuario:',
    rawMessage,
    '',
    'Productos fijos por usuario (alias personales -> catalog_id):',
    formatUserDefaultsForStructuredParser(userDefaultRows),
    '',
    'Catalogo nutricional (id y macros por porcion):',
    formatCatalogRowsForStructuredParser(catalogRows),
  ].join('\n');

  const smart = await createSmartResponse({
    openai,
    modelCandidates,
    instructions,
    input: [
      {
        role: 'user',
        content: [{ type: 'input_text', text: inputText }],
      },
    ],
  });
  const outputText = extractOutputText(smart.response);
  const json = extractJsonObject(outputText) || {};
  const rawItems = Array.isArray(json.items) ? json.items : [];

  return {
    ok: true,
    model: smart.model,
    usage: extractUsageSnapshot(smart.response),
    action: String(json.action || '').trim() || 'reject',
    clarificationQuestion: String(json.clarification_question || '').trim(),
    shouldRequestLabelPhoto: Boolean(json.should_request_label_photo),
    temporal: {
      localDate: String(json?.temporal?.local_date || '').trim(),
      localTime: String(json?.temporal?.local_time || '').trim(),
    },
    items: rawItems
      .map((item) => ({
        catalogId: Number(item?.catalog_id),
        foodName: String(item?.food_name || '').trim(),
        brand: String(item?.brand || '').trim(),
        quantityValue: parseFlexibleNumber(item?.quantity_value),
        quantityUnit: String(item?.quantity_unit || '').trim(),
        confidence: String(item?.confidence || '').trim(),
        estimatedTotals: item?.estimated_totals
          ? {
              caloriesKcal: Number(item?.estimated_totals?.calories_kcal),
              proteinG: Number(item?.estimated_totals?.protein_g),
              carbsG: Number(item?.estimated_totals?.carbs_g),
              fatG: Number(item?.estimated_totals?.fat_g),
            }
          : null,
      }))
      .filter((item) => item.foodName || Number.isFinite(item.catalogId)),
  };
}

async function extractNutritionLabelFromImage({
  openai,
  modelCandidates = [],
  inputItems = [],
  userMessage = '',
} = {}) {
  const instructions = [
    'Sos extractor de tablas nutricionales.',
    'Analiza la imagen enviada y devuelve JSON puro sin markdown.',
    'Schema:',
    '{',
    '  "action":"catalog_entry_ready|unclear_image|not_nutrition_label",',
    '  "product_name":"string",',
    '  "brand":"string",',
    '  "portion_g":number|null,',
    '  "kcal_per_portion":number|null,',
    '  "protein_g":number|null,',
    '  "carbs_g":number|null,',
    '  "fat_g":number|null,',
    '  "fiber_g":number|null,',
    '  "sodium_mg":number|null,',
    '  "note":"string"',
    '}',
    'Reglas:',
    '- Si no hay tabla nutricional legible, action=unclear_image.',
    '- Si no es etiqueta nutricional, action=not_nutrition_label.',
    '- Solo usar catalog_entry_ready si al menos porcion, kcal, proteina, carbos y grasas son legibles.',
    '- Si usuario menciona nombre/marca en el texto, usarlo para completar.',
  ].join('\n');

  const smart = await createSmartResponse({
    openai,
    modelCandidates,
    instructions,
    input: [
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: `Texto opcional del usuario: ${String(userMessage || '').trim() || '(vacío)'}`,
          },
          ...inputItems,
        ],
      },
    ],
  });
  const outputText = extractOutputText(smart.response);
  const json = extractJsonObject(outputText) || {};
  const toNumberOrNull = (value) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };

  return {
    ok: true,
    model: smart.model,
    usage: extractUsageSnapshot(smart.response),
    action: String(json.action || '').trim() || 'unclear_image',
    productName: String(json.product_name || '').trim(),
    brand: String(json.brand || '').trim(),
    portionG: toNumberOrNull(json.portion_g),
    caloriesKcal: toNumberOrNull(json.kcal_per_portion),
    proteinG: toNumberOrNull(json.protein_g),
    carbsG: toNumberOrNull(json.carbs_g),
    fatG: toNumberOrNull(json.fat_g),
    fiberG: toNumberOrNull(json.fiber_g),
    sodiumMg: toNumberOrNull(json.sodium_mg),
    note: String(json.note || '').trim(),
  };
}

async function inferMealIntakeFromImage({
  openai,
  modelCandidates = [],
  inputItems = [],
  userMessage = '',
  userTimeZone = DEFAULT_USER_TIMEZONE,
} = {}) {
  const instructions = [
    'Sos un parser visual de ingestas para nutricion.',
    'Debes analizar foto(s) de comida y devolver JSON puro sin markdown.',
    'Schema:',
    '{',
    '  "action":"meal_log_ready|meal_needs_confirmation|nutrition_label|not_food|unclear_image",',
    '  "overall_confidence":"alta|media|baja",',
    '  "temporal":{"local_date":"YYYY-MM-DD|null","local_time":"HH:MM|null"},',
    '  "items":[{"catalog_id":number|null,"food_name":"string","brand":"string","quantity_value":number|string|null,"quantity_unit":"string","confidence":"alta|media|baja","estimated_totals":{"calories_kcal":number,"protein_g":number,"carbs_g":number,"fat_g":number}|null}],',
    '  "confirmation_question":"string",',
    '  "should_request_label_photo":true|false,',
    '  "note":"string"',
    '}',
    'Reglas:',
    '- Si la imagen principal es una tabla nutricional/etiqueta: action=nutrition_label.',
    '- Si es comida/plato y podés inferir item(s) + porciones razonables: action=meal_log_ready.',
    '- Si hay comida pero duda material (item o porción): action=meal_needs_confirmation.',
    '- En meal_needs_confirmation, igual devolvé tu mejor inferencia en items + confirmation_question breve.',
    '- Solo usar not_food si no hay comida registrable.',
    '- Solo usar unclear_image si la imagen está demasiado borrosa o incompleta.',
    '- En cada item, incluir estimated_totals para kcal/prote/carbos/grasas si no hay catalog_id exacto.',
    '- Si el alimento parece de paquete sin certeza de etiqueta, should_request_label_photo=true.',
    '- No inventes catalog_id.',
    '- Nunca devuelvas texto fuera del JSON.',
  ].join('\n');

  const smart = await createSmartResponse({
    openai,
    modelCandidates,
    instructions,
    input: [
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: `Timezone usuario: ${userTimeZone}\nTexto opcional del usuario: ${
              String(userMessage || '').trim() || '(vacio)'
            }`,
          },
          ...inputItems,
        ],
      },
    ],
  });

  const outputText = extractOutputText(smart.response);
  const json = extractJsonObject(outputText) || {};
  const rawItems = Array.isArray(json.items) ? json.items : [];

  return {
    ok: true,
    model: smart.model,
    usage: extractUsageSnapshot(smart.response),
    action: String(json.action || '').trim() || 'unclear_image',
    overallConfidence: normalizeConfidenceLabel(json.overall_confidence, 'baja'),
    temporal: {
      localDate: String(json?.temporal?.local_date || '').trim(),
      localTime: String(json?.temporal?.local_time || '').trim(),
    },
    confirmationQuestion: String(json.confirmation_question || '').trim(),
    shouldRequestLabelPhoto: Boolean(json.should_request_label_photo),
    note: String(json.note || '').trim(),
    items: rawItems
      .map((item) => ({
        catalogId: Number(item?.catalog_id),
        foodName: String(item?.food_name || '').trim(),
        brand: String(item?.brand || '').trim(),
        quantityValue: parseFlexibleNumber(item?.quantity_value),
        quantityUnit: String(item?.quantity_unit || '').trim(),
        confidence: normalizeConfidenceLabel(item?.confidence, 'media'),
        estimatedTotals: item?.estimated_totals
          ? {
              caloriesKcal: Number(item?.estimated_totals?.calories_kcal),
              proteinG: Number(item?.estimated_totals?.protein_g),
              carbsG: Number(item?.estimated_totals?.carbs_g),
              fatG: Number(item?.estimated_totals?.fat_g),
            }
          : null,
      }))
      .filter((item) => item.foodName || Number.isFinite(item.catalogId)),
  };
}

function normalizeText(value = '') {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function isImageDraftConfirmIntent(text = '') {
  const normalized = normalizeText(text);
  if (!normalized) return false;
  return (
    /^(si|sí|ok|dale|confirmo|confirmado)\b/.test(normalized) ||
    /\b(registra|registrar|anota|anotalo|carga|cargalo)\b.*\b(eso|asi|así)\b/.test(normalized)
  );
}

function isImageDraftCancelIntent(text = '') {
  const normalized = normalizeText(text);
  if (!normalized) return false;
  return /\b(cancela|cancelar|descarta|descartar|no registrar|no cargues|no anotes)\b/.test(
    normalized
  );
}

function getPendingImageIntakeDraft(draftsByUser, userId = '') {
  const key = String(userId || '').trim();
  if (!key) return null;
  const draft = draftsByUser.get(key) || null;
  if (!draft) return null;
  if (Number(draft.expiresAt || 0) <= Date.now()) {
    draftsByUser.delete(key);
    return null;
  }
  return draft;
}

function setPendingImageIntakeDraft(draftsByUser, userId = '', draft = {}) {
  const key = String(userId || '').trim();
  if (!key || !draft || typeof draft !== 'object') return;
  draftsByUser.set(key, {
    ...draft,
    createdAt: Date.now(),
    expiresAt: Date.now() + IMAGE_INTAKE_DRAFT_TTL_MS,
  });
}

function consumePendingImageIntakeDraft(draftsByUser, userId = '') {
  const key = String(userId || '').trim();
  if (!key) return null;
  const draft = getPendingImageIntakeDraft(draftsByUser, key);
  if (!draft) return null;
  draftsByUser.delete(key);
  return draft;
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

function looksLikeUserDefaultsQuestion(text = '') {
  return /\b(productos fijos|mis productos|mis defaults|preferencias de productos|alias de productos)\b/.test(
    text
  );
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
    const todayIntakes = listNutritionIntakesByDate(userId, temporal.localDate, { limit: 80 });
    return formatSummaryReply({
      localDate: temporal.localDate,
      localTime: temporal.localTime,
      summary,
      status,
      latestWeighin,
      todayIntakes,
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

  if (looksLikeUserDefaultsQuestion(normalized)) {
    const defaults = listNutritionUserProductDefaults(userId, { limit: 20 });
    return formatUserProductDefaultsReply(defaults);
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
  const smartModelCandidates = parseModelCandidates(
    process.env.NUTRITION_SMART_MODELS ||
      process.env.NUTRITION_SMART_MODEL ||
      DEFAULT_SMART_MODELS
  );
  const promptSnippet = loadPromptFile(manifest);
  const chatIdByUser = new Map();
  const pendingImageIntakeDraftByUser = new Map();
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

        const productPreferenceCommand = parseProfileProductPreferenceCommand(cleanMessage);
        if (productPreferenceCommand?.action === 'list_defaults') {
          const defaults = listNutritionUserProductDefaults(userId, { limit: 20 });
          replyText = formatUserProductDefaultsReply(defaults);
          shouldCharge = true;
        } else if (productPreferenceCommand?.action === 'set_default') {
          const alias = sanitizeUserAliasCandidate(productPreferenceCommand.alias);
          if (!alias) {
            return [
              'No pude leer el alias del producto.',
              'Formato: `producto leche proteica = Leche Proteica La Serenisima`',
            ].join('\n');
          }

          const resolved = resolveCatalogEntryForProfilePreference(
            productPreferenceCommand.productQuery
          );
          if (resolved.status === 'ambiguous') {
            return [
              `Encontré más de un producto para "${productPreferenceCommand.productQuery}".`,
              'Elegí uno por ID:',
              formatCatalogAlternatives(resolved.alternatives),
              `Ejemplo: \`producto ${alias} = #${resolved.alternatives?.[0]?.id || ''}\``,
            ]
              .filter(Boolean)
              .join('\n');
          }
          if (resolved.status !== 'matched' || !resolved.entry) {
            return [
              `No encontré "${productPreferenceCommand.productQuery}" en INFO_NUTRICIONAL.`,
              'Podés mandar etiqueta nutricional para cargarlo y luego mapearlo como producto fijo.',
            ].join('\n');
          }

          const mapped = setNutritionUserProductDefault(
            userId,
            {
              alias,
              catalogItemId: resolved.entry.id,
              source: 'profile_command',
            },
            {
              idempotency: {
                sourceMessageId,
                operationType: 'set_user_product_default',
              },
            }
          );
          if (!mapped?.ok) {
            return formatWriteFailureReply('update_profile', mapped?.error || 'user_default_failed');
          }

          const defaults = listNutritionUserProductDefaults(userId, { limit: 20 });
          replyText = [
            '✅ Producto fijo guardado.',
            `- Alias: ${alias}`,
            `- Producto: ${resolved.entry.productName}${resolved.entry.brand ? ` (${resolved.entry.brand})` : ''}`,
            '',
            formatUserProductDefaultsReply(defaults),
          ].join('\n');
          shouldCharge = true;
        } else if (productPreferenceCommand?.action === 'remove_default') {
          const alias = sanitizeUserAliasCandidate(productPreferenceCommand.alias);
          if (!alias) {
            return 'No pude leer qué alias querés quitar. Ejemplo: `quitar producto leche proteica`';
          }
          const removed = removeNutritionUserProductDefault(
            userId,
            alias,
            {
              idempotency: {
                sourceMessageId,
                operationType: 'remove_user_product_default',
              },
            }
          );
          if (!removed?.ok) {
            return formatWriteFailureReply(
              'update_profile',
              removed?.error || 'remove_user_default_failed'
            );
          }
          const defaults = listNutritionUserProductDefaults(userId, { limit: 20 });
          replyText = [
            removed.deleted
              ? `✅ Alias eliminado: ${alias}`
              : `No encontré alias activo para: ${alias}`,
            '',
            formatUserProductDefaultsReply(defaults),
          ].join('\n');
          shouldCharge = true;
        } else {

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
        }
      } else if (guidedAction === 'view_summary') {
        const temporal = resolveTemporalContext({
          rawMessage: cleanMessage || 'hoy',
          userTimeZone,
        });
        const summary = getNutritionSummary(userId, temporal.localDate);
        const status = calculateProfileStatus(profile, summary.today);
        const latestWeighin = getLatestNutritionWeighin(userId);
        const todayIntakes = listNutritionIntakesByDate(userId, temporal.localDate, { limit: 80 });
        replyText = formatSummaryReply({
          localDate: temporal.localDate,
          localTime: temporal.localTime,
          summary,
          status,
          latestWeighin,
          todayIntakes,
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

          const smartLearning = await createSmartResponse({
            openai,
            modelCandidates: smartModelCandidates,
            instructions: runtimePrompt,
            input: userInput,
          });
          usageSnapshot = mergeUsageSnapshots(usageSnapshot, extractUsageSnapshot(smartLearning.response));
          if (usageSnapshot) {
            addNutritionUsageRecord(userId, {
              guidedAction,
              model: smartLearning.model,
              inputTokens: usageSnapshot.inputTokens,
              outputTokens: usageSnapshot.outputTokens,
              totalTokens: usageSnapshot.totalTokens,
              reasoningTokens: usageSnapshot.reasoningTokens,
              cachedTokens: usageSnapshot.cachedTokens,
              rawUsage: usageSnapshot.rawUsage,
            });
          }
          const rawReply =
            extractOutputText(smartLearning.response) ||
            'No pude generar una respuesta útil en este turno. Reintentá con más contexto.';
          replyText = enforcePolicyPack({
            text: rawReply,
            policyPackId,
          });
          shouldCharge = true;
        }
      } else {
        const catalogCandidates = cleanMessage
          ? findFoodCatalogCandidates(cleanMessage, { limit: 60 })
          : [];
        const defaultRowsRaw = listNutritionUserProductDefaults(userId, { limit: 30 });
        const defaultRowsAsCatalog = mapDefaultRowsToPreferredCatalogRows(defaultRowsRaw);
        const userDefaultMatches = cleanMessage
          ? findNutritionUserPreferredCatalogEntries(userId, cleanMessage, { limit: 40 })
          : [];
        const userDefaultRows = mergeCatalogRows(userDefaultMatches, defaultRowsAsCatalog);
        const catalogFallbackRows = listFoodCatalogEntries().slice(0, 160);
        const catalogRowsForParsing = mergeCatalogRows(
          userDefaultRows,
          mergeCatalogRows(catalogCandidates, catalogFallbackRows)
        );
        const catalogRowsForNormalization = catalogRowsForParsing.length
          ? catalogRowsForParsing
          : getFoodCatalogPreview({ limit: 60 });

        let parsed = null;
        let lexicalParsed = null;
        let modelStructured = null;
        let modelNormalization = null;
        let shouldRequestLabelPhotoHint = false;
        let includeConfidenceInReply = false;

        if (!hasMedia && cleanMessage) {
          const pendingDraft = getPendingImageIntakeDraft(pendingImageIntakeDraftByUser, userId);
          if (pendingDraft && isImageDraftCancelIntent(cleanMessage)) {
            consumePendingImageIntakeDraft(pendingImageIntakeDraftByUser, userId);
            return 'Perfecto, descarté la inferencia anterior. Mandame otra foto o texto y lo registro.';
          }
          if (pendingDraft && isImageDraftConfirmIntent(cleanMessage)) {
            const consumedDraft = consumePendingImageIntakeDraft(pendingImageIntakeDraftByUser, userId);
            if (consumedDraft?.parsed?.ok) {
              parsed = consumedDraft.parsed;
              shouldRequestLabelPhotoHint = Boolean(consumedDraft.shouldRequestLabelPhotoHint);
              includeConfidenceInReply = true;
            }
          }
        }

        let imageMealResult = null;
        if (!parsed && hasMedia) {
          try {
            imageMealResult = await inferMealIntakeFromImage({
              openai,
              modelCandidates: smartModelCandidates,
              inputItems,
              userMessage: cleanMessage,
              userTimeZone,
            });
            usageSnapshot = mergeUsageSnapshots(usageSnapshot, imageMealResult.usage);
            if (imageMealResult.usage) {
              addNutritionUsageRecord(userId, {
                guidedAction: 'log_intake_image_parser',
                model: imageMealResult.model,
                inputTokens: imageMealResult.usage.inputTokens,
                outputTokens: imageMealResult.usage.outputTokens,
                totalTokens: imageMealResult.usage.totalTokens,
                reasoningTokens: imageMealResult.usage.reasoningTokens,
                cachedTokens: imageMealResult.usage.cachedTokens,
                rawUsage: imageMealResult.usage.rawUsage,
              });
            }
          } catch (imageMealError) {
            console.error('[nutrition-runtime] meal image parser failed', imageMealError);
          }
        }

        const shouldTryLabelExtraction =
          hasMedia &&
          (looksLikeLabelIntent(cleanMessage) || imageMealResult?.action === 'nutrition_label');
        if (!parsed && shouldTryLabelExtraction) {
          try {
            const labelResult = await extractNutritionLabelFromImage({
              openai,
              modelCandidates: smartModelCandidates,
              inputItems,
              userMessage: cleanMessage,
            });
            usageSnapshot = mergeUsageSnapshots(usageSnapshot, labelResult.usage);
            if (labelResult.usage) {
              addNutritionUsageRecord(userId, {
                guidedAction: 'log_intake_label_extraction',
                model: labelResult.model,
                inputTokens: labelResult.usage.inputTokens,
                outputTokens: labelResult.usage.outputTokens,
                totalTokens: labelResult.usage.totalTokens,
                reasoningTokens: labelResult.usage.reasoningTokens,
                cachedTokens: labelResult.usage.cachedTokens,
                rawUsage: labelResult.usage.rawUsage,
              });
            }

            if (labelResult.action === 'catalog_entry_ready') {
              const catalogWrite = upsertFoodCatalogEntry(
                {
                  productName: labelResult.productName || 'producto etiqueta',
                  brand: labelResult.brand || '',
                  portionG: labelResult.portionG,
                  caloriesKcal: labelResult.caloriesKcal,
                  proteinG: labelResult.proteinG,
                  carbsG: labelResult.carbsG,
                  fatG: labelResult.fatG,
                  fiberG: labelResult.fiberG,
                  sodiumMg: labelResult.sodiumMg,
                  source: 'etiqueta',
                },
                {
                  idempotency: {
                    sourceMessageId,
                    operationType: 'upsert_food_catalog',
                    userId,
                  },
                }
              );
              if (!catalogWrite?.ok) {
                return formatWriteFailureReply('log_intake', catalogWrite?.error || 'catalog_upsert_failed');
              }

              if (!cleanMessage || looksLikeLabelIntent(cleanMessage)) {
                return [
                  '✅ Producto guardado en INFO_NUTRICIONAL.',
                  `- Producto: ${labelResult.productName || 'producto etiqueta'}`,
                  labelResult.brand ? `- Marca: ${labelResult.brand}` : null,
                  `- Porción: ${Number(labelResult.portionG).toFixed(0)} g`,
                  `- Kcal/P: ${Number(labelResult.caloriesKcal).toFixed(0)} | P ${Number(
                    labelResult.proteinG
                  ).toFixed(1)} g | C ${Number(labelResult.carbsG).toFixed(1)} g | G ${Number(
                    labelResult.fatG
                  ).toFixed(1)} g`,
                  'Ahora podés registrar ingesta con texto simple y este producto ya queda reutilizable.',
                ]
                  .filter(Boolean)
                  .join('\n');
              }
            } else if (!cleanMessage && imageMealResult?.action === 'nutrition_label') {
              return [
                'No pude leer completa la tabla nutricional.',
                'Mandá foto frontal y nítida donde se vea porción + kcal + proteínas + carbos + grasas.',
              ].join('\n');
            }
          } catch (labelError) {
            console.error('[nutrition-runtime] label extraction failed', labelError);
            if (!cleanMessage && imageMealResult?.action === 'nutrition_label') {
              return [
                'No pude procesar la etiqueta ahora mismo.',
                'Reintentá con una foto más nítida y frontal.',
              ].join('\n');
            }
          }
        }

        if (
          !parsed &&
          imageMealResult &&
          (imageMealResult.action === 'meal_log_ready' || imageMealResult.action === 'meal_needs_confirmation') &&
          imageMealResult.items?.length
        ) {
          const parsedFromImage = buildParsedIntakeFromStructured({
            userId,
            rawMessage: cleanMessage,
            userTimeZone,
            structured: {
              temporal: imageMealResult.temporal,
              items: imageMealResult.items,
            },
            catalogRows: catalogRowsForParsing,
            userDefaultRows,
            inferenceSource: 'image',
          });

          if (parsedFromImage.ok) {
            shouldRequestLabelPhotoHint = Boolean(imageMealResult.shouldRequestLabelPhoto);
            includeConfidenceInReply = true;
            if (
              imageMealResult.action === 'meal_needs_confirmation' ||
              imageMealResult.overallConfidence === 'baja'
            ) {
              setPendingImageIntakeDraft(pendingImageIntakeDraftByUser, userId, {
                parsed: parsedFromImage,
                shouldRequestLabelPhotoHint,
              });
              return [
                '👀 Esto es lo que inferí de la foto (sin registrar todavía):',
                ...buildIntakeDetailsBlock({
                  title: '🧾 Posible registro',
                  rows: parsedFromImage.items,
                  includeTime: false,
                  includeConfidence: true,
                  chronological: false,
                }),
                imageMealResult.confirmationQuestion || '¿Está correcto para registrarlo?',
                'Respondé `sí` para registrarlo tal cual, o corregime en texto (ej: `22:10 hamburguesa + papas fritas`).',
              ].join('\n');
            }
            parsed = parsedFromImage;
          }
        }

        if (!parsed && hasMedia && !cleanMessage && imageMealResult?.action === 'not_food') {
          return [
            'No detecté una comida registrable en la foto.',
            'Si querés, mandame otra foto más clara o texto simple: `hora + lo ingerido`.',
          ].join('\n');
        }

        if (!parsed) {
          parsed = parseIntakePayload({
            rawMessage: cleanMessage,
            userTimeZone,
          });
          lexicalParsed = parsed;
        }

        if (!parsed?.ok && cleanMessage) {
          try {
            modelStructured = await parseStructuredIntakeWithModel({
              openai,
              modelCandidates: smartModelCandidates,
              rawMessage: cleanMessage,
              userTimeZone,
              catalogRows: catalogRowsForParsing,
              userDefaultRows,
            });
            usageSnapshot = mergeUsageSnapshots(usageSnapshot, modelStructured.usage);
            if (modelStructured.usage) {
              addNutritionUsageRecord(userId, {
                guidedAction: 'log_intake_structured_parser',
                model: modelStructured.model,
                inputTokens: modelStructured.usage.inputTokens,
                outputTokens: modelStructured.usage.outputTokens,
                totalTokens: modelStructured.usage.totalTokens,
                reasoningTokens: modelStructured.usage.reasoningTokens,
                cachedTokens: modelStructured.usage.cachedTokens,
                rawUsage: modelStructured.usage.rawUsage,
              });
            }
          } catch (structuredError) {
            console.error('[nutrition-runtime] structured intake parser failed', structuredError);
          }
        }

        if (!parsed?.ok && modelStructured?.action === 'log_intake' && modelStructured.items?.length) {
          const parsedFromStructured = buildParsedIntakeFromStructured({
            userId,
            rawMessage: cleanMessage,
            userTimeZone,
            structured: modelStructured,
            catalogRows: catalogRowsForParsing,
            userDefaultRows,
            inferenceSource: 'text_structured',
          });
          if (parsedFromStructured.ok || !parsed?.ok) {
            parsed = parsedFromStructured;
          }
        }

        if (!parsed?.ok && cleanMessage) {
          try {
            modelNormalization = await normalizeIntakeWithModel({
              openai,
              modelCandidates: smartModelCandidates,
              rawMessage: cleanMessage,
              userTimeZone,
              catalogCandidates: catalogRowsForNormalization,
            });
            usageSnapshot = mergeUsageSnapshots(usageSnapshot, modelNormalization.usage);
            if (modelNormalization.usage) {
              addNutritionUsageRecord(userId, {
                guidedAction: 'log_intake_normalization',
                model: modelNormalization.model,
                inputTokens: modelNormalization.usage.inputTokens,
                outputTokens: modelNormalization.usage.outputTokens,
                totalTokens: modelNormalization.usage.totalTokens,
                reasoningTokens: modelNormalization.usage.reasoningTokens,
                cachedTokens: modelNormalization.usage.cachedTokens,
                rawUsage: modelNormalization.usage.rawUsage,
              });
            }
          } catch (normalizationError) {
            console.error('[nutrition-runtime] intake normalization failed', normalizationError);
          }
        }

        if (!parsed?.ok && modelNormalization?.action === 'normalize_intake' && modelNormalization.normalizedText) {
          const parsedFromModel = parseIntakePayload({
            rawMessage: modelNormalization.normalizedText,
            userTimeZone,
          });
          if (parsedFromModel.ok) {
            parsed = parsedFromModel;
          }
        }

        if (modelStructured?.shouldRequestLabelPhoto || modelNormalization?.shouldRequestLabelPhoto) {
          shouldRequestLabelPhotoHint = true;
        }

        if (!parsed?.ok) {
          if (
            modelStructured?.action === 'ask_label_photo' ||
            (modelStructured?.shouldRequestLabelPhoto && !lexicalParsed?.ok)
          ) {
            return [
              'Para registrar ese producto con buena precision necesito la etiqueta nutricional.',
              'Mandame foto clara de la tabla (porción, kcal, proteínas, carbos, grasas).',
              'Con eso lo agrego a INFO_NUTRICIONAL y te queda para siempre.',
              buildPhotoHintLine(),
            ].join('\n');
          }
          if (modelStructured?.action === 'ask_clarification' && modelStructured.clarificationQuestion) {
            return [modelStructured.clarificationQuestion, buildPhotoHintLine()].join('\n');
          }
          if (modelNormalization?.action === 'ask_label_photo') {
            return [
              'Para registrar ese producto con buena precision necesito la etiqueta nutricional.',
              'Mandame foto clara de la tabla (porción, kcal, proteínas, carbos, grasas).',
              'Con eso lo agrego a INFO_NUTRICIONAL y te queda para siempre.',
              buildPhotoHintLine(),
            ].join('\n');
          }
          if (modelNormalization?.action === 'ask_clarification' && modelNormalization.clarificationQuestion) {
            return [modelNormalization.clarificationQuestion, buildPhotoHintLine()].join('\n');
          }
          if (parsed?.error === 'partial_resolution' && parsed.unresolvedItems?.length) {
            return [
              'Necesito aclarar algunos items antes de registrar.',
              `No pude interpretar: ${parsed.unresolvedItems.join(', ')}`,
              'Mandalo en formato simple por item: `hora alimento cantidad`.',
              buildPhotoHintLine(),
            ].join('\n');
          }
          if (hasMedia && !cleanMessage) {
            return [
              'No pude inferir la comida con suficiente claridad.',
              'Si querés, mandame otra foto más nítida o texto simple: `hora + lo ingerido`.',
            ].join('\n');
          }
          return [
            'No pude detectar una ingesta registrable.',
            'Formato recomendado: `13:30 200g pollo + 150g arroz`.',
            buildPhotoHintLine(),
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
        pendingImageIntakeDraftByUser.delete(userId);

        for (const parsedItem of Array.isArray(parsed.items) ? parsed.items : []) {
          const catalogItemId = Number(parsedItem?.catalogItemId);
          if (!Number.isFinite(catalogItemId) || catalogItemId <= 0) continue;
          const aliasCandidate = sanitizeUserAliasCandidate(
            parsedItem?.inputAlias || parsedItem?.foodItem
          );
          if (!aliasCandidate) continue;
          if (!looksLikePackagedAlias(aliasCandidate) && !looksLikePackagedAlias(parsedItem?.foodItem)) {
            continue;
          }
          const mapped = setNutritionUserProductDefault(
            userId,
            {
              alias: aliasCandidate,
              catalogItemId,
              source: 'auto_from_intake',
            },
            {
              idempotency: {
                sourceMessageId: sourceMessageId ? `${sourceMessageId}:${aliasCandidate}` : '',
                operationType: 'set_user_product_default',
              },
            }
          );
          if (mapped?.ok) {
            const aliasToBump = sanitizeUserAliasCandidate(
              parsedItem?.matchedPreferenceAlias || aliasCandidate
            );
            if (aliasToBump) {
              bumpNutritionUserProductDefaultUsage(userId, aliasToBump);
            }
          }
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
          ...buildIntakeDetailsBlock({
            title: '🧾 Detalle registrado',
            rows: parsed.items,
            includeTime: false,
            includeConfidence:
              includeConfidenceInReply ||
              parsed.items.some((item) => String(item?.inferenceSource || '') === 'image'),
            chronological: false,
          }),
          formatMacroLine('📊 Hoy: ', summary.today),
          formatMacroLine('📅 Rolling 7d: ', summary.rolling7d),
          formatMacroLine('🗓️ Rolling 14d: ', summary.rolling14d),
          `🎯 Estado: ${status}`,
          shouldRequestLabelPhotoHint
            ? '📦 Si es un producto de paquete, mandame foto de la etiqueta nutricional y lo agrego a INFO_NUTRICIONAL.'
            : null,
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
