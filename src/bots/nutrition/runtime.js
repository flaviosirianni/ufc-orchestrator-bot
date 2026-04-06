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
  listNutritionUserCatalogUsage,
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
  getTodayNutritionIntakes,
  findNutritionIntakeById,
  deleteNutritionIntake,
  updateNutritionIntakeTemporal,
  getTodayNutritionWeighins,
  deleteNutritionWeighin,
  listRecentNutritionWeighins,
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

const DEFAULT_MODEL = process.env.BOT_MODEL || process.env.BETTING_MODEL || 'gpt-5.4-mini';
const DEFAULT_SMART_MODELS = 'gpt-5.4,gpt-5.4-mini,gpt-5.2,gpt-4.1-mini';
const DEFAULT_TOPUP_PACKS = process.env.MP_TOPUP_PACKS || '';
const APP_PUBLIC_URL = process.env.APP_PUBLIC_URL || '';
const CREDIT_TOPUP_URL = process.env.CREDIT_TOPUP_URL || '';
const CREDIT_ENFORCE = String(process.env.CREDIT_ENFORCE ?? 'true').toLowerCase() !== 'false';
const DEFAULT_USER_TIMEZONE =
  process.env.DEFAULT_USER_TIMEZONE || 'America/Argentina/Buenos_Aires';
const IMAGE_INTAKE_DRAFT_TTL_MS = 20 * 60 * 1000;
const IMAGE_WEIGHIN_DRAFT_TTL_MS = 20 * 60 * 1000;
const INTAKE_OPERATION_CONTEXT_TTL_MS = 20 * 60 * 1000;
const NUTRITION_LLM_FIRST_PARSING =
  String(process.env.NUTRITION_LLM_FIRST_PARSING ?? 'true').toLowerCase() !== 'false';
const NUTRITION_STRICT_SEMANTIC_GUARDRAIL =
  String(process.env.NUTRITION_STRICT_SEMANTIC_GUARDRAIL ?? 'false').toLowerCase() === 'true';
const SPANISH_MONTH_HINT_PATTERN =
  'enero|feb(?:rero)?|mar(?:zo)?|abr(?:il)?|may(?:o)?|jun(?:io)?|jul(?:io)?|ago(?:sto)?|sep(?:tiembre)?|set(?:iembre)?|oct(?:ubre)?|nov(?:iembre)?|dic(?:iembre)?';

const TUTORIAL_CONTENT_MAP = {
  calorias: { title: 'Calorías: qué son y por qué importan', level: 'basico' },
  macros: { title: 'Proteínas, carbohidratos y grasas: lo básico', level: 'basico' },
  armar_plato: { title: 'Cómo armar un plato equilibrado', level: 'basico' },
  etiquetas: { title: 'Cómo leer etiquetas nutricionales', level: 'basico' },
  comer_mejor: { title: 'Comer mejor sin contar todo', level: 'basico' },
  proteina_saciedad: { title: 'Proteína y saciedad: por qué importa y cómo repartirla', level: 'intermedio' },
  fibra: { title: 'Fibra: la gran olvidada', level: 'intermedio' },
  hambre_emocional: { title: 'Hambre física vs hambre emocional', level: 'intermedio' },
  finde_social: { title: 'Fines de semana y situaciones sociales', level: 'intermedio' },
  alcohol: { title: 'Alcohol y nutrición', level: 'intermedio' },
  deficit_musculo: { title: 'Déficit calórico sin perder músculo', level: 'avanzado' },
  recomposicion: { title: 'Recomposición corporal', level: 'avanzado' },
  retencion_liquido: { title: 'Retención de líquidos: qué es y por qué pasa', level: 'avanzado' },
  interpretar_peso: { title: 'Cómo interpretar las variaciones de peso en la balanza', level: 'avanzado' },
  usar_bot: { title: 'Cómo usar el bot de nutrición al máximo', level: 'avanzado' },
};

const TUTORIAL_LEVEL_TOPICS = {
  basico: ['calorias', 'macros', 'armar_plato', 'etiquetas', 'comer_mejor'],
  intermedio: ['proteina_saciedad', 'fibra', 'hambre_emocional', 'finde_social', 'alcohol'],
  avanzado: ['deficit_musculo', 'recomposicion', 'retencion_liquido', 'interpretar_peso', 'usar_bot'],
};

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

function recordIntakeParseTrace(userId = '', trace = {}) {
  const normalizedUserId = String(userId || '').trim();
  if (!normalizedUserId) return;
  addNutritionUsageRecord(normalizedUserId, {
    guidedAction: 'log_intake_parse_trace',
    model: String(trace.stage || 'unknown').trim() || 'unknown',
    rawUsage: {
      ok: Boolean(trace.ok),
      stage: String(trace.stage || 'unknown').trim() || 'unknown',
      reasonCode: String(trace.reasonCode || '').trim() || null,
      latencyMs: Number.isFinite(Number(trace.latencyMs)) ? Math.round(Number(trace.latencyMs)) : null,
      hasMedia: Boolean(trace.hasMedia),
      isBatch: Boolean(trace.isBatch),
      unresolvedCount: Number(trace.unresolvedCount) || 0,
      at: new Date().toISOString(),
    },
  });
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

function toPositiveIntOrNull(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.trunc(parsed);
}

function formatIntakeIdPrefix(row = {}) {
  const id = toPositiveIntOrNull(row?.id);
  if (!id) return '';
  return `ID ${id} | `;
}

function attachInsertedIdsToRows(rows = [], insertedIds = []) {
  if (!Array.isArray(rows) || !rows.length) return [];
  const safeInsertedIds = Array.isArray(insertedIds) ? insertedIds : [];
  return rows.map((row, index) => {
    const intakeId = toPositiveIntOrNull(safeInsertedIds[index]);
    if (!intakeId) return row;
    return {
      ...row,
      id: intakeId,
    };
  });
}

function formatIntakeDetailLine(row = {}, { includeTime = false, includeConfidence = false } = {}) {
  const food = String(row?.foodItem || '').trim() || 'item';
  const quantity = formatQuantityText(row?.quantityValue, row?.quantityUnit);
  const kcal = formatNumberCompact(row?.caloriesKcal);
  const protein = formatNumberCompact(row?.proteinG);
  const carbs = formatNumberCompact(row?.carbsG);
  const fat = formatNumberCompact(row?.fatG);
  const confidence = normalizeConfidenceLabel(row?.confidence, 'media');
  const idPrefix = formatIntakeIdPrefix(row);
  const timePrefix = includeTime && row?.localTime ? `${row.localTime} | ` : '';
  const confidenceSuffix = includeConfidence ? ` | Conf: ${confidence}` : '';
  return `- ${idPrefix}${timePrefix}${food} (${quantity}) | ${kcal} kcal | P ${protein} g | C ${carbs} g | G ${fat} g${confidenceSuffix}`;
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

function looksLikeDeleteIntent(text = '') {
  const normalized = String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  return /\b(borra|borro|borrar|elimina|eliminar|deshacer|deshace|undo|el ultimo|la ultima|lo ultimo|esa ingesta|esa comida|ese registro|ese pesaje|ese peso|el ultimo registro|la ultima ingesta|el ultimo pesaje)\b/.test(
    normalized
  );
}

function parseIntakeIdFromText(text = '') {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const directIdMatch =
    raw.match(/\b(?:ingesta\s*)?(?:id|#)\s*[:=]?\s*(\d{1,12})\b/i) ||
    raw.match(/\bingesta\s+(\d{1,12})\b/i);
  if (!directIdMatch) return null;
  return toPositiveIntOrNull(directIdMatch[1]);
}

function looksLikeIntakeModifyIntent(text = '') {
  const normalized = String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
  if (!normalized) return false;
  return (
    /^(modificar|modifica|modif|editar|edita|ajustar|ajusta|corregir|corregi|corrige)\b/.test(
      normalized
    ) ||
    /\b(modificar|editar|ajustar|corregir)\b.*\b(ingesta|comida|registro)\b/.test(normalized)
  );
}

function looksLikeFirstReference(text = '') {
  const normalized = normalizeText(text);
  if (!normalized) return false;
  return /\b(el primero|la primera|primer registro|primera ingesta)\b/.test(normalized);
}

function looksLikeLastReference(text = '') {
  const normalized = normalizeText(text);
  if (!normalized) return false;
  return /\b(el ultimo|la ultima|lo ultimo|recien|recien cargada|ultima ingesta)\b/.test(normalized);
}

function extractTargetItemTokens(text = '') {
  const normalized = normalizeText(text)
    .replace(
      /\b(modificar|modifica|modif|editar|edita|ajustar|ajusta|corregir|corregi|corrige|borrar|borra|borro|eliminar|elimina|deshacer|deshace|undo|ingesta|comida|registro|fecha|hora|real|del|de|las|los|la|el)\b/g,
      ' '
    )
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ')
    .replace(/\b\d{1,2}[:h.]\d{2}\b/g, ' ')
    .replace(/\b(?:a\s+las?\s*)?\d{1,2}\s*(?:hs?|h)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return tokenizeForIntakeMatch(normalized);
}

function resolveIntakeTargetDeterministic({
  rawMessage = '',
  candidateRows = [],
  explicitIntakeId = null,
  userTimeZone = DEFAULT_USER_TIMEZONE,
} = {}) {
  const rows = Array.isArray(candidateRows) ? candidateRows : [];
  if (!rows.length) {
    return { action: 'cannot_identify', reason: 'no_candidate_rows' };
  }

  if (Number.isFinite(Number(explicitIntakeId)) && Number(explicitIntakeId) > 0) {
    const id = Number(explicitIntakeId);
    const direct = rows.find((row) => Number(row?.id) === id);
    if (direct) {
      return { action: 'delete_single', targetId: id, reason: 'explicit_id' };
    }
    return { action: 'cannot_identify', reason: 'explicit_id_not_found' };
  }

  if (looksLikeLastReference(rawMessage)) {
    const lastId = toPositiveIntOrNull(rows[0]?.id);
    if (lastId) return { action: 'delete_last', targetId: lastId, reason: 'relative_last' };
  }
  if (looksLikeFirstReference(rawMessage)) {
    const firstId = toPositiveIntOrNull(rows[rows.length - 1]?.id);
    if (firstId) return { action: 'delete_single', targetId: firstId, reason: 'relative_first' };
  }

  const temporal = resolveTemporalContext({ rawMessage, userTimeZone });
  const itemTokens = extractTargetItemTokens(rawMessage);
  const hasItemTokens = itemTokens.length > 0;
  const hasExplicitDate = Boolean(temporal.hadExplicitDate);
  const hasExplicitTime = Boolean(temporal.hadExplicitTime);

  const scoredRows = rows
    .map((row) => {
      const rowDate = String(row?.localDate || '').trim();
      const rowTime = String(row?.localTime || '').trim();
      const rowFood = String(row?.foodItem || '').trim();
      const rowTokens = tokenizeForIntakeMatch(rowFood);
      const itemOverlapCount = countTokenOverlap(itemTokens, rowTokens);

      let score = 0;
      if (hasExplicitDate && rowDate === temporal.localDate) score += 3;
      if (hasExplicitTime && rowTime === temporal.localTime) score += 3;
      if (!hasExplicitTime && hasExplicitDate && rowDate === temporal.localDate) score += 1;
      if (itemOverlapCount > 0) score += itemOverlapCount * 2;
      if (!hasExplicitDate && !hasExplicitTime && itemOverlapCount > 0) score += 1;

      return {
        row,
        score,
        itemOverlapCount,
        dateMatch: hasExplicitDate && rowDate === temporal.localDate,
        timeMatch: hasExplicitTime && rowTime === temporal.localTime,
      };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score);

  if (!scoredRows.length) {
    return { action: 'cannot_identify', reason: 'no_deterministic_match' };
  }

  const winner = scoredRows[0];
  const second = scoredRows[1];
  const winnerId = toPositiveIntOrNull(winner?.row?.id);
  if (!winnerId) {
    return { action: 'cannot_identify', reason: 'winner_missing_id' };
  }

  const hasCloseTie =
    second &&
    Number.isFinite(Number(second.score)) &&
    Number(second.score) > 0 &&
    Number(winner.score) - Number(second.score) <= 1;
  const winnerIsWeak =
    winner.score < 3 &&
    !(winner.dateMatch && winner.timeMatch) &&
    (!hasItemTokens || winner.itemOverlapCount <= 0);
  if (hasCloseTie || winnerIsWeak) {
    return {
      action: 'cannot_identify',
      reason: hasCloseTie ? 'tie' : 'weak_match',
      candidateIds: scoredRows.slice(0, 5).map((entry) => toPositiveIntOrNull(entry?.row?.id)).filter(Boolean),
    };
  }

  return {
    action: 'delete_single',
    targetId: winnerId,
    reason: 'deterministic_match',
  };
}

function planNutritionAction({
  rawMessage = '',
  hasMedia = false,
  userTimeZone = DEFAULT_USER_TIMEZONE,
} = {}) {
  const cleanMessage = String(rawMessage || '').trim();
  const explicitIntakeId = parseIntakeIdFromText(cleanMessage);
  const modifyIntent = !hasMedia && looksLikeIntakeModifyIntent(cleanMessage);
  const deleteIntent = !hasMedia && !modifyIntent && looksLikeDeleteIntent(cleanMessage);
  const queryIntent =
    !hasMedia &&
    !modifyIntent &&
    !deleteIntent &&
    looksLikeRecentIntakesQuestion(normalizeText(cleanMessage));
  const batchIntent = !hasMedia && !modifyIntent && !deleteIntent && isLikelyBatchIntakeMessage(cleanMessage);
  const temporalHints = resolveTemporalContext({ rawMessage: cleanMessage, userTimeZone });

  let intent = 'log_intake_single';
  if (explicitIntakeId && (modifyIntent || deleteIntent)) {
    intent = modifyIntent ? 'modify_intake' : 'delete_intake';
  } else if (explicitIntakeId && !hasMedia) {
    intent = 'intake_reference';
  } else if (modifyIntent) {
    intent = 'modify_intake';
  } else if (deleteIntent) {
    intent = 'delete_intake';
  } else if (batchIntent) {
    intent = 'log_intake_batch';
  } else if (queryIntent) {
    intent = 'query_intakes';
  } else if (hasMedia) {
    intent = 'log_intake_media';
  }

  return {
    intent,
    explicitIntakeId,
    temporalHints,
    hasExplicitTemporal: Boolean(temporalHints.hadExplicitDate || temporalHints.hadExplicitTime),
    payload: cleanMessage,
    hasMedia: Boolean(hasMedia),
  };
}

async function resolveDeleteTargetWithModel({
  openai,
  modelCandidates = [],
  rawMessage = '',
  candidateRows = [],
  todayRows = [],
  entityType = 'intake',
  rowsLabel = 'de hoy',
  intentLabel = 'borrar',
} = {}) {
  const isIntake = entityType === 'intake';
  const rows = Array.isArray(candidateRows) && candidateRows.length ? candidateRows : todayRows;
  const rowLines = rows
    .map((r) => {
      if (isIntake) {
        const qty = [r.quantityValue, r.quantityUnit].filter(Boolean).join(' ');
        return `id=${r.id} | ${r.localTime || '?'} | ${r.foodItem}${qty ? ' ' + qty : ''} | ${Math.round(r.caloriesKcal || 0)} kcal`;
      }
      return `id=${r.id} | ${r.localTime || '?'} | ${r.weightKg} kg${r.bodyFatPercent ? ' grasa ' + r.bodyFatPercent + '%' : ''}`;
    })
    .join('\n');

  const instructions = [
    `Sos un asistente que identifica qué ${isIntake ? 'ingesta' : 'pesaje'} quiere ${intentLabel} el usuario.`,
    `Recibís el mensaje y la lista de registros ${rowsLabel}.`,
    'Salida: JSON puro sin markdown.',
    'Schema: {"action":"delete_single|delete_last|cannot_identify","target_id":number|null,"reason":"string"}',
    'Reglas:',
    '- Si dice "el último", "recién", "lo último" → action=delete_last',
    '- Si identifica un item por nombre, hora o descripción → action=delete_single, target_id=id del match',
    '- Si es ambiguo o no identifica ninguno → cannot_identify con reason breve',
    '- target_id debe ser un número entero del campo id de la lista',
  ].join('\n');

  const inputText = `Mensaje: "${rawMessage}"\n\nRegistros ${rowsLabel}:\n${rowLines}`;

  const smart = await createSmartResponse({
    openai,
    modelCandidates,
    instructions,
    input: [{ role: 'user', content: [{ type: 'input_text', text: inputText }] }],
  });
  const json = extractJsonObject(extractOutputText(smart.response)) || {};
  return {
    ok: true,
    model: smart.model,
    usage: extractUsageSnapshot(smart.response),
    action: String(json.action || 'cannot_identify').trim(),
    targetId: json.target_id != null ? Number(json.target_id) : null,
    reason: String(json.reason || '').trim(),
  };
}

const ONBOARDING_GOAL_MAP = {
  bajar_grasa: 'bajar grasa',
  ganar_musculo: 'ganar músculo',
  mejorar_habitos: 'mejorar hábitos',
  comer_mejor: 'comer mejor',
  mejorar_salud: 'mejorar salud y energía',
};

async function parseOnboardingTurnWithModel({
  openai,
  modelCandidates = [],
  rawMessage = '',
  existingProfile = {},
} = {}) {
  const instructions = [
    'Sos el asistente de onboarding de un bot de nutrición.',
    'Tu tarea: extraer datos del perfil del usuario y guiar el proceso de alta inicial.',
    'Salida: JSON puro sin markdown.',
    'Schema:',
    '{',
    '  "action": "continue|complete|answer_question",',
    '  "extracted": {',
    '    "main_goal": string|null,',
    '    "edad": number|null,',
    '    "sexo": string|null,',
    '    "altura_cm": number|null,',
    '    "peso_actual_kg": number|null,',
    '    "nivel_actividad": string|null,',
    '    "tipo_entrenamiento": string|null,',
    '    "frecuencia_entrenamiento": string|null,',
    '    "alergias_intolerancias": string|null,',
    '    "condicion_salud": string|null,',
    '    "dificultad_principal": string|null,',
    '    "target_calories_kcal": number|null,',
    '    "target_protein_g": number|null',
    '  },',
    '  "next_question": string,',
    '  "answer_text": string',
    '}',
    'Reglas:',
    '- Si el mensaje comienza con "goal:" es la selección de objetivo del botón (ej: "goal:bajar_grasa"). Mapeá a main_goal y continuá.',
    '- action=complete cuando tengas al menos: main_goal + peso_actual_kg + nivel_actividad.',
    '- Si falta info importante, usar action=continue y hacer máximo 2 preguntas en next_question. Tono amigable y conciso.',
    '- Si el usuario hace una pregunta nutricional en lugar de dar datos: action=answer_question, answer_text=respuesta breve (max 3 líneas), next_question=retomá donde estabas.',
    '- En extracted, solo incluir campos que el usuario mencionó en este turno (null para el resto, NO sobreescribir con null).',
    '- sexo: usar "masculino" o "femenino" o lo que el usuario diga.',
    '- nivel_actividad: normalizar a sedentario/poco_activo/moderadamente_activo/muy_activo.',
  ].join('\n');

  const profileSummary = {
    main_goal: existingProfile?.mainGoal || null,
    edad: existingProfile?.edad || null,
    peso_actual_kg: existingProfile?.pesoActualKg || null,
    nivel_actividad: existingProfile?.nivelActividad || null,
    altura_cm: existingProfile?.alturaCm || null,
    alergias_intolerancias: existingProfile?.alergiasIntolerancias || null,
  };

  const inputText = `Perfil acumulado hasta ahora: ${JSON.stringify(profileSummary)}\n\nMensaje del usuario: ${rawMessage}`;

  const smart = await createSmartResponse({
    openai,
    modelCandidates,
    instructions,
    input: [{ role: 'user', content: [{ type: 'input_text', text: inputText }] }],
  });
  const json = extractJsonObject(extractOutputText(smart.response)) || {};
  return {
    ok: true,
    model: smart.model,
    usage: extractUsageSnapshot(smart.response),
    action: String(json.action || 'continue').trim(),
    extracted: json.extracted || {},
    nextQuestion: String(json.next_question || '').trim(),
    answerText: String(json.answer_text || '').trim(),
  };
}

function formatOnboardingSummary(profile = {}) {
  const lines = ['✅ Perfil inicial guardado.'];
  if (profile.mainGoal) lines.push(`- Objetivo: ${profile.mainGoal}`);
  const bodyParts = [];
  if (profile.pesoActualKg) bodyParts.push(`Peso: ${profile.pesoActualKg} kg`);
  if (profile.alturaCm) bodyParts.push(`Altura: ${profile.alturaCm} cm`);
  if (profile.edad) bodyParts.push(`Edad: ${profile.edad}`);
  if (bodyParts.length) lines.push(`- ${bodyParts.join(' | ')}`);
  if (profile.nivelActividad) lines.push(`- Actividad: ${profile.nivelActividad}`);
  if (profile.alergiasIntolerancias) lines.push(`- Restricciones: ${profile.alergiasIntolerancias}`);
  const targets = [];
  if (profile.targetCaloriesKcal) targets.push(`${Math.round(profile.targetCaloriesKcal)} kcal`);
  if (profile.targetProteinG) targets.push(`${Math.round(profile.targetProteinG)} g proteína`);
  if (targets.length) lines.push(`- Target: ${targets.join(' | ')}`);
  else lines.push('- (Podés configurar tu target con "target 2200 kcal" en Perfil/objetivos)');
  return lines.join('\n');
}

function suggestTutorialsForGoal(mainGoal = '') {
  const goal = String(mainGoal || '').toLowerCase();
  let topics = [];
  if (goal.includes('grasa') || goal.includes('bajar') || goal.includes('deficit')) {
    topics = ['Calorías y déficit', 'Proteína y saciedad', 'Cómo interpretar el peso en la balanza'];
  } else if (goal.includes('músculo') || goal.includes('musculo') || goal.includes('volumen') || goal.includes('ganar')) {
    topics = ['Proteína: cuánto y cómo distribuirla', 'Recomposición corporal', 'Cómo armar un plato equilibrado'];
  } else {
    topics = ['Qué son las calorías', 'Cómo armar un plato equilibrado', 'Comer mejor sin contar todo'];
  }
  return [
    '',
    '📚 Te recomiendo empezar por estos tutoriales:',
    ...topics.map((t) => `- ${t}`),
    'Encontrás todos en el módulo Aprendizaje.',
  ].join('\n');
}

function buildTutorialLevelMenu(level = '') {
  const topics = TUTORIAL_LEVEL_TOPICS[level] || [];
  if (!topics.length) {
    return 'Elegí un nivel de tutoriales: Básico, Intermedio o Avanzado.';
  }
  const levelLabel = { basico: 'Básico', intermedio: 'Intermedio', avanzado: 'Avanzado' }[level] || level;
  const lines = [`📚 Tutoriales — Nivel ${levelLabel}:`];
  for (const slug of topics) {
    const meta = TUTORIAL_CONTENT_MAP[slug];
    if (meta) lines.push(`- ${meta.title}`);
  }
  lines.push('');
  lines.push('Usá los botones para abrir cada tema, o escribí tu pregunta directamente.');
  return lines.join('\n');
}

async function generateTutorialContentWithModel({
  openai,
  modelCandidates = [],
  title = '',
  userProfile = {},
} = {}) {
  const profileHint = [
    userProfile?.mainGoal ? `objetivo: ${userProfile.mainGoal}` : null,
    userProfile?.nivelActividad ? `actividad: ${userProfile.nivelActividad}` : null,
  ]
    .filter(Boolean)
    .join(', ');

  const instructions = [
    'Sos un educador nutricional conciso para un bot de Telegram.',
    'Explicá el tema en 5-8 líneas. Luego agregá 2-3 tips prácticos con guión.',
    'Tono: claro, sin tecnicismos innecesarios, directo.',
    'No uses markdown pesado. No diagnósticos ni prescripciones médicas.',
    profileHint ? `Perfil del usuario: ${profileHint}. Si es relevante, personalizá levemente.` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const smart = await createSmartResponse({
    openai,
    modelCandidates,
    instructions,
    input: [{ role: 'user', content: [{ type: 'input_text', text: `Tema: ${title}` }] }],
  });
  return {
    ok: true,
    model: smart.model,
    usage: extractUsageSnapshot(smart.response),
    content: extractOutputText(smart.response) || '',
  };
}

async function performPersonalizedAnalysisWithModel({
  openai,
  modelCandidates = [],
  profile = {},
  summary = {},
  recentIntakes = [],
  weighinHistory = [],
  userMessage = '',
} = {}) {
  const profileLines = [
    profile.mainGoal ? `Objetivo: ${profile.mainGoal}` : null,
    profile.edad ? `Edad: ${profile.edad}` : null,
    profile.sexo ? `Sexo: ${profile.sexo}` : null,
    profile.alturaCm ? `Altura: ${profile.alturaCm} cm` : null,
    profile.pesoActualKg ? `Peso registrado en perfil: ${profile.pesoActualKg} kg` : null,
    profile.nivelActividad ? `Actividad: ${profile.nivelActividad}` : null,
    profile.tipoEntrenamiento ? `Entrenamiento: ${profile.tipoEntrenamiento}` : null,
    profile.frecuenciaEntrenamiento ? `Frecuencia: ${profile.frecuenciaEntrenamiento}` : null,
    profile.alergiasIntolerancias ? `Restricciones: ${profile.alergiasIntolerancias}` : null,
    profile.condicionSalud ? `Condición de salud: ${profile.condicionSalud}` : null,
    profile.dificultadPrincipal ? `Principal dificultad: ${profile.dificultadPrincipal}` : null,
    profile.targetCaloriesKcal ? `Target kcal: ${profile.targetCaloriesKcal}` : null,
    profile.targetProteinG ? `Target proteína: ${profile.targetProteinG} g` : null,
  ].filter(Boolean).join('\n');

  const todayLine = summary.today
    ? `Hoy: ${Math.round(summary.today.caloriesKcal || 0)} kcal | P ${Math.round(summary.today.proteinG || 0)}g | C ${Math.round(summary.today.carbsG || 0)}g | G ${Math.round(summary.today.fatG || 0)}g`
    : 'Sin datos de hoy';
  const rolling7Line = summary.rolling7d
    ? `Prom 7d: ${Math.round(summary.rolling7d.caloriesKcal || 0)} kcal | P ${Math.round(summary.rolling7d.proteinG || 0)}g`
    : null;
  const rolling14Line = summary.rolling14d
    ? `Prom 14d: ${Math.round(summary.rolling14d.caloriesKcal || 0)} kcal | P ${Math.round(summary.rolling14d.proteinG || 0)}g`
    : null;

  const intakesPreview = recentIntakes
    .slice(0, 20)
    .map((r) => `  ${r.localDate} ${r.localTime || ''} ${r.foodItem} | ${Math.round(r.caloriesKcal || 0)} kcal | P ${Math.round(r.proteinG || 0)}g`)
    .join('\n');

  const weighinPreview = weighinHistory
    .slice(0, 7)
    .map((w) => `  ${w.localDate}: ${w.weightKg} kg${w.bodyFatPercent ? ` | grasa ${w.bodyFatPercent}%` : ''}`)
    .join('\n');

  const contextBlock = [
    '=== PERFIL ===',
    profileLines || '(sin perfil completo)',
    '',
    '=== RESUMEN NUTRICIONAL ===',
    todayLine,
    rolling7Line,
    rolling14Line,
    '',
    '=== ÚLTIMAS INGESTAS ===',
    intakesPreview || '(sin ingestas recientes)',
    '',
    '=== HISTORIAL DE PESO ===',
    weighinPreview || '(sin pesajes registrados)',
  ].filter(Boolean).join('\n');

  const isFollowUp = Boolean(userMessage && !userMessage.startsWith('__analysis__'));

  const instructions = [
    'Sos un nutricionista con formación universitaria y experiencia clínica.',
    'Tu tarea: hacer un análisis personalizado del usuario en base a su perfil y datos de seguimiento.',
    '',
    'Si es el análisis inicial (sin mensaje del usuario):',
    '- Empezá con 1-2 líneas de contexto general del usuario.',
    '- Identificá 2-3 puntos fuertes concretos (con datos).',
    '- Identificá 2-3 áreas de mejora prioritarias (con datos).',
    '- Terminá con 1-2 recomendaciones accionables para la próxima semana.',
    '- Extensión: 15-20 líneas. Tono: profesional pero cercano. Sin diagnósticos médicos.',
    '',
    'Si es una pregunta de seguimiento del usuario:',
    '- Respondé específicamente la consulta usando los datos del contexto.',
    '- Máximo 8 líneas. Directo y útil.',
    '',
    'Reglas generales:',
    '- Usá los datos reales disponibles. Si hay pocos datos, decilo brevemente y dale igual valor.',
    '- No inventes datos ni estimes sin base.',
    '- No diagnosticues ni prescribas medicación.',
    '- Responde en español.',
  ].join('\n');

  const userInput = isFollowUp
    ? `${contextBlock}\n\n=== PREGUNTA DEL USUARIO ===\n${userMessage}`
    : contextBlock;

  const smart = await createSmartResponse({
    openai,
    modelCandidates,
    instructions,
    input: [{ role: 'user', content: [{ type: 'input_text', text: userInput }] }],
  });
  return {
    ok: true,
    model: smart.model,
    usage: extractUsageSnapshot(smart.response),
    content: extractOutputText(smart.response) || '',
  };
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

const NUTRITION_MATCH_STOPWORDS = new Set([
  'a',
  'al',
  'con',
  'de',
  'del',
  'el',
  'en',
  'hs',
  'h',
  'ingesta',
  'la',
  'las',
  'lo',
  'los',
  'por',
  'registra',
  'registrame',
  'registrar',
  'registra',
  'suma',
  'sumae',
  'taza',
  'tazon',
  'porcion',
  'porciones',
  'unidad',
  'unidades',
  'cucharada',
  'cucharadas',
  'natural',
  'sin',
  'azucar',
  'hoy',
  'ayer',
  'manana',
  'desayuno',
  'almuerzo',
  'merienda',
  'cena',
]);

function tokenizeForIntakeMatch(value = '') {
  const normalized = normalizeCatalogToken(value)
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return [];
  return normalized
    .split(' ')
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => {
      if (token.length > 4 && token.endsWith('es')) return token.slice(0, -2);
      if (token.length > 3 && token.endsWith('s')) return token.slice(0, -1);
      return token;
    })
    .filter((token) => token.length >= 3 && !NUTRITION_MATCH_STOPWORDS.has(token));
}

function countTokenOverlap(itemTokens = [], messageTokens = []) {
  if (!Array.isArray(itemTokens) || !itemTokens.length) return 0;
  if (!Array.isArray(messageTokens) || !messageTokens.length) return 0;
  let overlap = 0;
  for (const itemToken of itemTokens) {
    for (const messageToken of messageTokens) {
      if (itemToken === messageToken) {
        overlap += 1;
        break;
      }
      if (
        itemToken.length >= 4 &&
        messageToken.length >= 4 &&
        (itemToken.startsWith(messageToken) || messageToken.startsWith(itemToken))
      ) {
        overlap += 1;
        break;
      }
    }
  }
  return overlap;
}

function hasApproxTokenOverlap(itemTokens = [], messageTokens = []) {
  if (!Array.isArray(itemTokens) || !itemTokens.length) return false;
  if (!Array.isArray(messageTokens) || !messageTokens.length) return false;

  for (const itemToken of itemTokens) {
    for (const messageToken of messageTokens) {
      if (itemToken === messageToken) return true;
      if (
        itemToken.length >= 4 &&
        messageToken.length >= 4 &&
        (itemToken.startsWith(messageToken) || messageToken.startsWith(itemToken))
      ) {
        return true;
      }
    }
  }
  return false;
}

function parseCompactNumber(value = '') {
  const parsed = Number(String(value || '').replace(',', '.').trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function quantityMatchesWithTolerance(messageQuantity = null, itemQuantity = null) {
  const left = Number(messageQuantity);
  const right = Number(itemQuantity);
  if (!Number.isFinite(left) || !Number.isFinite(right) || right <= 0) return false;
  const delta = Math.abs(left - right);
  const relative = delta / Math.max(Math.abs(left), Math.abs(right), 1);
  return delta <= 0.15 || relative <= 0.1;
}

function extractQuantityHints(rawMessage = '') {
  const raw = String(rawMessage || '');
  if (!raw.trim()) return [];
  const quantityRegex =
    /\b(\d+(?:\s*\/\s*\d+)?(?:[.,]\d+)?|media|medio|un\s+medio|una\s+media|un\s+cuarto|una\s+cuarta|cuarto|un\s+tercio|tercio|tres\s+cuartos)\s*(kg|kilos?|kilogramos?|g|gr|gramos?|ml|cc|l|litros?|u|unidad(?:es)?|porciones?|platos?|bochas?|tazas?|vasos?|scoops?|huevos?|rodajas?|cucharadas?|cucharaditas?)\b/giu;
  const normalizedMap = {
    kilo: 'kg',
    kilos: 'kg',
    kilogramo: 'kg',
    kilogramos: 'kg',
    kg: 'kg',
    gr: 'g',
    gramo: 'g',
    gramos: 'g',
    g: 'g',
    litro: 'l',
    litros: 'l',
    l: 'l',
    ml: 'ml',
    cc: 'cc',
    u: 'unidad',
    unidad: 'unidad',
    unidades: 'unidad',
    porcion: 'porcion',
    porciones: 'porcion',
    plato: 'plato',
    platos: 'plato',
    bocha: 'bocha',
    bochas: 'bocha',
    taza: 'taza',
    tazas: 'taza',
    vaso: 'vaso',
    vasos: 'vaso',
    scoop: 'scoop',
    scoops: 'scoop',
    huevo: 'huevo',
    huevos: 'huevo',
    rodaja: 'rodaja',
    rodajas: 'rodaja',
    cucharada: 'cucharada',
    cucharadas: 'cucharada',
    cucharadita: 'cucharadita',
    cucharaditas: 'cucharadita',
  };
  const fractionMap = {
    media: 0.5,
    medio: 0.5,
    'un medio': 0.5,
    'una media': 0.5,
    'un cuarto': 0.25,
    'una cuarta': 0.25,
    cuarto: 0.25,
    'un tercio': 1 / 3,
    tercio: 1 / 3,
    'tres cuartos': 0.75,
  };
  const hints = [];
  for (const match of raw.matchAll(quantityRegex)) {
    const quantityRaw = String(match?.[1] || '').trim();
    const unitRaw = normalizeText(match?.[2] || '');
    if (!quantityRaw || !unitRaw) continue;
    let quantity = fractionMap[normalizeText(quantityRaw)];
    if (!Number.isFinite(Number(quantity))) {
      const compact = normalizeText(quantityRaw).replace(/\s+/g, '');
      if (/^\d+\/\d+$/.test(compact)) {
        const [numRaw, denRaw] = compact.split('/');
        const num = Number(numRaw);
        const den = Number(denRaw);
        quantity = Number.isFinite(num) && Number.isFinite(den) && den > 0 ? num / den : null;
      } else {
        quantity = parseCompactNumber(quantityRaw);
      }
    }
    if (!Number.isFinite(Number(quantity)) || Number(quantity) <= 0) continue;
    hints.push({
      quantity: Number(quantity),
      unit: normalizedMap[unitRaw] || unitRaw,
    });
  }
  return hints;
}

function evaluateParsedItemsAlignment({ rawMessage = '', parsedItems = [] } = {}) {
  const messageTokens = tokenizeForIntakeMatch(rawMessage);
  if (!messageTokens.length) {
    return {
      aligned: true,
      score: 1,
      reason: 'no_message_tokens',
      tokenOverlapRatio: 1,
      quantityMatchRatio: 1,
    };
  }
  if (!Array.isArray(parsedItems) || !parsedItems.length) {
    return {
      aligned: false,
      score: 0,
      reason: 'no_parsed_items',
      tokenOverlapRatio: 0,
      quantityMatchRatio: 0,
    };
  }

  const quantityHints = extractQuantityHints(rawMessage);
  const hasQuantityHints = quantityHints.length > 0;
  let rowsWithTokenOverlap = 0;
  let catalogRowsWithoutOverlap = 0;
  let rowsWithQuantityMatch = 0;
  let hasCatalogAliasResolvedMismatch = false;
  let parsedItemsWithQuantity = 0;

  for (const item of parsedItems) {
    const aliasTokens = tokenizeForIntakeMatch(String(item?.inputAlias || '').trim());
    const resolvedTokens = tokenizeForIntakeMatch(String(item?.foodItem || '').trim());
    const aliasOverlapCount = countTokenOverlap(aliasTokens, messageTokens);
    const resolvedOverlapCount = countTokenOverlap(resolvedTokens, messageTokens);
    const maxOverlapCount = Math.max(aliasOverlapCount, resolvedOverlapCount);
    const hasCatalogResolution =
      Number.isFinite(Number(item?.catalogItemId)) && Number(item?.catalogItemId) > 0
        ? true
        : normalizeCatalogToken(item?.resolutionMode || '') === 'catalog';

    const catalogAliasResolvedMismatch =
      hasCatalogResolution &&
      aliasTokens.length > 0 &&
      resolvedTokens.length > 0 &&
      aliasOverlapCount > 0 &&
      resolvedOverlapCount === 0;

    if (maxOverlapCount > 0) {
      rowsWithTokenOverlap += 1;
    } else if (hasCatalogResolution) {
      catalogRowsWithoutOverlap += 1;
    }
    if (catalogAliasResolvedMismatch) {
      hasCatalogAliasResolvedMismatch = true;
      catalogRowsWithoutOverlap += 1;
    }

    if (hasQuantityHints) {
      const itemQuantity = Number(item?.quantityValue);
      const itemUnit = normalizeCatalogToken(item?.quantityUnit || '');
      if (Number.isFinite(itemQuantity) && itemQuantity > 0) {
        parsedItemsWithQuantity += 1;
      }
      const matchedQuantity = quantityHints.some((hint) => {
        const hintUnit = normalizeCatalogToken(hint.unit || '');
        const compatibleUnit =
          !hintUnit ||
          !itemUnit ||
          hintUnit === itemUnit ||
          (hintUnit === 'g' && itemUnit === 'gramo') ||
          (hintUnit === 'unidad' && itemUnit === 'porcion');
        if (!compatibleUnit) return false;
        return quantityMatchesWithTolerance(hint.quantity, itemQuantity);
      });
      if (matchedQuantity) {
        rowsWithQuantityMatch += 1;
      }
    }
  }

  const tokenOverlapRatio = rowsWithTokenOverlap / Math.max(parsedItems.length, 1);
  const canValidateQuantity = parsedItemsWithQuantity > 0;
  const quantityMatchRatio = hasQuantityHints && canValidateQuantity
    ? rowsWithQuantityMatch / Math.max(quantityHints.length, 1)
    : 1;
  const penalizedByCatalogHijack = catalogRowsWithoutOverlap > 0;
  const baseScore = hasQuantityHints
    ? tokenOverlapRatio * 0.7 + quantityMatchRatio * 0.3
    : tokenOverlapRatio;
  const score = Math.max(0, baseScore - (penalizedByCatalogHijack ? 0.25 : 0));
  const aligned =
    score >= 0.55 &&
    rowsWithTokenOverlap > 0 &&
    !hasCatalogAliasResolvedMismatch &&
    (!hasQuantityHints || !canValidateQuantity || rowsWithQuantityMatch > 0 || quantityHints.length > 1);

  return {
    aligned,
    score,
    reason: aligned
      ? 'ok'
      : hasCatalogAliasResolvedMismatch
        ? 'catalog_alias_resolved_mismatch'
      : penalizedByCatalogHijack
        ? 'catalog_without_overlap'
        : hasQuantityHints && rowsWithQuantityMatch === 0
          ? 'quantity_mismatch'
          : 'low_overlap',
    tokenOverlapRatio,
    quantityMatchRatio,
  };
}

function parsedItemsAlignWithUserInput({ rawMessage = '', parsedItems = [] } = {}) {
  return evaluateParsedItemsAlignment({ rawMessage, parsedItems }).aligned;
}

function parsedItemsHaveAnyUserOverlap({ rawMessage = '', parsedItems = [] } = {}) {
  const messageTokens = tokenizeForIntakeMatch(rawMessage);
  if (!messageTokens.length) return true;
  if (!Array.isArray(parsedItems) || !parsedItems.length) return false;

  for (const item of parsedItems) {
    const aliasTokens = tokenizeForIntakeMatch(String(item?.inputAlias || '').trim());
    const resolvedTokens = tokenizeForIntakeMatch(String(item?.foodItem || '').trim());
    if (hasApproxTokenOverlap(aliasTokens, messageTokens)) return true;
    if (hasApproxTokenOverlap(resolvedTokens, messageTokens)) return true;
  }
  return false;
}

function enforceExplicitTemporalFromRawMessage({
  rawMessage = '',
  userTimeZone = DEFAULT_USER_TIMEZONE,
  parsed = null,
} = {}) {
  if (!parsed || !parsed.temporal) return parsed;
  const rawTemporal = resolveTemporalContext({
    rawMessage,
    userTimeZone,
  });
  if (rawTemporal.usedRuntimeNow) {
    return parsed;
  }
  const parsedTemporal = parsed.temporal || {};
  if (!parsedTemporal.usedRuntimeNow) {
    return parsed;
  }
  return {
    ...parsed,
    temporal: {
      ...parsedTemporal,
      localDate: rawTemporal.localDate,
      localTime: rawTemporal.localTime,
      loggedAt: rawTemporal.loggedAt,
      timeZone: rawTemporal.timeZone,
      usedRuntimeNow: false,
    },
  };
}

function buildIntakeSemanticMismatchReply() {
  return [
    'No quiero registrar algo distinto a lo que escribiste.',
    'Reenviamelo en una sola línea por item, por ejemplo: `13:40 1 taza granola natural`.',
    'Si fue un producto de paquete, podés mandar foto de etiqueta para mayor precisión.',
  ].join('\n');
}

function itemUsesEstimatedResolution(item = {}) {
  const resolutionMode = normalizeCatalogToken(item?.resolutionMode || '');
  if (resolutionMode === 'estimate') return true;
  const source = normalizeCatalogToken(item?.source || '');
  return source === 'estimacion gpt' || source === 'estimacion_gpt';
}

function parsedHasEstimatedRows(parsed = null) {
  return Boolean(
    parsed?.items?.some((item) => itemUsesEstimatedResolution(item))
  );
}

function tryRepairParsedFromStructured({
  rawMessage = '',
  userTimeZone = DEFAULT_USER_TIMEZONE,
  modelStructured = null,
  userId = '',
  catalogRows = [],
  userDefaultRows = [],
} = {}) {
  if (String(modelStructured?.action || '') !== 'log_intake') return null;
  if (!Array.isArray(modelStructured?.items) || !modelStructured.items.length) return null;

  const rebuilt = buildParsedIntakeFromStructured({
    userId,
    rawMessage,
    userTimeZone,
    structured: modelStructured,
    catalogRows,
    userDefaultRows,
    inferenceSource: 'text_structured',
  });
  if (!rebuilt?.ok) return null;
  const enforcedTemporal = enforceExplicitTemporalFromRawMessage({
    rawMessage,
    userTimeZone,
    parsed: rebuilt,
  });
  const aligned = parsedItemsAlignWithUserInput({
    rawMessage,
    parsedItems: enforcedTemporal?.items || [],
  });
  if (!aligned) return null;
  return enforcedTemporal;
}

function stripBatchListPrefix(line = '') {
  return String(line || '')
    .replace(/^\s*(?:[-*•]+\s+|\d+\s*[).-]\s+)\s*/u, '')
    .trim();
}

function hasExplicitDateHintInText(text = '') {
  const raw = String(text || '');
  const normalized = normalizeText(raw);
  if (!normalized) return false;
  if (/\b(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b/.test(raw)) return true;
  if (/\b(\d{1,2})[/.](\d{1,2})[/.](20\d{2})\b/.test(raw)) return true;
  if (
    new RegExp(
      `\\b\\d{1,2}\\s*(?:de\\s+)?(?:${SPANISH_MONTH_HINT_PATTERN})(?:\\s*(?:de)?\\s*20\\d{2})?\\b`,
      'i'
    ).test(normalized)
  ) {
    return true;
  }
  return /\b(hoy|ayer)\b/.test(normalized);
}

function hasExplicitTimeHintInText(text = '') {
  const raw = String(text || '');
  if (!raw.trim()) return false;
  if (/\b([01]?\d|2[0-3])[:h.]([0-5]\d)\s*(?:hs?|h)?\b/i.test(raw)) return true;
  if (/\b(?:a\s+las?\s*)([01]?\d|2[0-3])\s*(?:hs?|h)\b/i.test(raw)) return true;
  if (/\b([01]?\d|2[0-3])\s*(?:hs|h)\b/i.test(raw)) return true;
  return /\b([01]?\d|2[0-3])\s*h\b/i.test(raw);
}

function looksLikeBatchHeaderLine(line = '') {
  const raw = String(line || '').trim();
  const normalized = normalizeText(raw);
  if (!normalized) return true;

  if (/(^|\s)(ingestas?|comidas?|resumen|registro)\b/.test(normalized) && /:\s*$/u.test(raw)) {
    return true;
  }
  if (/^(fecha|dia|día)\b/.test(normalized) && /:\s*$/u.test(raw)) {
    return true;
  }
  if (
    /^(ingestas?|comidas?)\b/.test(normalized) &&
    !hasExplicitTimeHintInText(raw) &&
    !/\b\d+\s*(g|gr|gramos?|ml|cc|kg|porcion(?:es)?|plato(?:s)?|bocha(?:s)?|huevo(?:s)?|taza(?:s)?|vaso(?:s)?|scoop(?:s)?|unidad(?:es)?)\b/u.test(
      normalized
    )
  ) {
    return true;
  }

  return false;
}

function extractBatchIntakeLines(rawMessage = '') {
  const raw = String(rawMessage || '');
  const lines = raw
    .split(/\r?\n/u)
    .map((line) => stripBatchListPrefix(line))
    .filter(Boolean);
  return lines.filter((line) => !looksLikeBatchHeaderLine(line));
}

function isLikelyBatchIntakeMessage(rawMessage = '') {
  const lines = extractBatchIntakeLines(rawMessage);
  if (lines.length < 2) return false;

  const linesWithTime = lines.filter((line) => hasExplicitTimeHintInText(line)).length;
  if (linesWithTime >= 2) return true;

  const mealCueLines = lines.filter((line) =>
    /\b(desayuno|almuerzo|merienda|cena|colacion|colación)\b/u.test(normalizeText(line))
  ).length;
  return lines.length >= 3 && (linesWithTime >= 1 || mealCueLines >= 2);
}

function applyBatchDateContextToLine(line = '', localDate = '') {
  const cleanLine = String(line || '').trim();
  const cleanDate = String(localDate || '').trim();
  if (!cleanLine) return '';
  if (!cleanDate) return cleanLine;
  if (hasExplicitDateHintInText(cleanLine)) return cleanLine;
  return `${cleanDate} ${cleanLine}`.trim();
}

async function parseSingleIntakeTextWithModels({
  openai,
  modelCandidates = [],
  rawMessage = '',
  alignmentMessage = '',
  userId = '',
  userTimeZone = DEFAULT_USER_TIMEZONE,
  catalogRowsForParsing = [],
  userDefaultRows = [],
  userCatalogHistoryRows = [],
  catalogRowsForNormalization = [],
  preferLexicalFirst = false,
} = {}) {
  const lineMessage = String(rawMessage || '').trim();
  const alignmentInput = String(alignmentMessage || lineMessage).trim() || lineMessage;
  if (!lineMessage) {
    return { ok: false, error: 'empty_input' };
  }

  let parsed = null;
  let lexicalParsed = null;
  let modelStructured = null;
  let modelNormalization = null;
  let usage = null;

  const parseLexical = () => {
    lexicalParsed = parseIntakePayload({
      rawMessage: lineMessage,
      userTimeZone,
    });
    if (!lexicalParsed?.ok) {
      return null;
    }
    const enforced = enforceExplicitTemporalFromRawMessage({
      rawMessage: lineMessage,
      userTimeZone,
      parsed: lexicalParsed,
    });
    const aligned = parsedItemsAlignWithUserInput({
      rawMessage: alignmentInput,
      parsedItems: enforced?.items || [],
    });
    if (!aligned) return null;
    return enforced;
  };

  if (preferLexicalFirst && !NUTRITION_LLM_FIRST_PARSING) {
    parsed = parseLexical();
  }

  if (!parsed) {
    try {
      modelStructured = await parseStructuredIntakeWithModel({
        openai,
        modelCandidates,
        rawMessage: lineMessage,
        userTimeZone,
        catalogRows: catalogRowsForParsing,
        userDefaultRows,
        userCatalogHistoryRows,
      });
      usage = mergeUsageSnapshots(usage, modelStructured?.usage);
    } catch (structuredError) {
      console.error('[nutrition-runtime] structured intake parser failed', structuredError);
    }
  }

  if (!parsed && modelStructured?.action === 'log_intake' && modelStructured.items?.length) {
    const parsedFromStructured = buildParsedIntakeFromStructured({
      userId,
      rawMessage: lineMessage,
      userTimeZone,
      structured: modelStructured,
      catalogRows: catalogRowsForParsing,
      userDefaultRows,
      inferenceSource: 'text_structured',
    });
    if (parsedFromStructured.ok) {
      parsed = enforceExplicitTemporalFromRawMessage({
        rawMessage: lineMessage,
        userTimeZone,
        parsed: parsedFromStructured,
      });
    }
  }

  if (!parsed) {
    try {
      modelNormalization = await normalizeIntakeWithModel({
        openai,
        modelCandidates,
        rawMessage: lineMessage,
        userTimeZone,
        catalogCandidates: catalogRowsForNormalization,
      });
      usage = mergeUsageSnapshots(usage, modelNormalization?.usage);
    } catch (normalizationError) {
      console.error('[nutrition-runtime] intake normalization failed', normalizationError);
    }
  }

  if (!parsed && modelNormalization?.action === 'normalize_intake' && modelNormalization.normalizedText) {
    const parsedFromModel = parseIntakePayload({
      rawMessage: modelNormalization.normalizedText,
      userTimeZone,
    });
    if (parsedFromModel.ok) {
      parsed = enforceExplicitTemporalFromRawMessage({
        rawMessage: lineMessage,
        userTimeZone,
        parsed: parsedFromModel,
      });
    }
  }

  if (!parsed && (!preferLexicalFirst || NUTRITION_LLM_FIRST_PARSING)) {
    parsed = parseLexical();
  }

  if (!parsed && !lexicalParsed?.ok) {
    lexicalParsed = parseIntakePayload({
      rawMessage: lineMessage,
      userTimeZone,
    });
  }

  if (!parsed) {
    return {
      ok: false,
      error: String(lexicalParsed?.error || 'parse_failed').trim() || 'parse_failed',
      usage,
      modelStructured,
      modelNormalization,
      lexicalParsed,
    };
  }

  if (NUTRITION_STRICT_SEMANTIC_GUARDRAIL) {
    const alignedWithUserInput = parsedItemsAlignWithUserInput({
      rawMessage: alignmentInput,
      parsedItems: parsed?.items || [],
    });
    if (!alignedWithUserInput) {
      const repaired = tryRepairParsedFromStructured({
        rawMessage: lineMessage,
        userTimeZone,
        modelStructured,
        userId,
        catalogRows: catalogRowsForParsing,
        userDefaultRows,
      });
      if (repaired?.ok) {
        parsed = repaired;
      } else {
        return {
          ok: false,
          error: 'semantic_mismatch',
          usage,
          modelStructured,
          modelNormalization,
          lexicalParsed,
        };
      }
    }
  }

  let shouldRequestLabelPhotoHint = Boolean(
    modelStructured?.shouldRequestLabelPhoto || modelNormalization?.shouldRequestLabelPhoto
  );
  const includeConfidenceInReply = parsedHasEstimatedRows(parsed);
  if (!shouldRequestLabelPhotoHint && includeConfidenceInReply) {
    shouldRequestLabelPhotoHint = parsed.items.some((item) =>
      looksLikePackagedAlias(item?.inputAlias || item?.foodItem)
    );
  }

  return {
    ok: true,
    parsed,
    usage,
    modelStructured,
    modelNormalization,
    lexicalParsed,
    includeConfidenceInReply,
    shouldRequestLabelPhotoHint,
  };
}

function normalizeBatchFailureHint(result = null) {
  const structuredAction = normalizeCatalogToken(result?.modelStructured?.action || '');
  const normalizationAction = normalizeCatalogToken(result?.modelNormalization?.action || '');
  if (structuredAction === 'ask_label_photo' || normalizationAction === 'ask_label_photo') {
    return 'label_photo';
  }
  if (structuredAction === 'ask_clarification' || normalizationAction === 'ask_clarification') {
    return 'clarification';
  }
  return 'generic';
}

function buildBatchIntakeFailureReply(failed = []) {
  const unresolvedPreview = failed
    .slice(0, 6)
    .map((row) => `- ${row?.line || '(línea vacía)'}`)
    .join('\n');
  const hint = failed.some((row) => row?.hint === 'label_photo')
    ? 'Al menos una línea parece producto de paquete: si querés precisión, mandá foto de la etiqueta nutricional.'
    : 'Mandamelo de nuevo por línea en formato simple: `13:30 200g pollo + 150g arroz`.';
  return [
    'No pude interpretar todas las líneas y no registré nada para evitar errores.',
    `Líneas con problema:\n${unresolvedPreview}`,
    hint,
    buildPhotoHintLine(),
  ].join('\n');
}

async function parseBatchIntakeTextWithModels({
  openai,
  modelCandidates = [],
  rawMessage = '',
  userId = '',
  userTimeZone = DEFAULT_USER_TIMEZONE,
  catalogRowsForParsing = [],
  userDefaultRows = [],
  userCatalogHistoryRows = [],
  catalogRowsForNormalization = [],
} = {}) {
  const lines = extractBatchIntakeLines(rawMessage);
  if (lines.length < 2) {
    return { ok: false, error: 'not_batch', lines: [] };
  }

  const baseTemporal = resolveTemporalContext({
    rawMessage,
    userTimeZone,
  });

  const entries = [];
  const failedLines = [];
  let usage = null;
  let includeConfidenceInReply = false;
  let shouldRequestLabelPhotoHint = false;

  for (const line of lines) {
    const lineMessage = applyBatchDateContextToLine(line, baseTemporal.localDate);
    const parsedLine = await parseSingleIntakeTextWithModels({
      openai,
      modelCandidates,
      rawMessage: lineMessage,
      alignmentMessage: line,
      userId,
      userTimeZone,
      catalogRowsForParsing,
      userDefaultRows,
      userCatalogHistoryRows,
      catalogRowsForNormalization,
      preferLexicalFirst: !NUTRITION_LLM_FIRST_PARSING,
    });
    usage = mergeUsageSnapshots(usage, parsedLine.usage);

    if (!parsedLine.ok || !parsedLine.parsed?.ok) {
      failedLines.push({
        line,
        hint: normalizeBatchFailureHint(parsedLine),
      });
      continue;
    }

    const temporal = parsedLine.parsed.temporal || {};
    const rowsWithTemporal = (parsedLine.parsed.items || []).map((item) => ({
      ...item,
      localDate: temporal.localDate,
      localTime: temporal.localTime,
    }));

    entries.push({
      sourceLine: line,
      temporal,
      items: parsedLine.parsed.items || [],
      rowsWithTemporal,
    });
    includeConfidenceInReply = includeConfidenceInReply || Boolean(parsedLine.includeConfidenceInReply);
    shouldRequestLabelPhotoHint =
      shouldRequestLabelPhotoHint || Boolean(parsedLine.shouldRequestLabelPhotoHint);
  }

  if (!entries.length) {
    return {
      ok: false,
      error: 'batch_parse_failed',
      usage,
      failedLines,
    };
  }

  if (failedLines.length) {
    return {
      ok: false,
      error: 'batch_partial_resolution',
      usage,
      failedLines,
      entries,
    };
  }

  const rows = entries.flatMap((entry) => entry.rowsWithTemporal || []);
  return {
    ok: true,
    usage,
    entries,
    rows,
    includeConfidenceInReply,
    shouldRequestLabelPhotoHint,
  };
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

  const scoreStopwords = new Set([
    'de',
    'del',
    'la',
    'el',
    'los',
    'las',
    'con',
    'sin',
    'por',
    'para',
    'y',
    'e',
    'en',
    'al',
    'a',
    'un',
    'una',
    'unos',
    'unas',
  ]);
  const hintTokens = normalizedNameHint
    .split(' ')
    .map((token) => token.trim())
    .filter(
      (token) =>
        token.length >= 3 && !scoreStopwords.has(token) && !/^\d+$/.test(token)
    );
  const entryTokens = new Set(
    entryName
      .split(' ')
      .map((token) => token.trim())
      .filter(
        (token) =>
          token.length >= 3 && !scoreStopwords.has(token) && !/^\d+$/.test(token)
      )
  );
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
    const scoreBeforeUsageBoost = score;
    const usageCount = Number(entry?.preferenceUsageCount ?? entry?.usageCount);
    // Usage should only bias among already-relevant candidates.
    // Prevent unrelated defaults with high usage from hijacking new items.
    if (
      scoreBeforeUsageBoost >= 40 &&
      Number.isFinite(usageCount) &&
      usageCount > 0
    ) {
      score += Math.min(10, usageCount);
    }
  }

  return score;
}

const STRUCTURED_HINT_STOPWORDS = new Set([
  'de',
  'del',
  'la',
  'el',
  'los',
  'las',
  'con',
  'sin',
  'por',
  'para',
  'y',
  'e',
  'en',
  'al',
  'a',
  'un',
  'una',
  'unos',
  'unas',
  'pata',
  'patas',
]);

function tokenizeStructuredFoodHint(value = '') {
  return normalizeCatalogToken(value)
    .replace(/[0-9/.,:+-]+/g, ' ')
    .split(' ')
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !STRUCTURED_HINT_STOPWORDS.has(token));
}

function hasReliableStructuredMatch({
  hint = '',
  entry = {},
  score = 0,
} = {}) {
  const normalizedHint = normalizeCatalogToken(hint);
  const normalizedEntry = normalizeCatalogToken(entry?.productName || entry?.normalizedName || '');
  if (!normalizedHint || !normalizedEntry) return false;

  const hasStrongStringMatch =
    normalizedEntry === normalizedHint ||
    normalizedHint.includes(normalizedEntry) ||
    normalizedEntry.includes(normalizedHint);
  if (hasStrongStringMatch && score >= 30) return true;

  const hintTokens = tokenizeStructuredFoodHint(normalizedHint);
  const entryTokens = tokenizeStructuredFoodHint(normalizedEntry);
  if (!hintTokens.length || !entryTokens.length) return false;

  const entryTokenSet = new Set(entryTokens);
  const overlapCount = hintTokens.filter((token) => entryTokenSet.has(token)).length;
  const overlapHintRatio = overlapCount / hintTokens.length;

  // If user described a composed dish, avoid collapsing to a single overlapping ingredient.
  if (hintTokens.length >= 4 && overlapCount < 2) return false;

  if (overlapCount >= 2 && overlapHintRatio >= 0.4) return true;

  // Keep short direct mentions working (e.g. "pollo", "huevo").
  if (hintTokens.length <= 2 && overlapCount >= 1 && score >= 45) return true;

  return false;
}

export function __testResolveCatalogEntryFromStructuredItem(
  item = {},
  catalogRows = [],
  options = {}
) {
  return resolveCatalogEntryFromStructuredItem(item, catalogRows, options);
}

export function __testParsedItemsAlignWithUserInput(rawMessage = '', parsedItems = []) {
  return parsedItemsAlignWithUserInput({ rawMessage, parsedItems });
}

export function __testEvaluateParsedItemsAlignment(rawMessage = '', parsedItems = []) {
  return evaluateParsedItemsAlignment({ rawMessage, parsedItems });
}

export function __testParsedItemsHaveAnyUserOverlap(rawMessage = '', parsedItems = []) {
  return parsedItemsHaveAnyUserOverlap({ rawMessage, parsedItems });
}

export function __testEnforceExplicitTemporalFromRawMessage({
  rawMessage = '',
  userTimeZone = DEFAULT_USER_TIMEZONE,
  parsed = null,
} = {}) {
  return enforceExplicitTemporalFromRawMessage({
    rawMessage,
    userTimeZone,
    parsed,
  });
}

export function __testResolveTemporalFromStructured({
  rawMessage = '',
  userTimeZone = DEFAULT_USER_TIMEZONE,
  temporal = {},
  now = new Date(),
} = {}) {
  return resolveTemporalFromStructured({
    rawMessage,
    userTimeZone,
    temporal,
    now,
  });
}

export function __testExtractBatchIntakeLines(rawMessage = '') {
  return extractBatchIntakeLines(rawMessage);
}

export function __testIsLikelyBatchIntakeMessage(rawMessage = '') {
  return isLikelyBatchIntakeMessage(rawMessage);
}

export function __testPlanNutritionAction({
  rawMessage = '',
  hasMedia = false,
  userTimeZone = DEFAULT_USER_TIMEZONE,
} = {}) {
  return planNutritionAction({
    rawMessage,
    hasMedia,
    userTimeZone,
  });
}

export function __testResolveIntakeTargetDeterministic({
  rawMessage = '',
  candidateRows = [],
  explicitIntakeId = null,
  userTimeZone = DEFAULT_USER_TIMEZONE,
} = {}) {
  return resolveIntakeTargetDeterministic({
    rawMessage,
    candidateRows,
    explicitIntakeId,
    userTimeZone,
  });
}


export function __testNormalizeVisualWeighinPayload(
  visualPayload = {},
  { rawMessage = '', userTimeZone = DEFAULT_USER_TIMEZONE } = {}
) {
  return normalizeVisualWeighinPayload({
    visualPayload,
    rawMessage,
    userTimeZone,
  });
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
      const alias = String(row?.aliasLabel || row?.preferenceAlias || '').trim();
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

function formatUserCatalogHistoryForStructuredParser(rows = []) {
  if (!Array.isArray(rows) || !rows.length) return '(sin historial de productos catalogados)';
  return rows
    .slice(0, 80)
    .map((row) => {
      const id = Number(row?.catalogItemId || row?.id);
      const alias = String(row?.preferenceAlias || row?.inputAlias || '').trim();
      const name = String(row?.productName || '').trim();
      const brand = String(row?.brand || '').trim();
      const usageCount = Number(row?.usageCount || row?.preferenceUsageCount || 0);
      const lastLoggedAt = String(row?.lastLoggedAt || '').trim();
      return [
        `catalog_id=${Number.isFinite(id) ? id : '?'}`,
        `name=${name || '-'}`,
        `brand=${brand || '-'}`,
        `alias_reciente=${alias || '-'}`,
        `usos=${Number.isFinite(usageCount) ? usageCount : 0}`,
        `ultimo=${lastLoggedAt || '-'}`,
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
      const idHint = String(item?.foodName || '').trim();
      if (!idHint) {
        return { entry: byId, matchedPreferenceAlias: null };
      }
      const idScore = scoreCatalogCandidate(byId, idHint, item?.brand || '');
      if (idScore >= 30) {
        return { entry: byId, matchedPreferenceAlias: null };
      }
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
  if (
    !hasReliableStructuredMatch({
      hint,
      entry: best,
      score: bestScore,
    })
  ) {
    return { entry: null, matchedPreferenceAlias: null };
  }
  return {
    entry: best,
    matchedPreferenceAlias: String(best?.preferenceAlias || best?.aliasLabel || '').trim() || null,
  };
}

function resolveTemporalFromStructured({
  rawMessage = '',
  userTimeZone = DEFAULT_USER_TIMEZONE,
  temporal = {},
  now = new Date(),
} = {}) {
  const baseline = resolveTemporalContext({
    rawMessage,
    userTimeZone,
    now,
  });
  const hasExplicitTime = Boolean(baseline?.hadExplicitTime);

  // Guardrail: if user did not provide an explicit date, keep local "today".
  // This avoids model day drift (e.g. UTC boundary causing +1 day).
  const localDate = baseline.localDate;
  const localTime = hasExplicitTime
    ? baseline.localTime
    : isValidHourMinute(temporal?.localTime)
      ? String(temporal.localTime).trim()
      : baseline.localTime;

  const explicitTemporal = resolveTemporalContext({
    rawMessage: `${localDate} ${localTime}`,
    userTimeZone,
    now,
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
          inputAlias: String(structuredItem?.foodName || '').trim() || null,
          resolutionMode: 'estimate',
          matchConfidence: normalizeConfidenceLabel(structuredItem?.confidence, 'baja'),
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
      resolutionMode: 'catalog',
      matchConfidence: normalizeConfidenceLabel(structuredItem?.confidence, 'media'),
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
  userCatalogHistoryRows = [],
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
    '- Prioriza primero "productos fijos por usuario" (alias personales), luego historial de productos consumidos por usuario, y recién después el catalogo general.',
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
    'Historial de productos catalogados consumidos por usuario:',
    formatUserCatalogHistoryForStructuredParser(userCatalogHistoryRows),
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
    '- Si llegan múltiples fotos en el mismo mensaje, tratarlas como parte de la misma comida y consolidar items sin duplicar.',
    '- Si una foto muestra otro plato/componente de la misma comida, incluirlo como item adicional.',
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



function normalizeVisualWeighinAction(value = '') {
  const normalized = normalizeText(value);
  if (!normalized) return 'unclear_image';
  if (
    ['weighin_ready', 'ready', 'log_weighin', 'weighin_log_ready'].includes(normalized)
  ) {
    return 'weighin_ready';
  }
  if (
    ['missing_weight', 'weight_not_visible', 'weight_missing', 'no_weight'].includes(normalized)
  ) {
    return 'missing_weight';
  }
  if (
    ['not_weighin', 'not_scale', 'not_weight', 'not_weight_screen'].includes(normalized)
  ) {
    return 'not_weighin';
  }
  if (['unclear_image', 'unclear', 'blurry'].includes(normalized)) {
    return 'unclear_image';
  }
  return 'unclear_image';
}

function normalizeVisualWeighinNumber(value, { min = 0, max = null } = {}) {
  const parsed = parseFlexibleNumber(value);
  if (!Number.isFinite(parsed)) return null;
  if (parsed < min) return null;
  if (Number.isFinite(max) && parsed > max) return null;
  return parsed;
}

function serializeWeighinRawInput({ temporal = {}, weighin = {} } = {}) {
  const parts = [];
  if (isValidIsoDate(temporal?.localDate)) parts.push(String(temporal.localDate).trim());
  if (isValidHourMinute(temporal?.localTime)) parts.push(String(temporal.localTime).trim());
  if (Number.isFinite(Number(weighin?.weightKg)) && Number(weighin.weightKg) > 0) {
    parts.push(`${formatNumberCompact(weighin.weightKg)} kg`);
  }
  if (Number.isFinite(Number(weighin?.bodyFatPercent))) {
    parts.push(`grasa ${formatNumberCompact(weighin.bodyFatPercent)}%`);
  }
  if (Number.isFinite(Number(weighin?.bodyWaterPercent))) {
    parts.push(`agua ${formatNumberCompact(weighin.bodyWaterPercent)}%`);
  }
  if (Number.isFinite(Number(weighin?.muscleMassKg))) {
    parts.push(`musculo ${formatNumberCompact(weighin.muscleMassKg)} kg`);
  }
  if (Number.isFinite(Number(weighin?.visceralFat))) {
    parts.push(`visceral ${formatNumberCompact(weighin.visceralFat)}`);
  }
  if (Number.isFinite(Number(weighin?.bmrKcal))) {
    parts.push(`bmr ${formatNumberCompact(weighin.bmrKcal)}`);
  }
  if (Number.isFinite(Number(weighin?.boneMassKg))) {
    parts.push(`hueso ${formatNumberCompact(weighin.boneMassKg)} kg`);
  }
  return parts.join(' ').trim();
}

function normalizeVisualWeighinPayload({
  visualPayload = {},
  rawMessage = '',
  userTimeZone = DEFAULT_USER_TIMEZONE,
} = {}) {
  const action = normalizeVisualWeighinAction(visualPayload?.action);
  const confidence = normalizeConfidenceLabel(
    visualPayload?.confidence || visualPayload?.overall_confidence,
    'media'
  );

  if (action === 'not_weighin') {
    return {
      ok: false,
      action,
      confidence,
      error: 'not_weighin_image',
    };
  }

  if (action === 'unclear_image') {
    return {
      ok: false,
      action,
      confidence,
      error: 'unclear_image',
    };
  }

  const temporal = resolveTemporalFromStructured({
    rawMessage,
    userTimeZone,
    temporal: {
      localDate: String(visualPayload?.temporal?.local_date || '').trim(),
      localTime: String(visualPayload?.temporal?.local_time || '').trim(),
    },
  });

  const weighin = {
    weightKg: normalizeVisualWeighinNumber(visualPayload?.weight_kg, { min: 1, max: 500 }),
    bodyFatPercent: normalizeVisualWeighinNumber(visualPayload?.body_fat_percent, {
      min: 0,
      max: 100,
    }),
    bodyWaterPercent: normalizeVisualWeighinNumber(visualPayload?.body_water_percent, {
      min: 0,
      max: 100,
    }),
    muscleMassKg: normalizeVisualWeighinNumber(visualPayload?.muscle_mass_kg, {
      min: 0,
      max: 200,
    }),
    visceralFat: normalizeVisualWeighinNumber(visualPayload?.visceral_fat, {
      min: 0,
      max: 100,
    }),
    bmrKcal: normalizeVisualWeighinNumber(visualPayload?.bmr_kcal, { min: 0, max: 10000 }),
    boneMassKg: normalizeVisualWeighinNumber(visualPayload?.bone_mass_kg, { min: 0, max: 30 }),
    notes: String(visualPayload?.note || '').trim(),
  };

  if (!Number.isFinite(weighin.weightKg) || weighin.weightKg <= 0) {
    return {
      ok: false,
      action: 'missing_weight',
      confidence,
      error: 'missing_weight',
      temporal,
      weighin,
    };
  }

  return {
    ok: true,
    action: 'weighin_ready',
    confidence,
    temporal,
    weighin,
    rawInput: serializeWeighinRawInput({ temporal, weighin }),
  };
}

async function inferWeighinFromImage({
  openai,
  modelCandidates = [],
  inputItems = [],
  userMessage = '',
  userTimeZone = DEFAULT_USER_TIMEZONE,
} = {}) {
  const instructions = [
    'Sos un parser visual de pesajes para nutricion.',
    'Analiza screenshot/foto de balanza corporal y devolve JSON puro sin markdown.',
    'Schema:',
    '{',
    '  "action":"weighin_ready|missing_weight|unclear_image|not_weighin",',
    '  "confidence":"alta|media|baja",',
    '  "weight_kg":number|null,',
    '  "body_fat_percent":number|null,',
    '  "body_water_percent":number|null,',
    '  "muscle_mass_kg":number|null,',
    '  "visceral_fat":number|null,',
    '  "bmr_kcal":number|null,',
    '  "bone_mass_kg":number|null,',
    '  "temporal":{"local_date":"YYYY-MM-DD|null","local_time":"HH:MM|null"},',
    '  "note":"string"',
    '}',
    'Reglas:',
    '- Si no es pantalla/foto de balanza corporal: action=not_weighin.',
    '- Si es balanza pero no se puede leer peso en kg: action=missing_weight.',
    '- Si la imagen es ilegible/borrosa: action=unclear_image.',
    '- Solo usar weighin_ready cuando el peso sea legible.',
    '- Campos opcionales: devolver null si no se ven.',
    '- Aceptar decimales con coma o punto.',
    '- No inventar valores.',
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
            text: `Timezone usuario: ${userTimeZone}
Texto opcional del usuario: ${
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
  const normalized = normalizeVisualWeighinPayload({
    visualPayload: json,
    rawMessage: String(userMessage || '').trim(),
    userTimeZone,
  });

  return {
    ok: true,
    model: smart.model,
    usage: extractUsageSnapshot(smart.response),
    action: normalized.action,
    confidence: normalized.confidence,
    parsed: normalized.ok
      ? {
          ok: true,
          temporal: normalized.temporal,
          weighin: normalized.weighin,
        }
      : null,
    rawInput: normalized.rawInput || '',
    error: normalized.ok ? '' : normalized.error,
  };
}

async function parseWeighinFromTextWithModel({
  openai,
  modelCandidates = [],
  rawMessage = '',
  userTimeZone = DEFAULT_USER_TIMEZONE,
} = {}) {
  const instructions = [
    'Sos un parser textual de pesajes para nutricion.',
    'Devolvé JSON puro sin markdown.',
    'Schema:',
    '{',
    '  "action":"weighin_ready|missing_weight|not_weighin|ask_clarification",',
    '  "confidence":"alta|media|baja",',
    '  "weight_kg":number|null,',
    '  "body_fat_percent":number|null,',
    '  "body_water_percent":number|null,',
    '  "muscle_mass_kg":number|null,',
    '  "visceral_fat":number|null,',
    '  "bmr_kcal":number|null,',
    '  "bone_mass_kg":number|null,',
    '  "temporal":{"local_date":"YYYY-MM-DD|null","local_time":"HH:MM|null"},',
    '  "clarification_question":"string",',
    '  "note":"string"',
    '}',
    'Reglas:',
    '- Si el usuario informó peso en kg de forma interpretable, action=weighin_ready.',
    '- Aceptar formatos con coma/punto decimal y español natural (ej: "81,4", "peso 81.4", "hoy 08:10 81.4 kg").',
    '- Si no hay peso explícito, action=missing_weight o ask_clarification.',
    '- Si el mensaje no trata de pesaje, action=not_weighin.',
    '- No inventar valores.',
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
            text: `Timezone usuario: ${userTimeZone}\nMensaje usuario: ${String(rawMessage || '').trim()}`,
          },
        ],
      },
    ],
  });

  const outputText = extractOutputText(smart.response);
  const json = extractJsonObject(outputText) || {};
  const action = normalizeText(json?.action || '');
  if (action === 'ask_clarification') {
    return {
      ok: true,
      model: smart.model,
      usage: extractUsageSnapshot(smart.response),
      action: 'ask_clarification',
      clarificationQuestion:
        String(json?.clarification_question || '').trim() ||
        'No pude detectar bien el pesaje. Pasamelo como `81.4 kg`.',
      parsed: null,
      error: 'ask_clarification',
    };
  }

  const normalized = normalizeVisualWeighinPayload({
    visualPayload: json,
    rawMessage: String(rawMessage || '').trim(),
    userTimeZone,
  });

  return {
    ok: true,
    model: smart.model,
    usage: extractUsageSnapshot(smart.response),
    action: normalized.action,
    parsed: normalized.ok
      ? {
          ok: true,
          temporal: normalized.temporal,
          weighin: normalized.weighin,
        }
      : null,
    rawInput: normalized.rawInput || '',
    clarificationQuestion: '',
    error: normalized.ok ? '' : normalized.error,
  };
}

function formatWeighinOptionalLines(weighin = {}) {
  const lines = [];
  if (Number.isFinite(Number(weighin?.bodyFatPercent))) {
    lines.push(`- Grasa corporal: ${formatNumberCompact(weighin.bodyFatPercent)}%`);
  }
  if (Number.isFinite(Number(weighin?.bodyWaterPercent))) {
    lines.push(`- Agua corporal: ${formatNumberCompact(weighin.bodyWaterPercent)}%`);
  }
  if (Number.isFinite(Number(weighin?.muscleMassKg))) {
    lines.push(`- Masa muscular: ${formatNumberCompact(weighin.muscleMassKg)} kg`);
  }
  if (Number.isFinite(Number(weighin?.visceralFat))) {
    lines.push(`- Grasa visceral: ${formatNumberCompact(weighin.visceralFat)}`);
  }
  if (Number.isFinite(Number(weighin?.bmrKcal))) {
    lines.push(`- BMR: ${formatNumberCompact(weighin.bmrKcal)} kcal`);
  }
  if (Number.isFinite(Number(weighin?.boneMassKg))) {
    lines.push(`- Masa osea: ${formatNumberCompact(weighin.boneMassKg)} kg`);
  }
  return lines;
}

function buildWeighinAutoSavedReply({
  parsed = null,
  confidence = '',
  idempotencyNotice = '',
  mode = 'saved',
} = {}) {
  if (!parsed?.ok) {
    return [
      'No pude leer el peso de la imagen.',
      'Mandame otra foto más nítida o texto `81.4 kg`.',
    ].join('\n');
  }

  const optionalLines = formatWeighinOptionalLines(parsed.weighin);
  const header =
    mode === 'modified'
      ? '✅ Pesaje modificado y ya quedó asentado.'
      : '✅ Ya quedó asentado el pesaje por OCR.';
  const confidenceLine = confidence
    ? `- Confianza OCR: ${normalizeConfidenceLabel(confidence, 'media')}`
    : null;
  return [
    header,
    `- Fecha: ${parsed.temporal.localDate}`,
    `- Hora: ${parsed.temporal.localTime}`,
    `- Peso: ${formatNumberCompact(parsed.weighin.weightKg)} kg`,
    ...optionalLines,
    confidenceLine,
    idempotencyNotice,
    'Si querés ajustar este último OCR, escribí `cancelar` para deshacer o `modificar 82.1 kg` para corregir.',
  ]
    .filter(Boolean)
    .join('\n');
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

function parseWeighinModifyCommand(text = '') {
  const raw = String(text || '').trim();
  if (!raw) {
    return { isModify: false, payload: '' };
  }
  const match = raw.match(
    /^(?:modificar|modifica|modif|corregir|corregi|corrige|editar|edita|ajustar|ajusta)\b[:\s-]*/i
  );
  if (!match) {
    return { isModify: false, payload: '' };
  }
  const payload = raw.slice(match[0].length).trim();
  return {
    isModify: true,
    payload,
  };
}

function applyBaseTemporalToCorrection(parsed = null, baseTemporal = null) {
  if (!parsed?.ok) return parsed;
  if (!baseTemporal || typeof baseTemporal !== 'object') return parsed;
  const temporal = parsed.temporal || {};
  if (temporal.hadExplicitDate || temporal.hadExplicitTime) return parsed;

  return {
    ...parsed,
    temporal: {
      ...temporal,
      localDate: String(baseTemporal.localDate || temporal.localDate || '').trim() || temporal.localDate,
      localTime: String(baseTemporal.localTime || temporal.localTime || '').trim() || temporal.localTime,
      loggedAt: String(baseTemporal.loggedAt || temporal.loggedAt || '').trim() || temporal.loggedAt,
      timeZone: String(baseTemporal.timeZone || temporal.timeZone || '').trim() || temporal.timeZone,
    },
  };
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


function getRecentImageWeighinAction(draftsByUser, userId = '') {
  const key = String(userId || '').trim();
  if (!key) return null;
  const draft = draftsByUser.get(key) || null;
  if (!draft) return null;
  if (Number(draft.expiresAt || 0) <= Date.now()) {
    draftsByUser.delete(key);
    return null;
  }
  if (!Number.isFinite(Number(draft.weighinId)) || Number(draft.weighinId) <= 0) {
    draftsByUser.delete(key);
    return null;
  }
  return draft;
}

function setRecentImageWeighinAction(draftsByUser, userId = '', draft = {}) {
  const key = String(userId || '').trim();
  if (!key || !draft || typeof draft !== 'object') return;
  draftsByUser.set(key, {
    ...draft,
    createdAt: Date.now(),
    expiresAt: Date.now() + IMAGE_WEIGHIN_DRAFT_TTL_MS,
  });
}

function clearRecentImageWeighinAction(draftsByUser, userId = '') {
  const key = String(userId || '').trim();
  if (!key) return;
  draftsByUser.delete(key);
}

function getPendingIntakeOperationContext(contextByUser, userId = '') {
  const key = String(userId || '').trim();
  if (!key) return null;
  const context = contextByUser.get(key) || null;
  if (!context) return null;
  if (Number(context.expiresAt || 0) <= Date.now()) {
    contextByUser.delete(key);
    return null;
  }
  return context;
}

function setPendingIntakeOperationContext(contextByUser, userId = '', context = {}) {
  const key = String(userId || '').trim();
  if (!key || !context || typeof context !== 'object') return;
  contextByUser.set(key, {
    ...context,
    createdAt: Date.now(),
    expiresAt: Date.now() + INTAKE_OPERATION_CONTEXT_TTL_MS,
  });
}

function clearPendingIntakeOperationContext(contextByUser, userId = '') {
  const key = String(userId || '').trim();
  if (!key) return;
  contextByUser.delete(key);
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
    const intakeId = toPositiveIntOrNull(row?.id);
    const qValue = Number(row?.quantityValue);
    const quantity = Number.isFinite(qValue)
      ? `${qValue}${row?.quantityUnit ? ` ${row.quantityUnit}` : ''}`
      : row?.quantityUnit || 'porcion';
    lines.push(
      `- ${intakeId ? `ID ${intakeId} | ` : ''}${row.localDate} ${row.localTime} | ${row.foodItem} (${quantity}) | ${Math.round(
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
  const recentImageWeighinActionByUser = new Map();
  const pendingIntakeOperationContextByUser = new Map();
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

      const existingProfileRaw = getNutritionProfile(userId); // null if brand new user
      const profile = existingProfileRaw || {};
      const userTimeZone = String(profile?.timezone || DEFAULT_USER_TIMEZONE).trim();

      // ── ONBOARDING GATE ──────────────────────────────────────────────────────
      // Auto-complete onboarding for users who had a profile before this feature
      // (they have mainGoal or targetCaloriesKcal set but onboarding_complete=0)
      if (
        existingProfileRaw &&
        Number(existingProfileRaw.onboardingComplete) !== 1 &&
        (existingProfileRaw.mainGoal || existingProfileRaw.targetCaloriesKcal)
      ) {
        upsertNutritionProfile(userId, { onboardingComplete: 1 }, {
          idempotency: { sourceMessageId: 'auto_complete_' + userId, operationType: 'onboarding_auto_complete' },
        });
        existingProfileRaw.onboardingComplete = 1;
      }

      // Only gate truly new users (no profile at all) or those mid-onboarding
      // Never block functional guidedActions (log_intake, log_weighin, view_summary, etc.)
      const FUNCTIONAL_GUIDED_ACTIONS = new Set([
        'log_intake', 'log_weighin', 'view_summary', 'view_profile', 'learning_chat', 'view_credits', 'view_analysis',
      ]);
      const isOnboarding =
        !FUNCTIONAL_GUIDED_ACTIONS.has(guidedAction) &&
        (!existingProfileRaw || Number(existingProfileRaw.onboardingComplete) !== 1);

      if (isOnboarding) {
        if (!existingProfileRaw) {
          // First ever message: create stub + send welcome with goal buttons
          upsertNutritionProfile(
            userId,
            { timezone: DEFAULT_USER_TIMEZONE, onboardingComplete: 0 },
            { idempotency: { sourceMessageId, operationType: 'onboarding_init' } }
          );
          return {
            text: [
              '👋 Bienvenido/a a tu asistente de nutrición.',
              'Para darte recomendaciones útiles, contame un poco de vos.',
              '¿Cuál es tu objetivo principal?',
              '(También podés escribirlo con tus palabras o hacerme cualquier pregunta.)',
            ].join('\n'),
            replyMarkup: {
              inline_keyboard: [
                [{ text: 'Bajar grasa', callback_data: 'qa:nutrition_goal:bajar_grasa' }],
                [{ text: 'Ganar músculo', callback_data: 'qa:nutrition_goal:ganar_musculo' }],
                [{ text: 'Mejorar hábitos / ansiedad', callback_data: 'qa:nutrition_goal:mejorar_habitos' }],
                [{ text: 'Comer mejor sin dieta', callback_data: 'qa:nutrition_goal:comer_mejor' }],
                [{ text: 'Mejorar salud y energía', callback_data: 'qa:nutrition_goal:mejorar_salud' }],
              ],
            },
          };
        }

        // Onboarding in progress: parse turn and accumulate fields
        if (!cleanMessage) {
          return '¿Seguimos con tu perfil? Contame tu objetivo, peso, o cualquier pregunta que tengas.';
        }

        const onboardingResult = await parseOnboardingTurnWithModel({
          openai,
          modelCandidates: smartModelCandidates,
          rawMessage: cleanMessage,
          existingProfile: existingProfileRaw,
        });

        // Map extracted snake_case to camelCase for upsert
        const extracted = onboardingResult.extracted || {};
        const profileUpdates = {};
        if (extracted.main_goal != null) profileUpdates.mainGoal = String(extracted.main_goal).trim();
        if (extracted.edad != null) profileUpdates.edad = Number(extracted.edad);
        if (extracted.sexo != null) profileUpdates.sexo = String(extracted.sexo).trim();
        if (extracted.altura_cm != null) profileUpdates.alturaCm = Number(extracted.altura_cm);
        if (extracted.peso_actual_kg != null) profileUpdates.pesoActualKg = Number(extracted.peso_actual_kg);
        if (extracted.nivel_actividad != null) profileUpdates.nivelActividad = String(extracted.nivel_actividad).trim();
        if (extracted.tipo_entrenamiento != null) profileUpdates.tipoEntrenamiento = String(extracted.tipo_entrenamiento).trim();
        if (extracted.frecuencia_entrenamiento != null) profileUpdates.frecuenciaEntrenamiento = String(extracted.frecuencia_entrenamiento).trim();
        if (extracted.alergias_intolerancias != null) profileUpdates.alergiasIntolerancias = String(extracted.alergias_intolerancias).trim();
        if (extracted.condicion_salud != null) profileUpdates.condicionSalud = String(extracted.condicion_salud).trim();
        if (extracted.dificultad_principal != null) profileUpdates.dificultadPrincipal = String(extracted.dificultad_principal).trim();
        if (extracted.target_calories_kcal != null) profileUpdates.targetCaloriesKcal = Number(extracted.target_calories_kcal);
        if (extracted.target_protein_g != null) profileUpdates.targetProteinG = Number(extracted.target_protein_g);

        if (Object.keys(profileUpdates).length > 0) {
          upsertNutritionProfile(userId, profileUpdates, {
            idempotency: { sourceMessageId, operationType: 'onboarding_turn' },
          });
        }

        if (onboardingResult.action === 'answer_question') {
          const reply = [onboardingResult.answerText, onboardingResult.nextQuestion]
            .filter(Boolean)
            .join('\n\n');
          return reply || 'Puedo ayudarte con eso. ¿Continuamos con tu perfil?';
        }

        if (onboardingResult.action === 'complete') {
          upsertNutritionProfile(userId, { onboardingComplete: 1 }, {
            idempotency: { sourceMessageId: sourceMessageId + '_complete', operationType: 'onboarding_complete' },
          });
          const finalProfile = getNutritionProfile(userId) || {};
          return [
            formatOnboardingSummary(finalProfile),
            suggestTutorialsForGoal(finalProfile.mainGoal),
            '',
            '¡Listo! Ya podés usar todos los módulos: Registrar ingesta, Pesaje, Resumen y Aprendizaje.',
          ].join('\n');
        }

        return onboardingResult.nextQuestion || '¿Podés contarme un poco más sobre vos?';
      }
      // ── END ONBOARDING GATE ──────────────────────────────────────────────────

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
        // ── Synthetic sub-actions from stats submenu ─────────────────────
        if (cleanMessage === '__view_profile__') {
          const lines = ['📋 Tu perfil actual:'];
          if (profile.mainGoal) lines.push(`- Objetivo: ${profile.mainGoal}`);
          if (profile.edad) lines.push(`- Edad: ${profile.edad}`);
          if (profile.sexo) lines.push(`- Sexo: ${profile.sexo}`);
          if (profile.alturaCm) lines.push(`- Altura: ${profile.alturaCm} cm`);
          if (profile.pesoActualKg) lines.push(`- Peso (perfil): ${profile.pesoActualKg} kg`);
          if (profile.nivelActividad) lines.push(`- Actividad: ${profile.nivelActividad}`);
          if (profile.tipoEntrenamiento) lines.push(`- Entrenamiento: ${profile.tipoEntrenamiento}`);
          if (profile.frecuenciaEntrenamiento) lines.push(`- Frecuencia: ${profile.frecuenciaEntrenamiento}`);
          if (profile.alergiasIntolerancias) lines.push(`- Restricciones: ${profile.alergiasIntolerancias}`);
          if (profile.condicionSalud) lines.push(`- Salud: ${profile.condicionSalud}`);
          if (profile.dificultadPrincipal) lines.push(`- Principal dificultad: ${profile.dificultadPrincipal}`);
          if (profile.targetCaloriesKcal) lines.push(`- Target: ${profile.targetCaloriesKcal} kcal`);
          if (profile.targetProteinG) lines.push(`- Proteína target: ${profile.targetProteinG} g`);
          if (profile.timezone) lines.push(`- Timezone: ${profile.timezone}`);
          if (profile.restrictions) lines.push(`- Restricciones (campo anterior): ${profile.restrictions}`);
          if (lines.length === 1) lines.push('(perfil vacío — usá Actualizar perfil/objetivos para completarlo)');
          replyText = lines.join('\n');
          shouldCharge = false;
        } else if (cleanMessage === '__history__:yesterday') {
          const temporal = resolveTemporalContext({ rawMessage: 'ayer', userTimeZone });
          const byDate = listNutritionIntakesByDate(userId, temporal.localDate, { limit: 30 });
          const summary = getNutritionSummary(userId, temporal.localDate);
          const status = calculateProfileStatus(profile, summary.today);
          if (byDate.length) {
            replyText = [
              `📅 Ingestas del ${temporal.localDate}:`,
              ...byDate.slice(0, 15).map((r) => {
                const qty = [r.quantityValue, r.quantityUnit].filter(Boolean).join(' ');
                return `- ${toPositiveIntOrNull(r.id) ? `ID ${toPositiveIntOrNull(r.id)} | ` : ''}${r.localTime || ''} ${r.foodItem}${qty ? ' ' + qty : ''} | ${Math.round(r.caloriesKcal || 0)} kcal`;
              }),
              byDate.length > 15 ? `... y ${byDate.length - 15} más` : null,
              '',
              formatMacroLine('Total ayer: ', summary.today),
              `Estado: ${status}`,
            ].filter((x) => x !== null).join('\n');
          } else {
            replyText = `No encontré ingestas registradas para el ${temporal.localDate}.`;
          }
          shouldCharge = false;
        } else if (cleanMessage === '__history__:weight') {
          const weighins = listRecentNutritionWeighins(userId, { limit: 10 });
          if (weighins.length) {
            replyText = [
              '⚖️ Historial de peso (últimos registros):',
              ...weighins.map((w) =>
                `- ${w.localDate}: ${w.weightKg} kg${w.bodyFatPercent ? ` | grasa ${w.bodyFatPercent}%` : ''}${w.muscleMassKg ? ` | músculo ${w.muscleMassKg} kg` : ''}`
              ),
            ].join('\n');
          } else {
            replyText = '⚖️ No hay pesajes registrados todavía.';
          }
          shouldCharge = false;
        } else if (cleanMessage === '__history__:weekly_trend') {
          const temporal = resolveTemporalContext({ rawMessage: 'hoy', userTimeZone });
          const summary = getNutritionSummary(userId, temporal.localDate);
          const lines = ['📈 Tendencia semanal:'];
          if (summary.rolling7d?.caloriesKcal) {
            lines.push(`- Prom 7d: ${Math.round(summary.rolling7d.caloriesKcal)} kcal | P ${Math.round(summary.rolling7d.proteinG || 0)}g | C ${Math.round(summary.rolling7d.carbsG || 0)}g | G ${Math.round(summary.rolling7d.fatG || 0)}g`);
          }
          if (summary.rolling14d?.caloriesKcal) {
            lines.push(`- Prom 14d: ${Math.round(summary.rolling14d.caloriesKcal)} kcal | P ${Math.round(summary.rolling14d.proteinG || 0)}g`);
          }
          if (profile.targetCaloriesKcal) {
            const ratio7 = summary.rolling7d?.caloriesKcal
              ? Math.round((summary.rolling7d.caloriesKcal / profile.targetCaloriesKcal) * 100)
              : null;
            if (ratio7 !== null) lines.push(`- Vs target kcal: ${ratio7}%`);
          }
          if (profile.targetProteinG) {
            const proteinRatio = summary.rolling7d?.proteinG
              ? Math.round((summary.rolling7d.proteinG / profile.targetProteinG) * 100)
              : null;
            if (proteinRatio !== null) lines.push(`- Vs target proteína: ${proteinRatio}%`);
          }
          const weighins = listRecentNutritionWeighins(userId, { limit: 7 });
          if (weighins.length >= 2) {
            const first = weighins[weighins.length - 1];
            const last = weighins[0];
            const delta = Number(last.weightKg) - Number(first.weightKg);
            lines.push(`- Peso: ${first.weightKg} kg → ${last.weightKg} kg (${delta >= 0 ? '+' : ''}${delta.toFixed(1)} kg en ${weighins.length} registros)`);
          }
          if (lines.length === 1) lines.push('(pocos datos todavía — seguí registrando para ver tendencias)');
          replyText = lines.join('\n');
          shouldCharge = false;
        } else {
          // Normal summary
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
        }
      } else if (guidedAction === 'view_analysis') {
        // ── Análisis personalizado ────────────────────────────────────────
        const temporal = resolveTemporalContext({ rawMessage: 'hoy', userTimeZone });
        const summary = getNutritionSummary(userId, temporal.localDate);
        const recentIntakes = listRecentNutritionIntakes(userId, { limit: 30 });
        const weighinHistory = listRecentNutritionWeighins(userId, { limit: 14 });
        const isStart = cleanMessage === '__analysis__:start' || !cleanMessage;

        const analysisResult = await performPersonalizedAnalysisWithModel({
          openai,
          modelCandidates: smartModelCandidates,
          profile,
          summary,
          recentIntakes,
          weighinHistory,
          userMessage: isStart ? '' : cleanMessage,
        });
        usageSnapshot = mergeUsageSnapshots(usageSnapshot, analysisResult.usage);
        replyText = [
          isStart ? '🔬 Análisis personalizado:' : null,
          analysisResult.content || 'No pude generar el análisis ahora. Reintentá en un momento.',
          isStart ? '\nPodés hacerme preguntas sobre el análisis.' : null,
        ].filter(Boolean).join('\n');
        shouldCharge = true;
      } else if (guidedAction === 'log_weighin') {
        let parsed = null;
        let rawInputForPersist = cleanMessage;
        let weighinMessageForParse = cleanMessage;
        let shouldTrackRecentImageWeighin = false;
        let imageOcrConfidence = '';
        let weighinReplyMode = 'default';
        let replaceTarget = null;
        let replacementDeleteNotice = '';

        const recentImageWeighinAction = getRecentImageWeighinAction(
          recentImageWeighinActionByUser,
          userId
        );
        const modifyCommand = parseWeighinModifyCommand(cleanMessage);
        const cancelIntent =
          Boolean(cleanMessage) &&
          isImageDraftCancelIntent(cleanMessage) &&
          !looksLikeDeleteIntent(cleanMessage);

        if (recentImageWeighinAction && cancelIntent) {
          const cancelled = deleteNutritionWeighin(userId, recentImageWeighinAction.weighinId);
          clearRecentImageWeighinAction(recentImageWeighinActionByUser, userId);
          if (!cancelled?.ok || !cancelled.deleted) {
            return [
              'No pude deshacer ese último pesaje OCR porque ya no estaba disponible.',
              'Si querés, registrá uno nuevo con foto o texto `81.4 kg`.',
            ].join('\n');
          }

          const latest = getLatestNutritionWeighin(userId);
          replyText = [
            '✅ Listo, cancelé el último pesaje OCR y lo saqué del registro.',
            latest
              ? `⚖️ Último pesaje vigente: ${Number(latest.weightKg).toFixed(1)} kg (${latest.localDate})`
              : 'No quedan pesajes registrados.',
          ].join('\n');
          shouldCharge = true;
        } else if (!recentImageWeighinAction && cancelIntent) {
          return [
            'No tengo un pesaje OCR reciente para cancelar.',
            'Si querés borrar uno ya guardado, escribí `borra el ultimo pesaje`.',
          ].join('\n');
        } else {
          if (modifyCommand.isModify) {
            if (!recentImageWeighinAction) {
              if (!modifyCommand.payload) {
                return [
                  'No tengo un pesaje OCR reciente para modificar.',
                  'Podés mandar una corrección completa en texto, por ejemplo: `82.1 kg grasa 24%`.',
                ].join('\n');
              }
              weighinMessageForParse = modifyCommand.payload;
              rawInputForPersist = modifyCommand.payload;
            } else if (!modifyCommand.payload) {
              setRecentImageWeighinAction(recentImageWeighinActionByUser, userId, {
                ...recentImageWeighinAction,
                awaitingCorrection: true,
              });
              return 'Perfecto. Mandame la corrección en texto (ej: `82.1 kg grasa 24%`) y reemplazo el último OCR.';
            } else {
              replaceTarget = recentImageWeighinAction;
              weighinMessageForParse = modifyCommand.payload;
              rawInputForPersist = modifyCommand.payload;
              shouldTrackRecentImageWeighin = true;
              weighinReplyMode = 'modified';
            }
          } else if (
            recentImageWeighinAction?.awaitingCorrection &&
            cleanMessage &&
            !hasMedia &&
            !looksLikeDeleteIntent(cleanMessage)
          ) {
            replaceTarget = recentImageWeighinAction;
            weighinMessageForParse = cleanMessage;
            rawInputForPersist = cleanMessage;
            shouldTrackRecentImageWeighin = true;
            weighinReplyMode = 'modified';
          }

          if (replaceTarget) {
            const parsedCorrection = parseWeighinPayload({
              rawMessage: weighinMessageForParse,
              userTimeZone,
            });
            if (!parsedCorrection?.ok) {
              return [
                'No pude detectar el peso en la corrección.',
                'Formato mínimo: `82.1 kg`.',
              ].join('\n');
            }
            parsed = applyBaseTemporalToCorrection(parsedCorrection, replaceTarget.temporal);
          }

          if (!parsed && !hasMedia && cleanMessage && looksLikeDeleteIntent(cleanMessage)) {
            const temporal = resolveTemporalContext({ rawMessage: cleanMessage, userTimeZone });
            const todayRows = getTodayNutritionWeighins(userId, temporal.localDate, { limit: 10 });
            if (!todayRows.length) {
              return 'No tenés pesajes registrados hoy para eliminar.';
            }
            const deleteResult = await resolveDeleteTargetWithModel({
              openai,
              modelCandidates: smartModelCandidates,
              rawMessage: cleanMessage,
              todayRows,
              entityType: 'weighin',
            });
            usageSnapshot = mergeUsageSnapshots(usageSnapshot, deleteResult.usage);
            if (deleteResult.action === 'cannot_identify') {
              const list = todayRows
                .slice(0, 5)
                .map((r) => `- ${r.localTime || '?'} → ${r.weightKg} kg`)
                .join('\n');
              return `No identifiqué cuál borrar. Pesajes de hoy:
${list}
Decime cuál: "borrá el de las 08:00" o "borrá el último".`;
            }
            const targetId =
              deleteResult.action === 'delete_last'
                ? Number(todayRows[0]?.id)
                : Number(deleteResult.targetId);
            if (!targetId) {
              return 'No pude identificar el pesaje. Intentá con más detalle.';
            }
            const deleted = deleteNutritionWeighin(userId, targetId);
            if (!deleted?.ok || !deleted.deleted) {
              return '❌ No pude eliminar ese pesaje. Puede que ya no exista.';
            }
            clearRecentImageWeighinAction(recentImageWeighinActionByUser, userId);
            const latest = getLatestNutritionWeighin(userId);
            replyText = [
              '✅ Pesaje eliminado.',
              latest
                ? `⚖️ Último pesaje registrado: ${Number(latest.weightKg).toFixed(1)} kg (${latest.localDate})`
                : 'Sin pesajes previos registrados.',
            ].join('\n');
            shouldCharge = true;
          } else {
            if (!parsed && hasMedia) {
              let imageWeighinResult = null;
              try {
                imageWeighinResult = await inferWeighinFromImage({
                  openai,
                  modelCandidates: smartModelCandidates,
                  inputItems,
                  userMessage: cleanMessage,
                  userTimeZone,
                });
                usageSnapshot = mergeUsageSnapshots(usageSnapshot, imageWeighinResult.usage);
                if (imageWeighinResult.usage) {
                  addNutritionUsageRecord(userId, {
                    guidedAction: 'log_weighin_image_parser',
                    model: imageWeighinResult.model,
                    inputTokens: imageWeighinResult.usage.inputTokens,
                    outputTokens: imageWeighinResult.usage.outputTokens,
                    totalTokens: imageWeighinResult.usage.totalTokens,
                    reasoningTokens: imageWeighinResult.usage.reasoningTokens,
                    cachedTokens: imageWeighinResult.usage.cachedTokens,
                    rawUsage: imageWeighinResult.usage.rawUsage,
                  });
                }
              } catch (imageWeighinError) {
                console.error('[nutrition-runtime] weighin image parser failed', imageWeighinError);
              }

              if (!imageWeighinResult || imageWeighinResult.error === 'unclear_image') {
                return [
                  'No pude leer el peso de la imagen.',
                  'Mandame otra foto más nítida o texto `81.4 kg`.',
                ].join('\n');
              }

              if (imageWeighinResult.error === 'not_weighin_image') {
                return [
                  'No detecté una pantalla de balanza en esa imagen.',
                  'Mandame foto/screenshot de la balanza o texto `81.4 kg`.',
                ].join('\n');
              }

              if (imageWeighinResult.error === 'missing_weight') {
                return [
                  'No pude leer el peso de la imagen.',
                  'Mandame otra foto más nítida o texto `81.4 kg`.',
                ].join('\n');
              }

              if (imageWeighinResult.action === 'weighin_ready' && imageWeighinResult.parsed?.ok) {
                parsed = imageWeighinResult.parsed;
                rawInputForPersist =
                  imageWeighinResult.rawInput ||
                  serializeWeighinRawInput({
                    temporal: imageWeighinResult.parsed.temporal,
                    weighin: imageWeighinResult.parsed.weighin,
                  });
                shouldTrackRecentImageWeighin = true;
                weighinReplyMode = 'saved';
                imageOcrConfidence = imageWeighinResult.confidence || '';
              } else {
                return [
                  'No pude leer el peso de la imagen.',
                  'Mandame otra foto más nítida o texto `81.4 kg`.',
                ].join('\n');
              }
            }

            if (!parsed) {
              if (!hasMedia && weighinMessageForParse) {
                try {
                  const textWeighin = await parseWeighinFromTextWithModel({
                    openai,
                    modelCandidates: smartModelCandidates,
                    rawMessage: weighinMessageForParse,
                    userTimeZone,
                  });
                  usageSnapshot = mergeUsageSnapshots(usageSnapshot, textWeighin.usage);
                  if (textWeighin.usage) {
                    addNutritionUsageRecord(userId, {
                      guidedAction: 'log_weighin_text_parser',
                      model: textWeighin.model,
                      inputTokens: textWeighin.usage.inputTokens,
                      outputTokens: textWeighin.usage.outputTokens,
                      totalTokens: textWeighin.usage.totalTokens,
                      reasoningTokens: textWeighin.usage.reasoningTokens,
                      cachedTokens: textWeighin.usage.cachedTokens,
                      rawUsage: textWeighin.usage.rawUsage,
                    });
                  }
                  if (textWeighin.action === 'ask_clarification') {
                    return textWeighin.clarificationQuestion;
                  }
                  if (textWeighin.action === 'weighin_ready' && textWeighin.parsed?.ok) {
                    parsed = textWeighin.parsed;
                    rawInputForPersist = rawInputForPersist || textWeighin.rawInput || weighinMessageForParse;
                  }
                } catch (textWeighinError) {
                  console.error('[nutrition-runtime] weighin text parser failed', textWeighinError);
                }
              }

              if (!parsed) {
                parsed = parseWeighinPayload({
                  rawMessage: weighinMessageForParse,
                  userTimeZone,
                });
                rawInputForPersist = rawInputForPersist || weighinMessageForParse;
              }
            }

            if (!parsed?.ok) {
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
                rawInput:
                  rawInputForPersist ||
                  serializeWeighinRawInput({
                    temporal: parsed.temporal,
                    weighin: parsed.weighin,
                  }),
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

            if (replaceTarget && weighinWrite.idempotencyStatus !== 'replayed') {
              const replacedDelete = deleteNutritionWeighin(userId, replaceTarget.weighinId);
              if (!replacedDelete?.ok || !replacedDelete.deleted) {
                replacementDeleteNotice =
                  '⚠️ Guardé la corrección, pero no pude eliminar el OCR anterior. Si querés, borrá manualmente el pesaje duplicado.';
              }
            }

            const persistedWeighinId =
              Number(weighinWrite.weighinId || 0) || Number(getLatestNutritionWeighin(userId)?.id || 0);

            if (shouldTrackRecentImageWeighin && persistedWeighinId > 0) {
              setRecentImageWeighinAction(recentImageWeighinActionByUser, userId, {
                weighinId: persistedWeighinId,
                temporal: {
                  loggedAt: parsed.temporal.loggedAt,
                  localDate: parsed.temporal.localDate,
                  localTime: parsed.temporal.localTime,
                  timeZone: parsed.temporal.timeZone,
                },
                rawInput:
                  rawInputForPersist ||
                  serializeWeighinRawInput({
                    temporal: parsed.temporal,
                    weighin: parsed.weighin,
                  }),
                awaitingCorrection: false,
              });
            } else if (!shouldTrackRecentImageWeighin) {
              clearRecentImageWeighinAction(recentImageWeighinActionByUser, userId);
            }

            const optionalLines = formatWeighinOptionalLines(parsed.weighin);
            const idempotencyNotice = formatIdempotencyNotice(weighinWrite.idempotencyStatus);
            if (weighinReplyMode === 'saved' || weighinReplyMode === 'modified') {
              replyText = buildWeighinAutoSavedReply({
                parsed,
                confidence: weighinReplyMode === 'saved' ? imageOcrConfidence : '',
                idempotencyNotice: [idempotencyNotice, replacementDeleteNotice].filter(Boolean).join('\n'),
                mode: weighinReplyMode,
              });
            } else {
              replyText = [
                `Fecha: ${parsed.temporal.localDate} | Hora: ${parsed.temporal.localTime}`,
                '✅ Pesaje registrado.',
                `⚖️ Peso: ${Number(parsed.weighin.weightKg).toFixed(1)} kg`,
                ...optionalLines,
                idempotencyNotice,
              ]
                .filter(Boolean)
                .join('\n');
            }
            shouldCharge = true;
          } // end else (not delete intent)
        } // end else (not cancel flow)
      } else if (guidedAction === 'learning_chat') {
        // Tutorial menu navigation (no LLM cost)
        if (cleanMessage.startsWith('tutorial:menu_')) {
          const level = cleanMessage.replace('tutorial:menu_', '');
          if (level === 'niveles') {
            replyText = '📚 Elegí un nivel de tutoriales:';
            shouldCharge = false;
          } else {
            replyText = buildTutorialLevelMenu(level);
            shouldCharge = false;
          }
        // Tutorial content (LLM)
        } else if (cleanMessage.startsWith('tutorial:') && !cleanMessage.startsWith('tutorial:menu_')) {
          const slug = cleanMessage.replace('tutorial:', '');
          const tutorialMeta = TUTORIAL_CONTENT_MAP[slug];
          if (tutorialMeta) {
            const tutorialResult = await generateTutorialContentWithModel({
              openai,
              modelCandidates: smartModelCandidates,
              title: tutorialMeta.title,
              userProfile: profile,
            });
            usageSnapshot = mergeUsageSnapshots(usageSnapshot, tutorialResult.usage);
            replyText = [
              `📖 ${tutorialMeta.title}`,
              '',
              tutorialResult.content || 'No pude generar el contenido ahora. Reintentá.',
              '',
              'Podés seguir preguntando sobre este tema o elegir otro tutorial.',
            ].join('\n');
            shouldCharge = true;
          } else {
            replyText = 'No encontré ese tutorial. Elegí uno de los botones disponibles.';
            shouldCharge = false;
          }
        } else {
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
        } // end else (not tutorial)
      } else {
        // log_intake handler
        const intakeActionPlan = planNutritionAction({
          rawMessage: cleanMessage,
          hasMedia,
          userTimeZone,
        });
        const pendingIntakeContext = getPendingIntakeOperationContext(
          pendingIntakeOperationContextByUser,
          userId
        );
        let resolvedIntakeIntent = intakeActionPlan.intent;
        if (resolvedIntakeIntent === 'intake_reference' && pendingIntakeContext?.operation === 'modify') {
          resolvedIntakeIntent = 'modify_intake';
        } else if (
          resolvedIntakeIntent === 'intake_reference' &&
          pendingIntakeContext?.operation === 'delete'
        ) {
          resolvedIntakeIntent = 'delete_intake';
        }

        if (resolvedIntakeIntent === 'query_intakes') {
          const temporal = resolveTemporalContext({
            rawMessage: cleanMessage || 'hoy',
            userTimeZone,
          });
          const rows = listNutritionIntakesByDate(userId, temporal.localDate, { limit: 80 });
          replyText = formatRecentIntakesReply({
            title: `🧾 Ingestas del ${temporal.localDate}`,
            rows,
            localDate: temporal.localDate,
          });
          shouldCharge = false;
        } else if (resolvedIntakeIntent === 'modify_intake') {
          const explicitIntakeId = intakeActionPlan.explicitIntakeId;
          const recentRows = listRecentNutritionIntakes(userId, { limit: 40 });
          if (!recentRows.length) {
            clearPendingIntakeOperationContext(pendingIntakeOperationContextByUser, userId);
            return 'No tengo ingestas recientes para modificar.';
          }

          const contextTemporal =
            pendingIntakeContext?.operation === 'modify' ? pendingIntakeContext.requestedTemporal || null : null;
          const effectiveTemporalHint = intakeActionPlan.hasExplicitTemporal
            ? intakeActionPlan.temporalHints
            : contextTemporal || null;
          if (
            !effectiveTemporalHint ||
            (!effectiveTemporalHint.hadExplicitDate && !effectiveTemporalHint.hadExplicitTime)
          ) {
            return [
              'Para modificar una ingesta, pasame al menos fecha u hora real.',
              'Ejemplos: `modificar fernet con coca cola fecha 03 de abril`, `modificar la última ingesta hora 23:30` o `modificar ingesta ID 123 hora 23:30`.',
            ].join('\n');
          }

          let targetId = explicitIntakeId || null;
          let targetRow = explicitIntakeId ? findNutritionIntakeById(userId, explicitIntakeId) : null;
          if (explicitIntakeId && !targetRow) {
            return `No encontré la ingesta ID ${explicitIntakeId}.`;
          }

          const contextRows =
            pendingIntakeContext?.operation === 'modify' && Array.isArray(pendingIntakeContext.candidateRows)
              ? pendingIntakeContext.candidateRows
              : [];
          const candidateRows = contextRows.length ? contextRows : recentRows;
          if (!targetRow) {
            const deterministic = resolveIntakeTargetDeterministic({
              rawMessage: cleanMessage,
              candidateRows,
              explicitIntakeId: null,
              userTimeZone,
            });
            if (deterministic.action !== 'cannot_identify') {
              targetId =
                deterministic.action === 'delete_last'
                  ? Number(candidateRows[0]?.id)
                  : Number(deterministic.targetId);
              targetRow = recentRows.find((row) => Number(row?.id) === Number(targetId)) || null;
            }
          }

          if (!targetRow) {
            const modifyTarget = await resolveDeleteTargetWithModel({
              openai,
              modelCandidates: smartModelCandidates,
              rawMessage: cleanMessage,
              candidateRows,
              entityType: 'intake',
              rowsLabel: 'recientes',
              intentLabel: 'modificar',
            });
            usageSnapshot = mergeUsageSnapshots(usageSnapshot, modifyTarget.usage);
            if (modifyTarget.action !== 'cannot_identify') {
              targetId =
                modifyTarget.action === 'delete_last'
                  ? Number(candidateRows[0]?.id)
                  : Number(modifyTarget.targetId);
              targetRow = recentRows.find((row) => Number(row?.id) === Number(targetId)) || null;
            }
          }

          if (!targetId || !targetRow) {
            const list = recentRows
              .slice(0, 8)
              .map((r) => {
                const qty = [r.quantityValue, r.quantityUnit].filter(Boolean).join(' ');
                return `- ID ${r.id} | ${r.localDate} ${r.localTime || '?'} → ${r.foodItem}${qty ? ` ${qty}` : ''}`;
              })
              .join('\n');
            setPendingIntakeOperationContext(pendingIntakeOperationContextByUser, userId, {
              operation: 'modify',
              candidateRows: recentRows.slice(0, 20),
              requestedTemporal: effectiveTemporalHint,
            });
            return [
              'No pude identificar cuál ingesta querés modificar.',
              'Referenciá el ID, item o la hora (por ejemplo: `la de las 23:30`).',
              'Ejemplo: `modificar ingesta ID 123 fecha 03 de abril`.',
              '',
              `Ingestas recientes:\n${list}`,
            ].join('\n');
          }

          clearPendingIntakeOperationContext(pendingIntakeOperationContextByUser, userId);
          const nextLocalDate = effectiveTemporalHint.hadExplicitDate
            ? effectiveTemporalHint.localDate
            : String(targetRow.localDate || '').trim();
          const nextLocalTime = effectiveTemporalHint.hadExplicitTime
            ? effectiveTemporalHint.localTime
            : String(targetRow.localTime || '').trim();
          if (!nextLocalDate || !nextLocalTime) {
            return 'No pude resolver la fecha/hora destino de la modificación.';
          }

          const mergedTemporal = resolveTemporalContext({
            rawMessage: `${nextLocalDate} ${nextLocalTime}`,
            userTimeZone,
          });
          const updated = updateNutritionIntakeTemporal(userId, targetId, {
            loggedAt: mergedTemporal.loggedAt,
            localDate: nextLocalDate,
            localTime: nextLocalTime,
            timezone: mergedTemporal.timeZone,
            rawInput: cleanMessage,
          });
          if (!updated?.ok) {
            return formatWriteFailureReply('log_intake', updated?.error || 'db_write_failed');
          }
          if (!updated.updated) {
            return 'No pude modificar esa ingesta porque ya no estaba disponible.';
          }

          const quantity = [targetRow.quantityValue, targetRow.quantityUnit].filter(Boolean).join(' ');
          const summary = getNutritionSummary(userId, nextLocalDate);
          const status = calculateProfileStatus(profile, summary.today);
          replyText = [
            '✅ Ingesta modificada.',
            `- ID: ${targetId}`,
            `- Item: ${targetRow.foodItem}${quantity ? ` (${quantity})` : ''}`,
            `- Nueva fecha/hora: ${nextLocalDate} ${nextLocalTime}`,
            formatMacroLine('📊 Día actualizado: ', summary.today),
            `🎯 Estado vs objetivo: ${status}`,
            '🆔 Tip: `modificar ingesta ID <id> ...` o `borrar ingesta ID <id>`.',
          ].join('\n');
          shouldCharge = true;
        } else if (resolvedIntakeIntent === 'delete_intake') {
          const explicitIntakeId = intakeActionPlan.explicitIntakeId;
          const recentRows = listRecentNutritionIntakes(userId, { limit: 40 });
          if (!recentRows.length) {
            clearPendingIntakeOperationContext(pendingIntakeOperationContextByUser, userId);
            return 'No tengo ingestas recientes para eliminar.';
          }

          let targetId = explicitIntakeId || null;
          let targetRow = explicitIntakeId ? findNutritionIntakeById(userId, explicitIntakeId) : null;
          if (explicitIntakeId && !targetRow) {
            return `No encontré la ingesta ID ${explicitIntakeId}.`;
          }

          const contextRows =
            pendingIntakeContext?.operation === 'delete' && Array.isArray(pendingIntakeContext.candidateRows)
              ? pendingIntakeContext.candidateRows
              : [];
          const candidateRows = contextRows.length ? contextRows : recentRows;
          if (!targetRow) {
            const deterministic = resolveIntakeTargetDeterministic({
              rawMessage: cleanMessage,
              candidateRows,
              explicitIntakeId: null,
              userTimeZone,
            });
            if (deterministic.action !== 'cannot_identify') {
              targetId =
                deterministic.action === 'delete_last'
                  ? Number(candidateRows[0]?.id)
                  : Number(deterministic.targetId);
              targetRow = recentRows.find((row) => Number(row?.id) === Number(targetId)) || null;
            }
          }

          if (!targetRow) {
            const deleteResult = await resolveDeleteTargetWithModel({
              openai,
              modelCandidates: smartModelCandidates,
              rawMessage: cleanMessage,
              candidateRows,
              entityType: 'intake',
              rowsLabel: 'recientes',
              intentLabel: 'borrar',
            });
            usageSnapshot = mergeUsageSnapshots(usageSnapshot, deleteResult.usage);
            if (deleteResult.action !== 'cannot_identify') {
              targetId =
                deleteResult.action === 'delete_last'
                  ? Number(candidateRows[0]?.id)
                  : Number(deleteResult.targetId);
              targetRow = recentRows.find((row) => Number(row?.id) === Number(targetId)) || null;
            }
          }

          if (!targetId || !targetRow) {
            const list = recentRows
              .slice(0, 8)
              .map((r) => {
                const qty = [r.quantityValue, r.quantityUnit].filter(Boolean).join(' ');
                return `- ID ${r.id} | ${r.localDate} ${r.localTime || '?'} → ${r.foodItem}${qty ? ` ${qty}` : ''}`;
              })
              .join('\n');
            setPendingIntakeOperationContext(pendingIntakeOperationContextByUser, userId, {
              operation: 'delete',
              candidateRows: recentRows.slice(0, 20),
            });
            return `No identifiqué cuál borrar.\n${list}\nDecime cuál: "borrá ingesta ID 123", "borrá el pollo de las 13:30" o "borrá la última".`;
          }

          clearPendingIntakeOperationContext(pendingIntakeOperationContextByUser, userId);
          const deleted = deleteNutritionIntake(userId, targetId);
          if (!deleted?.ok || !deleted.deleted) {
            return '❌ No pude eliminar ese registro. Puede que ya no exista.';
          }
          const summary = getNutritionSummary(userId, String(targetRow.localDate || '').trim());
          const status = calculateProfileStatus(profile, summary.today);
          const quantity = [targetRow.quantityValue, targetRow.quantityUnit].filter(Boolean).join(' ');
          replyText = [
            '✅ Registro eliminado.',
            `- ID: ${targetId}`,
            `- Item: ${targetRow.foodItem}${quantity ? ` (${quantity})` : ''}`,
            `- Fecha/hora: ${targetRow.localDate || '?'} ${targetRow.localTime || '?'}`,
            formatMacroLine(`📊 ${targetRow.localDate || 'día'} actualizado: `, summary.today),
            `🎯 Estado vs objetivo: ${status}`,
          ].join('\n');
          shouldCharge = true;
        } else {

        const catalogCandidates = cleanMessage
          ? findFoodCatalogCandidates(cleanMessage, { limit: 60 })
          : [];
        const defaultRowsRaw = listNutritionUserProductDefaults(userId, { limit: 30 });
        const defaultRowsAsCatalog = mapDefaultRowsToPreferredCatalogRows(defaultRowsRaw);
        const userCatalogHistoryRows = listNutritionUserCatalogUsage(userId, { limit: 40 });
        const userCatalogHistoryAsCatalog = userCatalogHistoryRows.map((row) => ({
          id: Number(row?.catalogItemId || row?.id) || null,
          productName: String(row?.productName || '').trim(),
          brand: String(row?.brand || '').trim(),
          normalizedName: String(row?.normalizedName || '').trim(),
          normalizedBrand: String(row?.normalizedBrand || '').trim(),
          portionG: Number(row?.portionG),
          caloriesKcal: Number(row?.caloriesKcal),
          proteinG: Number(row?.proteinG),
          carbsG: Number(row?.carbsG),
          fatG: Number(row?.fatG),
          source: String(row?.source || '').trim() || 'catalog_history',
          preferenceAlias: String(row?.preferenceAlias || '').trim() || '',
          preferenceUsageCount: Number(row?.preferenceUsageCount || row?.usageCount || 0),
          usageCount: Number(row?.usageCount || 0),
          lastLoggedAt: String(row?.lastLoggedAt || '').trim(),
        }));
        const userDefaultMatches = cleanMessage
          ? findNutritionUserPreferredCatalogEntries(userId, cleanMessage, { limit: 40 })
          : [];
        const userDefaultRows = mergeCatalogRows(
          userDefaultMatches,
          mergeCatalogRows(defaultRowsAsCatalog, userCatalogHistoryAsCatalog)
        );
        const catalogFallbackRows = listFoodCatalogEntries().slice(0, 160);
        const catalogRowsForParsing = mergeCatalogRows(
          userDefaultRows,
          mergeCatalogRows(
            userCatalogHistoryAsCatalog,
            mergeCatalogRows(catalogCandidates, catalogFallbackRows)
          )
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
        let parsedBatch = null;
        let intakeParseStage = 'none';
        const parseStartedAtMs = Date.now();
        const emitIntakeParseTrace = ({
          ok = false,
          reasonCode = '',
          stage = intakeParseStage,
          unresolvedCount = 0,
          isBatch = false,
        } = {}) => {
          recordIntakeParseTrace(userId, {
            ok,
            stage,
            reasonCode,
            unresolvedCount,
            latencyMs: Date.now() - parseStartedAtMs,
            hasMedia,
            isBatch,
          });
        };

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
              intakeParseStage = 'image_draft_confirm';
            }
          }
        }

        if (
          !parsed &&
          !hasMedia &&
          cleanMessage &&
          (resolvedIntakeIntent === 'log_intake_batch' || isLikelyBatchIntakeMessage(cleanMessage))
        ) {
          parsedBatch = await parseBatchIntakeTextWithModels({
            openai,
            modelCandidates: smartModelCandidates,
            rawMessage: cleanMessage,
            userId,
            userTimeZone,
            catalogRowsForParsing,
            userDefaultRows,
            userCatalogHistoryRows,
            catalogRowsForNormalization,
          });
          usageSnapshot = mergeUsageSnapshots(usageSnapshot, parsedBatch?.usage);
          if (parsedBatch?.usage) {
            addNutritionUsageRecord(userId, {
              guidedAction: 'log_intake_batch_parser',
              model: 'mixed_batch',
              inputTokens: parsedBatch.usage.inputTokens,
              outputTokens: parsedBatch.usage.outputTokens,
              totalTokens: parsedBatch.usage.totalTokens,
              reasoningTokens: parsedBatch.usage.reasoningTokens,
              cachedTokens: parsedBatch.usage.cachedTokens,
              rawUsage: parsedBatch.usage.rawUsage,
            });
          }
          if (!parsedBatch?.ok) {
            if (
              parsedBatch?.error === 'batch_partial_resolution' &&
              Array.isArray(parsedBatch.entries) &&
              parsedBatch.entries.length
            ) {
              parsedBatch = {
                ...parsedBatch,
                ok: true,
                partial: true,
                rows: Array.isArray(parsedBatch.rows)
                  ? parsedBatch.rows
                  : parsedBatch.entries.flatMap((entry) => entry?.rowsWithTemporal || []),
              };
              intakeParseStage = 'batch_partial';
            } else {
              emitIntakeParseTrace({
                ok: false,
                stage: 'batch',
                reasonCode: String(parsedBatch?.error || 'batch_parse_failed'),
                unresolvedCount: Array.isArray(parsedBatch?.failedLines)
                  ? parsedBatch.failedLines.length
                  : 0,
                isBatch: true,
              });
              return buildBatchIntakeFailureReply(parsedBatch.failedLines || []);
            }
          } else {
            intakeParseStage = 'batch';
          }
          includeConfidenceInReply = includeConfidenceInReply || Boolean(parsedBatch.includeConfidenceInReply);
          shouldRequestLabelPhotoHint =
            shouldRequestLabelPhotoHint || Boolean(parsedBatch.shouldRequestLabelPhotoHint);
        }

        let imageMealResult = null;
        if (!parsedBatch && !parsed && hasMedia) {
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
        if (!parsedBatch && !parsed && shouldTryLabelExtraction) {
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
          !parsedBatch &&
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
            intakeParseStage = 'image_meal';
          }
        }

        if (!parsedBatch && !parsed && hasMedia && !cleanMessage && imageMealResult?.action === 'not_food') {
          return [
            'No detecté una comida registrable en la foto.',
            'Si querés, mandame otra foto más clara o texto simple: `hora + lo ingerido`.',
          ].join('\n');
        }

        if (!parsedBatch && !parsed?.ok && cleanMessage) {
          try {
            modelStructured = await parseStructuredIntakeWithModel({
              openai,
              modelCandidates: smartModelCandidates,
              rawMessage: cleanMessage,
              userTimeZone,
              catalogRows: catalogRowsForParsing,
              userDefaultRows,
              userCatalogHistoryRows,
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

        if (
          !parsedBatch &&
          !parsed?.ok &&
          modelStructured?.action === 'log_intake' &&
          modelStructured.items?.length
        ) {
          const parsedFromStructured = buildParsedIntakeFromStructured({
            userId,
            rawMessage: cleanMessage,
            userTimeZone,
            structured: modelStructured,
            catalogRows: catalogRowsForParsing,
            userDefaultRows,
            inferenceSource: 'text_structured',
          });
          if (parsedFromStructured.ok) {
            parsed = enforceExplicitTemporalFromRawMessage({
              rawMessage: cleanMessage,
              userTimeZone,
              parsed: parsedFromStructured,
            });
            intakeParseStage = 'structured';
          }
        }

        if (!parsedBatch && !parsed?.ok && cleanMessage) {
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

        if (
          !parsedBatch &&
          !parsed?.ok &&
          modelNormalization?.action === 'normalize_intake' &&
          modelNormalization.normalizedText
        ) {
          const parsedFromModel = parseIntakePayload({
            rawMessage: modelNormalization.normalizedText,
            userTimeZone,
          });
          if (parsedFromModel.ok) {
            parsed = enforceExplicitTemporalFromRawMessage({
              rawMessage: cleanMessage,
              userTimeZone,
              parsed: parsedFromModel,
            });
            intakeParseStage = 'normalized';
          }
        }

        if (!parsedBatch && !parsed?.ok && cleanMessage) {
          lexicalParsed = parseIntakePayload({
            rawMessage: cleanMessage,
            userTimeZone,
          });
          if (lexicalParsed?.ok) {
            parsed = enforceExplicitTemporalFromRawMessage({
              rawMessage: cleanMessage,
              userTimeZone,
              parsed: lexicalParsed,
            });
            intakeParseStage = 'lexical';
          } else {
            parsed = lexicalParsed;
          }
        }

        if (!parsedBatch && (modelStructured?.shouldRequestLabelPhoto || modelNormalization?.shouldRequestLabelPhoto)) {
          shouldRequestLabelPhotoHint = true;
        }

        if (!parsedBatch && !parsed?.ok) {
          if (
            modelStructured?.action === 'ask_label_photo' ||
            (modelStructured?.shouldRequestLabelPhoto && !lexicalParsed?.ok)
          ) {
            emitIntakeParseTrace({ ok: false, stage: intakeParseStage, reasonCode: 'ask_label_photo' });
            return [
              'Para registrar ese producto con buena precision necesito la etiqueta nutricional.',
              'Mandame foto clara de la tabla (porción, kcal, proteínas, carbos, grasas).',
              'Con eso lo agrego a INFO_NUTRICIONAL y te queda para siempre.',
              buildPhotoHintLine(),
            ].join('\n');
          }
          if (modelStructured?.action === 'ask_clarification' && modelStructured.clarificationQuestion) {
            emitIntakeParseTrace({ ok: false, stage: intakeParseStage, reasonCode: 'ask_clarification_structured' });
            return [modelStructured.clarificationQuestion, buildPhotoHintLine()].join('\n');
          }
          if (modelNormalization?.action === 'ask_label_photo') {
            emitIntakeParseTrace({ ok: false, stage: intakeParseStage, reasonCode: 'ask_label_photo_normalized' });
            return [
              'Para registrar ese producto con buena precision necesito la etiqueta nutricional.',
              'Mandame foto clara de la tabla (porción, kcal, proteínas, carbos, grasas).',
              'Con eso lo agrego a INFO_NUTRICIONAL y te queda para siempre.',
              buildPhotoHintLine(),
            ].join('\n');
          }
          if (modelNormalization?.action === 'ask_clarification' && modelNormalization.clarificationQuestion) {
            emitIntakeParseTrace({ ok: false, stage: intakeParseStage, reasonCode: 'ask_clarification_normalized' });
            return [modelNormalization.clarificationQuestion, buildPhotoHintLine()].join('\n');
          }
          if (parsed?.error === 'partial_resolution' && parsed.unresolvedItems?.length) {
            emitIntakeParseTrace({
              ok: false,
              stage: intakeParseStage,
              reasonCode: 'partial_resolution',
              unresolvedCount: parsed.unresolvedItems.length,
            });
            return [
              'Necesito aclarar algunos items antes de registrar.',
              `No pude interpretar: ${parsed.unresolvedItems.join(', ')}`,
              'Mandalo en formato simple por item: `hora alimento cantidad`.',
              buildPhotoHintLine(),
            ].join('\n');
          }
          if (hasMedia && !cleanMessage) {
            emitIntakeParseTrace({ ok: false, stage: intakeParseStage, reasonCode: 'unclear_image' });
            return [
              'No pude inferir la comida con suficiente claridad.',
              'Si querés, mandame otra foto más nítida o texto simple: `hora + lo ingerido`.',
            ].join('\n');
          }
          emitIntakeParseTrace({
            ok: false,
            stage: intakeParseStage,
            reasonCode: String(parsed?.error || 'parse_failed'),
          });
          return [
            'No pude detectar una ingesta registrable.',
            'Formato recomendado: `13:30 200g pollo + 150g arroz`.',
            buildPhotoHintLine(),
          ].join('\n');
        }

        if (!parsedBatch && parsed?.ok && cleanMessage && NUTRITION_STRICT_SEMANTIC_GUARDRAIL) {
          parsed = enforceExplicitTemporalFromRawMessage({
            rawMessage: cleanMessage,
            userTimeZone,
            parsed,
          });
          const strictAlignmentRequired = !hasMedia;
          const alignmentEvaluation = strictAlignmentRequired
            ? evaluateParsedItemsAlignment({
                rawMessage: cleanMessage,
                parsedItems: parsed?.items || [],
              })
            : {
                aligned: parsedItemsHaveAnyUserOverlap({
                  rawMessage: cleanMessage,
                  parsedItems: parsed?.items || [],
                }),
                reason: 'non_strict_media_alignment',
              };
          const alignedWithUserInput = Boolean(alignmentEvaluation?.aligned);
          if (!alignedWithUserInput) {
            const repaired = tryRepairParsedFromStructured({
              rawMessage: cleanMessage,
              userTimeZone,
              modelStructured,
              userId,
              catalogRows: catalogRowsForParsing,
              userDefaultRows,
            });
            if (repaired?.ok) {
              parsed = repaired;
            } else {
              emitIntakeParseTrace({
                ok: false,
                stage: intakeParseStage,
                reasonCode: `semantic_mismatch:${String(alignmentEvaluation?.reason || 'unknown')}`,
              });
              return buildIntakeSemanticMismatchReply();
            }
          }
        }

        if (!parsedBatch && parsedHasEstimatedRows(parsed)) {
          includeConfidenceInReply = true;
          if (!shouldRequestLabelPhotoHint) {
            shouldRequestLabelPhotoHint = parsed.items.some((item) =>
              looksLikePackagedAlias(item?.inputAlias || item?.foodItem)
            );
          }
        }

        const intakeWrites = [];
        let intakeRowsForReply = [];
        if (parsedBatch?.ok) {
          const entries = Array.isArray(parsedBatch.entries) ? parsedBatch.entries : [];
          for (let index = 0; index < entries.length; index += 1) {
            const entry = entries[index];
            const writeResult = addNutritionIntakes(
              userId,
              {
                loggedAt: entry?.temporal?.loggedAt,
                localDate: entry?.temporal?.localDate,
                localTime: entry?.temporal?.localTime,
                timezone: entry?.temporal?.timeZone,
                rawInput: entry?.sourceLine || cleanMessage,
                items: entry?.items || [],
              },
              {
                idempotency: {
                  sourceMessageId,
                  operationType: `log_intake_batch_${index}`,
                },
              }
            );
            if (!writeResult?.ok) {
              return formatWriteFailureReply('log_intake', writeResult?.error || 'db_write_failed');
            }
            const entryRowsWithTemporal = Array.isArray(entry?.rowsWithTemporal)
              ? entry.rowsWithTemporal
              : [];
            const entryRowsWithIds = attachInsertedIdsToRows(
              entryRowsWithTemporal,
              writeResult.insertedIds
            );
            intakeRowsForReply.push(...entryRowsWithIds);
            intakeWrites.push(writeResult);
          }
        } else {
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
          intakeRowsForReply = attachInsertedIdsToRows(parsed.items || [], intakeWrite.insertedIds);
          intakeWrites.push(intakeWrite);
        }
        pendingImageIntakeDraftByUser.delete(userId);
        clearPendingIntakeOperationContext(pendingIntakeOperationContextByUser, userId);
        if (!intakeRowsForReply.length) {
          intakeRowsForReply = parsedBatch?.ok
            ? parsedBatch.rows || []
            : Array.isArray(parsed?.items)
              ? parsed.items
              : [];
        }

        for (const parsedItem of intakeRowsForReply) {
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

        const affectedDateRows = parsedBatch?.ok
          ? (parsedBatch.entries || []).map((entry) => ({
              localDate: String(entry?.temporal?.localDate || '').trim(),
              localTime: String(entry?.temporal?.localTime || '').trim(),
            }))
          : [
              {
                localDate: String(parsed?.temporal?.localDate || '').trim(),
                localTime: String(parsed?.temporal?.localTime || '').trim(),
              },
            ];
        const uniqueDates = [...new Set(affectedDateRows.map((row) => row.localDate).filter(Boolean))];
        const summariesByDate = new Map(
          uniqueDates.map((localDate) => [localDate, getNutritionSummary(userId, localDate)])
        );
        for (const dateRow of affectedDateRows) {
          const summaryForDate = summariesByDate.get(dateRow.localDate);
          if (!summaryForDate || !shouldTrackOutlier(summaryForDate)) continue;
          appendNutritionJournal(userId, {
            localDate: dateRow.localDate,
            localTime: dateRow.localTime || '00:00',
            event: 'calorie_outlier',
            notes: `Hoy ${Math.round(summaryForDate.today.caloriesKcal)} kcal vs rolling7 ${Math.round(
              summaryForDate.rolling7d.caloriesKcal
            )} kcal`,
          });
        }

        const primaryTemporal = parsedBatch?.ok
          ? parsedBatch.entries[parsedBatch.entries.length - 1]?.temporal || {}
          : parsed.temporal;
        const primaryDate = String(primaryTemporal?.localDate || '').trim();
        const summary = summariesByDate.get(primaryDate) || getNutritionSummary(userId, primaryDate);
        const status = calculateProfileStatus(profile, summary.today);
        const idempotencyNotice = [...new Set(
          intakeWrites
            .map((write) => formatIdempotencyNotice(write?.idempotencyStatus))
            .filter(Boolean)
        )].join('\n');
        const isBatchFlow = Boolean(parsedBatch?.ok);
        const hasPartialBatchFailures = Boolean(
          parsedBatch?.partial &&
            Array.isArray(parsedBatch?.failedLines) &&
            parsedBatch.failedLines.length
        );
        const unresolvedBatchPreview = hasPartialBatchFailures
          ? parsedBatch.failedLines
              .slice(0, 6)
              .map((row) => `- ${row?.line || '(línea vacía)'}`)
              .join('\n')
          : '';
        const summaryLines =
          uniqueDates.length <= 1
            ? [
                formatMacroLine('📊 Hoy: ', summary.today),
                formatMacroLine('📅 Rolling 7d: ', summary.rolling7d),
                formatMacroLine('🗓️ Rolling 14d: ', summary.rolling14d),
              ]
            : uniqueDates.map((localDate) => {
                const localSummary = summariesByDate.get(localDate);
                return formatMacroLine(`📊 ${localDate}: `, localSummary?.today || {});
              });

        emitIntakeParseTrace({
          ok: true,
          stage: intakeParseStage || (isBatchFlow ? 'batch' : 'unknown'),
          reasonCode: parsedBatch?.partial ? 'batch_partial_saved' : 'saved',
          unresolvedCount:
            parsedBatch?.partial && Array.isArray(parsedBatch?.failedLines)
              ? parsedBatch.failedLines.length
              : 0,
          isBatch: isBatchFlow,
        });
        replyText = [
          isBatchFlow
            ? `✅ OK, quedaron anotadas ${parsedBatch.entries.length} ingestas.`
            : `Fecha: ${parsed.temporal.localDate} | Hora: ${parsed.temporal.localTime}`,
          isBatchFlow ? `Fecha base: ${primaryDate}` : 'OK, quedó anotado.',
          hasPartialBatchFailures
            ? `⚠️ Algunas líneas no se pudieron registrar:\n${unresolvedBatchPreview}\nCorregilas en texto simple (ej: \`13:30 200g pollo + 150g arroz\`).`
            : null,
          ...buildIntakeDetailsBlock({
            title: isBatchFlow ? '🧾 Detalle registrado (por línea)' : '🧾 Detalle registrado',
            rows: intakeRowsForReply,
            includeTime: isBatchFlow,
            includeConfidence:
              includeConfidenceInReply ||
              intakeRowsForReply.some((item) => String(item?.inferenceSource || '') === 'image'),
            chronological: false,
          }),
          ...summaryLines,
          `🎯 Estado: ${status}`,
          (isBatchFlow
            ? intakeRowsForReply.some((item) => itemUsesEstimatedResolution(item))
            : parsedHasEstimatedRows(parsed))
            ? '🧠 Registré al menos un item con valores estimados. Si querés más precisión, mandame foto del frente + tabla nutricional.'
            : null,
          intakeRowsForReply.some((row) => toPositiveIntOrNull(row?.id))
            ? '🆔 Para borrar/modificar: `borrar ingesta ID <id>` o `modificar ingesta ID <id> hora 23:30`.'
            : null,
          shouldRequestLabelPhotoHint
            ? '📦 Si es un producto de paquete, mandame foto de la etiqueta nutricional y lo agrego a INFO_NUTRICIONAL.'
            : null,
          idempotencyNotice,
        ]
          .filter(Boolean)
          .join('\n');
        shouldCharge = true;
        } // end else (not delete intent)
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
    statusProvider: () => ({
      telegram: typeof telegram?.getRuntimeStatus === 'function' ? telegram.getRuntimeStatus() : null,
      nutritionDbReliability: typeof nutritionDbReliability?.getStatus === 'function'
        ? nutritionDbReliability.getStatus()
        : null,
    }),
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
