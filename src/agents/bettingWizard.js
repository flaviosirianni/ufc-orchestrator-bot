import fs from 'node:fs';
import path from 'node:path';
import OpenAI from 'openai';
import '../core/env.js';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.BETTING_MODEL || 'gpt-4.1-mini';
const DECISION_MODEL = process.env.BETTING_DECISION_MODEL || '';
const TEMPERATURE = Number(process.env.BETTING_TEMPERATURE ?? '0.35');
const KNOWLEDGE_FILE =
  process.env.KNOWLEDGE_FILE || './Knowledge/ufc_bets_playbook.md';
const RESOLVED_KNOWLEDGE_PATH = path.resolve(process.cwd(), KNOWLEDGE_FILE);
const KNOWLEDGE_MAX_CHARS = Number(process.env.KNOWLEDGE_MAX_CHARS ?? '9000');
const MAX_RECENT_TURNS = Number(process.env.BETTING_MAX_RECENT_TURNS ?? '8');
const MAX_TOOL_ROUNDS = Number(process.env.BETTING_MAX_TOOL_ROUNDS ?? '4');
const MAX_HISTORY_PREVIEW_ROWS = Number(process.env.BETTING_HISTORY_PREVIEW_ROWS ?? '12');
const WEB_SEARCH_CONTEXT_SIZE = process.env.WEB_SEARCH_CONTEXT_SIZE || 'medium';
const WEB_SEARCH_COUNTRY = process.env.WEB_SEARCH_COUNTRY || 'US';
const WEB_SEARCH_REGION = process.env.WEB_SEARCH_REGION || null;
const WEB_SEARCH_CITY = process.env.WEB_SEARCH_CITY || null;
const DEFAULT_USER_TIMEZONE =
  process.env.DEFAULT_USER_TIMEZONE || process.env.WEB_SEARCH_TIMEZONE || 'America/Argentina/Buenos_Aires';
const WEB_SEARCH_TIMEZONE = process.env.WEB_SEARCH_TIMEZONE || DEFAULT_USER_TIMEZONE;
const SHOW_SOURCES_BY_DEFAULT = process.env.SHOW_SOURCES_BY_DEFAULT === 'true';
const CREDIT_ENFORCE = process.env.CREDIT_ENFORCE !== 'false';
const CREDIT_FREE_WEEKLY = Number(process.env.CREDIT_FREE_WEEKLY ?? '5');
const CREDIT_DECISION_COST = Number(process.env.CREDIT_DECISION_COST ?? '1');
const CREDIT_IMAGE_DAILY_FREE = Number(process.env.CREDIT_IMAGE_DAILY_FREE ?? '5');
const CREDIT_IMAGE_OVERAGE_COST = Number(process.env.CREDIT_IMAGE_OVERAGE_COST ?? '0.5');
const CREDIT_AUDIO_WEEKLY_FREE_MINUTES = Number(
  process.env.CREDIT_AUDIO_WEEKLY_FREE_MINUTES ?? '10'
);
const CREDIT_AUDIO_OVERAGE_COST = Number(process.env.CREDIT_AUDIO_OVERAGE_COST ?? '0.2');
const CREDIT_TOPUP_URL = process.env.CREDIT_TOPUP_URL || '';
const STAKE_MIN_AMOUNT_DEFAULT = Number(process.env.STAKE_MIN_AMOUNT_DEFAULT ?? '2000');
const STAKE_MIN_UNITS_DEFAULT = Number(process.env.STAKE_MIN_UNITS_DEFAULT ?? '2.5');

const INCLUDE_FIELDS = ['web_search_call.action.sources'];

const FUNCTION_TOOLS = [
  {
    type: 'function',
    name: 'get_fighter_history',
    description:
      'Obtiene historial de peleas disponible internamente para los peleadores indicados.',
    parameters: {
      type: 'object',
      properties: {
        fighters: {
          type: 'array',
          items: { type: 'string' },
          description: 'Nombres de peleadores a filtrar. Opcional.',
        },
        query: {
          type: 'string',
          description: 'Texto de referencia para extraer peleadores o tokens de busqueda.',
        },
        strict: {
          type: 'boolean',
          description: 'Si true, exige match mas estricto por nombre completo.',
        },
      },
      additionalProperties: false,
    },
    strict: false,
  },
  {
    type: 'function',
    name: 'get_user_profile',
    description:
      'Lee el perfil de usuario guardado en memoria conversacional (bankroll, unidad, perfil de riesgo, notas, apuestas previas).',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    strict: false,
  },
  {
    type: 'function',
    name: 'update_user_profile',
    description:
      'Actualiza el perfil del usuario cuando provee datos operativos (bankroll, unidad, riesgo, notas).',
    parameters: {
      type: 'object',
      properties: {
        bankroll: { type: 'number' },
        unitSize: { type: 'number' },
        riskProfile: { type: 'string' },
        currency: { type: 'string' },
        timezone: { type: 'string' },
        minStakeAmount: { type: 'number' },
        minUnitsPerBet: { type: 'number' },
        targetEventUtilizationPct: { type: 'number' },
        notes: { type: 'string' },
      },
      additionalProperties: false,
    },
    strict: false,
  },
  {
    type: 'function',
    name: 'record_user_bet',
    description:
      'Registra una NUEVA apuesta del usuario en el ledger. No usar para cerrar/borrar apuestas existentes.',
    parameters: {
      type: 'object',
      properties: {
        eventName: { type: 'string' },
        fight: { type: 'string' },
        pick: { type: 'string' },
        odds: { type: 'number' },
        stake: { type: 'number' },
        units: { type: 'number' },
        result: { type: 'string' },
        notes: { type: 'string' },
      },
      additionalProperties: false,
    },
    strict: false,
  },
  {
    type: 'function',
    name: 'list_user_bets',
    description:
      'Lista apuestas del usuario para resolver referencias y obtener bet_id antes de mutar ledger.',
    parameters: {
      type: 'object',
      properties: {
        eventName: { type: 'string' },
        fight: { type: 'string' },
        pick: { type: 'string' },
        status: {
          type: 'string',
          description: 'pending | win | loss | push',
        },
        includeArchived: { type: 'boolean' },
        limit: { type: 'number' },
      },
      additionalProperties: false,
    },
    strict: false,
  },
  {
    type: 'function',
    name: 'mutate_user_bets',
    description:
      'Actualiza apuestas existentes (settle/set_pending/archive) con guardrails. Para acciones destructivas usa confirmacion en dos pasos.',
    parameters: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          description: 'settle | set_pending | archive',
        },
        result: {
          type: 'string',
          description: 'Requerido en settle: win | loss | push',
        },
        betIds: {
          type: 'array',
          items: { type: 'number' },
          description: 'IDs explicitos de apuestas a mutar.',
        },
        eventName: { type: 'string' },
        fight: { type: 'string' },
        pick: { type: 'string' },
        limit: { type: 'number' },
        confirm: {
          type: 'boolean',
          description: 'true para ejecutar una mutacion previamente previsualizada.',
        },
        confirmationToken: {
          type: 'string',
          description: 'Token devuelto por la previsualizacion requerida.',
        },
        reason: { type: 'string' },
      },
      required: ['operation'],
      additionalProperties: false,
    },
    strict: false,
  },
  {
    type: 'function',
    name: 'undo_last_mutation',
    description:
      'Revierte la ultima mutacion sensible del ledger del usuario (archive/settle/set_pending) dentro de una ventana de tiempo.',
    parameters: {
      type: 'object',
      properties: {
        windowMinutes: {
          type: 'number',
          description: 'Ventana maxima de tiempo para permitir undo.',
        },
      },
      additionalProperties: false,
    },
    strict: false,
  },
  {
    type: 'function',
    name: 'store_user_odds',
    description:
      'Guarda en la base de datos las cuotas/odds provistas por el usuario para una pelea/evento.',
    parameters: {
      type: 'object',
      properties: {
        oddsPayload: {
          type: 'object',
          description:
            'JSON estructurado con event, fight, odds y meta. Incluye sportsbook y usuario.',
          additionalProperties: true,
        },
      },
      required: ['oddsPayload'],
      additionalProperties: false,
    },
    strict: false,
  },
  {
    type: 'function',
    name: 'get_user_odds',
    description:
      'Busca cuotas/odds previamente guardadas para el usuario, segun pelea o evento.',
    parameters: {
      type: 'object',
      properties: {
        fightId: { type: 'string' },
        fighterA: { type: 'string' },
        fighterB: { type: 'string' },
        eventName: { type: 'string' },
        eventDate: { type: 'string' },
      },
      additionalProperties: false,
    },
    strict: false,
  },
  {
    type: 'function',
    name: 'set_event_card',
    description:
      'Guarda en memoria conversacional el evento y sus peleas para resolver referencias como pelea 1 en turnos siguientes.',
    parameters: {
      type: 'object',
      properties: {
        eventName: { type: 'string' },
        date: { type: 'string', description: 'Formato ISO YYYY-MM-DD si se conoce.' },
        fights: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              fighterA: { type: 'string' },
              fighterB: { type: 'string' },
            },
            required: ['fighterA', 'fighterB'],
            additionalProperties: false,
          },
        },
      },
      required: ['fights'],
      additionalProperties: false,
    },
    strict: false,
  },
];

const knowledgeCache = {
  path: null,
  mtimeMs: null,
  snippet: '',
};

function normalise(value = '') {
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function isCalendarQuestion(message = '') {
  const text = normalise(message);
  const hasEventWords =
    /\b(ufc|evento|cartelera|main card|main event|quien pelea|quienes pelean)\b/.test(
      text
    );
  const hasDateOrTimeWords =
    /\b(proximo|proxima|next|upcoming|que viene|siguiente|hoy|manana|mañana|ayer|ahora|en vivo|vivo|live|ultimo|ultima|last|reciente|mas reciente|fecha|cuando|when)\b/.test(
      text
    ) ||
    /\b(20\d{2}-\d{1,2}-\d{1,2}|\d{1,2}[\/-]\d{1,2}|\d{1,2}\s+de\s+[a-z]+)\b/.test(
      text
    );
  return hasEventWords && hasDateOrTimeWords;
}

function hasOddsSignals(message = '') {
  const text = normalise(message);
  if (!text) return false;

  if (
    /\b(cuota|cuotas|odds|quote|quotes|bet365|moneyline|ml|over|under|totales|props)\b/.test(
      text
    )
  ) {
    return true;
  }

  if (/@\s?\d+(\.\d+)?/.test(text)) {
    return true;
  }

  if (/\b(o|u)\s?\d+(\.\d+)?\b/.test(text)) {
    return true;
  }

  if (/\b\d+(\.\d+)?\s?(u|units|unidad|unidades)\b/.test(text)) {
    return true;
  }

  return false;
}

function hasBetDecisionSignals(message = '') {
  const text = normalise(message);
  if (!text) return false;
  return /\b(pick|picks|apuesta|apostar|recomend|stake|valor|ev|valor esperado|prediccion|predicciones|pronostico|pronosticos)\b/.test(
    text
  );
}

function hasOddsRequestSignals(message = '') {
  const text = normalise(message);
  if (!text) return false;
  return /\b(cuota|cuotas|odds|quote|quotes|guardad|guardadas|guardado|bet365)\b/.test(
    text
  );
}

function hasLedgerSignals(message = '') {
  const text = normalise(message);
  if (!text) return false;
  return /\b(ledger|balance|bankroll|apuestas previas|historial de apuestas|mi ledger|mis apuestas)\b/.test(
    text
  );
}

function isLiveFightQueueQuestion(message = '') {
  const text = normalise(message);
  if (!text) return false;
  const asksNextFight =
    /\b(que pelea viene ahora|que pelea sigue|cual pelea sigue|proxima pelea|proxima que viene|que falta|faltan peleas|en vivo|ahora en el evento)\b/.test(
      text
    ) || /\b(pelea)\b/.test(text) && /\b(ahora|sigue|viene)\b/.test(text);
  const hasEventContext = /\b(evento|cartelera|ufc|fight night|main card)\b/.test(text);
  return asksNextFight && hasEventContext;
}

function shouldUseDecisionModel({ message = '', hasMedia = false } = {}) {
  if (!DECISION_MODEL) {
    return false;
  }
  if (hasMedia) {
    return true;
  }
  return hasOddsSignals(message) || hasBetDecisionSignals(message);
}

function getUtcDayIso(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function getWeekBoundsUtc(date = new Date()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() - (day - 1));
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + 7));
  return {
    weekStartIso: start.toISOString(),
    weekEndIso: end.toISOString(),
  };
}

function resolveTopupUrl(userId) {
  if (!CREDIT_TOPUP_URL) {
    return '';
  }
  const value = String(CREDIT_TOPUP_URL);
  const hasPlaceholder =
    value.includes('{user_id}') || value.includes('{telegram_user_id}');
  if (!userId && hasPlaceholder) {
    return '';
  }
  return value
    .replaceAll('{user_id}', encodeURIComponent(String(userId || '')))
    .replaceAll('{telegram_user_id}', encodeURIComponent(String(userId || '')));
}

function buildPaywallMessage({ availableCredits, neededCredits, userId = '' }) {
  const lines = [];
  lines.push('⚠️ Te quedaste sin créditos suficientes para este análisis.');
  lines.push(`Créditos disponibles: ${availableCredits.toFixed(2)}`);
  lines.push(`Créditos necesarios: ${neededCredits.toFixed(2)}`);
  const topupUrl = resolveTopupUrl(userId);
  if (topupUrl) {
    lines.push('', `Recargá créditos acá: ${topupUrl}`);
  } else {
    lines.push('', 'Pedime un link de recarga y te lo paso.');
  }
  return lines.join('\n');
}

function toNumberOrNull(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseDecimalLike(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const normalized = raw.replace(/\s+/g, '').replace(/\.(?=\d{3}(?:\D|$))/g, '').replace(',', '.');
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatArsAmount(amount) {
  const value = Number(amount);
  if (!Number.isFinite(value)) return '$0 ARS';
  const rounded = Math.round(value);
  const formatted = new Intl.NumberFormat('es-AR').format(rounded);
  return `$${formatted} ARS`;
}

function formatUnits(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '0';
  if (Math.abs(num - Math.round(num)) < 1e-9) {
    return String(Math.round(num));
  }
  return num.toFixed(2).replace(/\.?0+$/, '');
}

function truncateText(value = '', maxChars = 900) {
  const text = String(value || '').trim();
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars - 3)}...`;
}

function parseToolArgs(rawArguments = '{}') {
  try {
    if (!rawArguments) {
      return {};
    }
    return JSON.parse(rawArguments);
  } catch {
    return {};
  }
}

function normalizeBetResult(result = '') {
  const value = String(result || '').toLowerCase();
  if (!value.trim()) return null;
  if (
    value.includes('pending') ||
    value.includes('pend') ||
    value.includes('open') ||
    value.includes('abierta')
  ) {
    return 'pending';
  }
  if (
    value.includes('win') ||
    value.includes('won') ||
    value.includes('gan')
  ) {
    return 'win';
  }
  if (
    value.includes('loss') ||
    value.includes('lose') ||
    value.includes('lost') ||
    value.includes('perd')
  ) {
    return 'loss';
  }
  if (
    value.includes('push') ||
    value.includes('draw') ||
    value.includes('void') ||
    value.includes('nula')
  ) {
    return 'push';
  }
  return null;
}

function parseBetIds(rawValue) {
  if (!Array.isArray(rawValue)) {
    return [];
  }
  return rawValue
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0);
}

function resolvedFightLabel(fight = null) {
  if (!fight?.fighterA || !fight?.fighterB) {
    return '';
  }
  return `${fight.fighterA} vs ${fight.fighterB}`.trim();
}

function createMutationToken() {
  return `mut_${Math.random().toString(36).slice(2, 10)}${Date.now()
    .toString(36)
    .slice(-4)}`;
}

function formatMutationActionLabel(operation = '') {
  if (operation === 'archive') return 'ARCHIVE';
  if (operation === 'set_pending') return 'SET_PENDING';
  if (operation === 'settle') return 'SETTLE';
  return operation || 'MUTATION';
}

function normalizeText(value = '') {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function parseConfirmationIntent(message = '') {
  const raw = String(message || '').trim();
  const text = normalizeText(raw);
  const tokens = Array.from(
    new Set((raw.match(/mut_[a-z0-9]+/gi) || []).map((value) => String(value).trim()))
  );

  const hasConfirmWord = /\bconfirm\w*\b/.test(text);
  const hasNegative =
    /\b(no confirm\w*|cancel\w*|anula\w*|deja sin efecto)\b/.test(text);

  const wantsAll = /\b(ambas|ambos|todo|todas|todas las|todo eso)\b/.test(text);
  const wantsArchive = /\b(archiv\w*|borr\w*|elimin\w*|delete)\b/.test(text);
  const wantsSetPending = /\b(pending|pendiente|reabr\w*|volver a pending)\b/.test(text);
  const wantsSettle = /\b(lost|loss|perd\w*|win|won|gan\w*|push|draw|void|nula)\b/.test(
    text
  );

  let settleResult = null;
  if (/\b(lost|loss|perd\w*)\b/.test(text)) {
    settleResult = 'loss';
  } else if (/\b(win|won|gan\w*)\b/.test(text)) {
    settleResult = 'win';
  } else if (/\b(push|draw|void|nula)\b/.test(text)) {
    settleResult = 'push';
  }

  return {
    hasPositive: hasConfirmWord || tokens.length > 0,
    hasNegative,
    tokens,
    wantsAll,
    wantsArchive,
    wantsSetPending,
    wantsSettle,
    settleResult,
  };
}

function isUndoRequest(message = '') {
  const text = normalizeText(message);
  if (!text) return false;
  return /\b(undo|deshace|deshacer|reverti|revertir|corregi ultima|corregir ultima|rollback)\b/.test(
    text
  );
}

function hasAmbiguousFightReference(message = '') {
  const text = normalizeText(message);
  if (!text) return false;
  return /\b(anterior|anteriores|esa|ese|esas|esos|reci[eé]n|recien|la otra|el otro)\b/.test(
    text
  );
}

function normalizeTimeZone(timezone = '') {
  const fallback = DEFAULT_USER_TIMEZONE;
  const candidate = String(timezone || '').trim() || fallback;
  try {
    // Throws on invalid timezone.
    new Intl.DateTimeFormat('en-US', { timeZone: candidate }).format(new Date());
    return candidate;
  } catch {
    return fallback;
  }
}

function extractLocalDateTimeParts(date = new Date(), timezone = DEFAULT_USER_TIMEZONE) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value || '';
  const year = get('year');
  const month = get('month');
  const day = get('day');
  const hour = get('hour');
  const minute = get('minute');
  const second = get('second');
  const dateIso = `${year}-${month}-${day}`;
  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    dateIso,
    dateTimeIso: `${dateIso}T${hour}:${minute}:${second}`,
  };
}

function shiftIsoDate(isoDate, daysDelta) {
  const value = String(isoDate || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() + Number(daysDelta || 0));
  return date.toISOString().slice(0, 10);
}

function extractDateHints(message = '', timezone = DEFAULT_USER_TIMEZONE) {
  const text = String(message || '');
  const hints = [];
  const localNow = extractLocalDateTimeParts(new Date(), timezone);
  const currentYear = Number(localNow.year) || new Date().getUTCFullYear();

  const isoMatch = text.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/);
  if (isoMatch) {
    const iso = `${isoMatch[1]}-${String(isoMatch[2]).padStart(2, '0')}-${String(
      isoMatch[3]
    ).padStart(2, '0')}`;
    hints.push({ source: isoMatch[0], isoDate: iso });
  }

  const slashMatch = text.match(/\b(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{2,4}))?\b/);
  if (slashMatch) {
    const day = Number(slashMatch[1]);
    const month = Number(slashMatch[2]);
    const rawYear = slashMatch[3] ? Number(slashMatch[3]) : currentYear;
    const year = rawYear < 100 ? 2000 + rawYear : rawYear;
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
      const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      hints.push({ source: slashMatch[0], isoDate: iso });
    }
  }

  const normalized = normalizeText(text);
  if (/\bhoy\b/.test(normalized)) {
    hints.push({ source: 'hoy', isoDate: localNow.dateIso });
  }
  if (/\bmanana\b/.test(normalized)) {
    const tomorrow = shiftIsoDate(localNow.dateIso, 1);
    if (tomorrow) {
      hints.push({ source: 'manana', isoDate: tomorrow });
    }
  }
  if (/\bayer\b/.test(normalized)) {
    const yesterday = shiftIsoDate(localNow.dateIso, -1);
    if (yesterday) {
      hints.push({ source: 'ayer', isoDate: yesterday });
    }
  }

  return hints;
}

function buildTemporalContextSection({
  timezone = DEFAULT_USER_TIMEZONE,
  originalMessage = '',
} = {}) {
  const resolvedTimeZone = normalizeTimeZone(timezone);
  const nowLocal = extractLocalDateTimeParts(new Date(), resolvedTimeZone);
  const previousDate = shiftIsoDate(nowLocal.dateIso, -1);
  const nextDate = shiftIsoDate(nowLocal.dateIso, 1);
  const dateHints = extractDateHints(originalMessage, resolvedTimeZone);

  const lines = [
    `timezone: ${resolvedTimeZone}`,
    `as_of_local_datetime: ${nowLocal.dateTimeIso}`,
    `as_of_local_date: ${nowLocal.dateIso}`,
    `window_previous_local_date: ${previousDate || 'N/D'}`,
    `window_next_local_date: ${nextDate || 'N/D'}`,
  ];

  if (dateHints.length) {
    const compact = dateHints.map((hint) => `${hint.source}=>${hint.isoDate}`).join(' | ');
    lines.push(`user_date_hints: ${compact}`);
  }

  return {
    timezone: resolvedTimeZone,
    nowLocal,
    sectionText: lines.join('\n'),
  };
}

function isRecommendationReply(text = '') {
  const normalized = normalizeText(text);
  if (!normalized) return false;
  return /\b(pick|recomendacion|recomendaciones|apuesta|jugaria|jugaria|stake|ev|valor esperado)\b/.test(
    normalized
  );
}

function hasRationaleContent(text = '') {
  const normalized = normalizeText(text);
  if (!normalized) return false;
  const hasCoreReason = /\b(fundamento|por que|tesis|lectura|edge|riesgo)\b/.test(normalized);
  const hasEntryRule = /\b(cuota minima|minima cuota|min odds|si .* @|tomar si)\b/.test(
    normalized
  );
  return hasCoreReason && hasEntryRule;
}

function isLedgerOperationMessage(message = '') {
  const normalized = normalizeText(message);
  if (!normalized) return false;
  return /\b(ledger|bet_id|pending|won|lost|settle|archiv|borra|elimina|cierra|cerra|anota|registro)\b/.test(
    normalized
  );
}

function parseStakePreferenceMessage(message = '') {
  const raw = String(message || '').trim();
  if (!raw) return null;
  const text = normalizeText(raw);
  const hasStakePreferenceIntent =
    /\b(stake minimo|minimo por apuesta|apuesta minima|minimo de stake|minimo por pick|minimo en u|minimo unidades|minimo de unidades)\b/.test(
      text
    ) || /\b(mi stake minimo|mi minimo)\b/.test(text);
  if (!hasStakePreferenceIntent) {
    return null;
  }

  const moneyMatch = raw.match(/\$\s*([0-9][0-9\.\,]*)/);
  const unitsMatch = raw.match(/([0-9]+(?:[.,][0-9]+)?)\s*u(?:nidades?)?\b/i);

  const minStakeAmount = moneyMatch ? parseDecimalLike(moneyMatch[1]) : null;
  const minUnitsPerBet = unitsMatch ? parseDecimalLike(unitsMatch[1]) : null;

  if (minStakeAmount === null && minUnitsPerBet === null) {
    return null;
  }

  return {
    minStakeAmount,
    minUnitsPerBet,
  };
}

function getStakeCalibrationConfig(userProfile = {}) {
  const minStakeAmount = toNumberOrNull(userProfile?.minStakeAmount) ?? STAKE_MIN_AMOUNT_DEFAULT;
  const minUnitsPerBet = toNumberOrNull(userProfile?.minUnitsPerBet) ?? STAKE_MIN_UNITS_DEFAULT;
  const unitSize = toNumberOrNull(userProfile?.unitSize);

  let floorAmount = minStakeAmount;
  let floorUnits = minUnitsPerBet;
  if (unitSize && unitSize > 0) {
    floorAmount = Math.max(minStakeAmount, minUnitsPerBet * unitSize);
    floorUnits = Math.max(minUnitsPerBet, minStakeAmount / unitSize);
  }

  return {
    unitSize,
    minStakeAmount,
    minUnitsPerBet,
    floorAmount,
    floorUnits,
  };
}

function calibrateStakeLine(line = '', config = {}) {
  const text = String(line || '');
  if (!/stake/i.test(text)) {
    return { line: text, changed: false };
  }

  const { floorAmount, floorUnits, unitSize } = config;
  if (!Number.isFinite(floorAmount) && !Number.isFinite(floorUnits)) {
    return { line: text, changed: false };
  }

  const unitsMatch = text.match(/([0-9]+(?:[.,][0-9]+)?)\s*u\b/i);
  const amountMatch = text.match(/\$\s*([0-9][0-9\.\,]*)/);

  const parsedUnits = unitsMatch ? parseDecimalLike(unitsMatch[1]) : null;
  const parsedAmount = amountMatch ? parseDecimalLike(amountMatch[1]) : null;

  let inferredUnits = parsedUnits;
  let inferredAmount = parsedAmount;

  if (inferredUnits === null && inferredAmount !== null && unitSize) {
    inferredUnits = inferredAmount / unitSize;
  }
  if (inferredAmount === null && inferredUnits !== null && unitSize) {
    inferredAmount = inferredUnits * unitSize;
  }

  if (inferredUnits === null && inferredAmount === null) {
    return { line: text, changed: false };
  }

  let targetUnits = inferredUnits ?? floorUnits;
  let targetAmount = inferredAmount ?? floorAmount;

  if (Number.isFinite(floorUnits)) {
    targetUnits = Math.max(targetUnits ?? floorUnits, floorUnits);
  }
  if (Number.isFinite(floorAmount)) {
    targetAmount = Math.max(targetAmount ?? floorAmount, floorAmount);
  }

  if (unitSize) {
    targetAmount = Math.max(targetAmount || 0, targetUnits * unitSize);
    targetUnits = Math.max(targetUnits || 0, targetAmount / unitSize);
  }

  const needsAdjustByUnits =
    inferredUnits !== null && Number.isFinite(floorUnits) && inferredUnits + 1e-9 < floorUnits;
  const needsAdjustByAmount =
    inferredAmount !== null && Number.isFinite(floorAmount) && inferredAmount + 1e-9 < floorAmount;
  const needsAdjust = needsAdjustByUnits || needsAdjustByAmount;

  if (!needsAdjust) {
    return { line: text, changed: false };
  }

  let updated = text;
  if (unitsMatch) {
    const formattedUnits = `${formatUnits(targetUnits)}u`;
    updated = updated.replace(unitsMatch[0], formattedUnits);
  } else if (Number.isFinite(targetUnits)) {
    updated = `${updated} (${formatUnits(targetUnits)}u)`;
  }

  if (amountMatch) {
    updated = updated.replace(amountMatch[0], formatArsAmount(targetAmount));
  } else if (Number.isFinite(targetAmount)) {
    updated = `${updated} (=${formatArsAmount(targetAmount)})`;
  }

  return { line: updated, changed: true };
}

function enforceStakeCalibration(reply = '', originalMessage = '', userProfile = {}) {
  const text = String(reply || '').trim();
  if (!text) return text;

  const userMessage = String(originalMessage || '');
  const looksLikeDecisionTurn =
    hasBetDecisionSignals(userMessage) || hasOddsSignals(userMessage) || /\b(stake|cuota|pick)\b/i.test(userMessage);
  if (!looksLikeDecisionTurn || isLedgerOperationMessage(userMessage)) {
    return text;
  }

  const config = getStakeCalibrationConfig(userProfile || {});
  const lines = text.split('\n');
  let changed = false;
  const updatedLines = lines.map((line) => {
    const next = calibrateStakeLine(line, config);
    if (next.changed) changed = true;
    return next.line;
  });

  if (!changed) {
    return text;
  }

  updatedLines.push(
    '',
    `Nota de staking: ajusté el stake al piso configurado (${formatUnits(
      config.minUnitsPerBet
    )}u / ${formatArsAmount(config.minStakeAmount)}).`
  );
  return updatedLines.join('\n');
}

function enforceRationaleSection(reply = '', originalMessage = '') {
  const text = String(reply || '').trim();
  const userMessage = String(originalMessage || '');
  const explicitRationaleRequest = /\b(fundament|explica|por que)\b/.test(
    normalizeText(userMessage)
  );
  const looksLikeDecisionTurn =
    hasBetDecisionSignals(userMessage) || hasOddsSignals(userMessage) || explicitRationaleRequest;
  const isOperationalLedgerTurn = isLedgerOperationMessage(userMessage);

  if (
    !text ||
    !isRecommendationReply(text) ||
    hasRationaleContent(text) ||
    !looksLikeDecisionTurn ||
    isOperationalLedgerTurn
  ) {
    return text;
  }

  return `${text}\n\nFundamento de la elección:\n- Tesis: el pick se basa en el cruce de estilos, contexto reciente y precio actual.\n- Riesgo: alta varianza en MMA; si cambia la linea o falta contexto, baja la confianza.\n- Regla de entrada: tomar solo si la cuota se mantiene en el umbral indicado; si empeora, no-bet.`;
}

function containsAbsoluteDate(text = '') {
  return /\b20\d{2}-\d{2}-\d{2}\b/.test(text) || /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/.test(
    text
  );
}

function looksLikeNoEventClaim(text = '') {
  const normalized = normalizeText(text);
  if (!normalized) return false;
  return /\b(no hay|no tengo|no aparece)\b.*\b(evento|ufc|cartelera)\b/.test(normalized);
}

function enforceCalendarNoEventContext(reply = '', originalMessage = '', temporalContext = null) {
  const text = String(reply || '').trim();
  if (!text) return text;
  if (!isCalendarQuestion(originalMessage)) return text;
  if (!looksLikeNoEventClaim(text)) return text;
  if (containsAbsoluteDate(text)) return text;

  const asOf = temporalContext?.nowLocal?.dateIso || new Date().toISOString().slice(0, 10);
  const prev = shiftIsoDate(asOf, -1) || 'N/D';
  const tz = temporalContext?.timezone || DEFAULT_USER_TIMEZONE;

  return `${text}\n\nReferencia temporal usada: ${asOf} (${tz}). Tambien validé la ventana ${prev} -> ${asOf}.`;
}

function chooseLikelyActiveFightFromPendingBets(pendingBets = []) {
  if (!Array.isArray(pendingBets) || !pendingBets.length) {
    return { type: 'none' };
  }

  const groups = new Map();
  for (const bet of pendingBets) {
    const eventName = String(bet?.eventName || '').trim() || 'Evento no especificado';
    const fight = String(bet?.fight || '').trim();
    if (!fight) continue;
    const key = `${eventName}||${fight}`;
    const createdAtMs = Date.parse(bet?.recordedAt || bet?.updatedAt || '') || 0;
    const existing = groups.get(key) || {
      eventName,
      fight,
      count: 0,
      latestCreatedAtMs: 0,
      betIds: [],
    };
    existing.count += 1;
    existing.latestCreatedAtMs = Math.max(existing.latestCreatedAtMs, createdAtMs);
    if (Number.isInteger(Number(bet?.id))) {
      existing.betIds.push(Number(bet.id));
    }
    groups.set(key, existing);
  }

  const ranked = Array.from(groups.values()).sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return b.latestCreatedAtMs - a.latestCreatedAtMs;
  });

  if (!ranked.length) {
    return { type: 'none' };
  }

  if (ranked.length === 1) {
    return { type: 'single', top: ranked[0], ranked };
  }

  const [top, second] = ranked;
  if (top.count > second.count) {
    return { type: 'single', top, ranked };
  }

  return { type: 'ambiguous', top, second, ranked };
}

function logConfiguration() {
  console.log('⚙️ Betting Wizard config', {
    model: MODEL,
    decisionModel: DECISION_MODEL || null,
    temperature: TEMPERATURE,
    knowledgeFile: RESOLVED_KNOWLEDGE_PATH,
    knowledgeExists: fs.existsSync(RESOLVED_KNOWLEDGE_PATH),
    hasOpenAIKey: Boolean(OPENAI_API_KEY),
    maxRecentTurns: MAX_RECENT_TURNS,
    maxToolRounds: MAX_TOOL_ROUNDS,
    usesResponsesAPI: true,
    webSearchContextSize: WEB_SEARCH_CONTEXT_SIZE,
    creditEnforce: CREDIT_ENFORCE,
  });
}

function ensureConfigured(client) {
  if (client) {
    return;
  }

  if (!OPENAI_API_KEY) {
    throw new Error(
      'OPENAI_API_KEY is not configured. Set it in your environment or .env file.'
    );
  }
}

function getOpenAIClient(providedClient) {
  if (providedClient) {
    return providedClient;
  }

  return new OpenAI({ apiKey: OPENAI_API_KEY });
}

function loadKnowledgeSnippet() {
  try {
    if (!fs.existsSync(RESOLVED_KNOWLEDGE_PATH)) {
      return '';
    }

    const stats = fs.statSync(RESOLVED_KNOWLEDGE_PATH);
    if (
      knowledgeCache.path === RESOLVED_KNOWLEDGE_PATH &&
      knowledgeCache.mtimeMs === stats.mtimeMs
    ) {
      return knowledgeCache.snippet;
    }

    const content = fs.readFileSync(RESOLVED_KNOWLEDGE_PATH, 'utf-8');
    const snippet = content.slice(0, KNOWLEDGE_MAX_CHARS);
    knowledgeCache.path = RESOLVED_KNOWLEDGE_PATH;
    knowledgeCache.mtimeMs = stats.mtimeMs;
    knowledgeCache.snippet = snippet;
    return snippet;
  } catch (error) {
    console.error('❌ Failed to load knowledge snippet:', error);
    return '';
  }
}

function summariseProfile(profile = {}) {
  const chunks = [];

  if (profile.bankroll !== null && profile.bankroll !== undefined) {
    chunks.push(`bankroll=${profile.bankroll}`);
  }

  if (profile.unitSize !== null && profile.unitSize !== undefined) {
    chunks.push(`unitSize=${profile.unitSize}`);
  }

  if (profile.riskProfile) {
    chunks.push(`riskProfile=${profile.riskProfile}`);
  }

  if (profile.currency) {
    chunks.push(`currency=${profile.currency}`);
  }

  if (profile.timezone) {
    chunks.push(`timezone=${profile.timezone}`);
  }

  if (profile.minStakeAmount !== null && profile.minStakeAmount !== undefined) {
    chunks.push(`minStakeAmount=${profile.minStakeAmount}`);
  }

  if (profile.minUnitsPerBet !== null && profile.minUnitsPerBet !== undefined) {
    chunks.push(`minUnitsPerBet=${profile.minUnitsPerBet}`);
  }

  if (
    profile.targetEventUtilizationPct !== null &&
    profile.targetEventUtilizationPct !== undefined
  ) {
    chunks.push(`targetEventUtilizationPct=${profile.targetEventUtilizationPct}`);
  }

  if (profile.notes) {
    chunks.push(`notes=${truncateText(profile.notes, 180)}`);
  }

  return chunks.length ? chunks.join(', ') : 'sin datos de perfil todavia';
}

function formatSessionMemory(session = null) {
  if (!session) {
    return 'No hay memoria de sesion disponible.';
  }

  const lines = [];
  if (session.lastEvent?.eventName || session.lastEvent?.date) {
    lines.push(
      `Ultimo evento guardado: ${session.lastEvent.eventName || 'N/D'} (${session.lastEvent.date || 'fecha N/D'})`
    );
  }

  if (session.lastCardFights?.length) {
    const fights = session.lastCardFights
      .slice(0, 8)
      .map((fight, index) => `${index + 1}. ${fight.fighterA} vs ${fight.fighterB}`)
      .join(' | ');
    lines.push(`Ultima cartelera en memoria: ${fights}`);
  }

  if (session.lastResolvedFight?.fighterA && session.lastResolvedFight?.fighterB) {
    lines.push(
      `Ultima pelea referenciada: ${session.lastResolvedFight.fighterA} vs ${session.lastResolvedFight.fighterB}`
    );
  }

  lines.push(`Perfil usuario: ${summariseProfile(session.userProfile || {})}`);

  if (session.betHistory?.length) {
    const recentBets = session.betHistory
      .slice(-3)
      .map((bet, index) => {
        const event = bet.eventName || 'evento N/D';
        const fight = bet.fight || 'pelea N/D';
        const pick = bet.pick || 'pick N/D';
        const odds = bet.odds !== undefined ? `odds ${bet.odds}` : 'odds N/D';
        return `${index + 1}) ${event} - ${fight} - ${pick} (${odds})`;
      })
      .join(' | ');
    lines.push(`Apuestas recientes: ${recentBets}`);
  }

  if (session.ledgerSummary) {
    const ledger = session.ledgerSummary;
    const wins = ledger.wins ?? 0;
    const losses = ledger.losses ?? 0;
    const pushes = ledger.pushes ?? 0;
    const totalBets = ledger.totalBets ?? 0;
    const totalUnits = ledger.totalUnits ?? 0;
    const totalStaked = ledger.totalStaked ?? 0;
    lines.push(
      `Ledger: ${totalBets} apuestas | W-L-P ${wins}-${losses}-${pushes} | unidades ${totalUnits} | staked ${totalStaked}`
    );
  }

  return lines.join('\n');
}

function buildSystemPrompt(knowledgeSnippet = '') {
  const today = new Date().toISOString().slice(0, 10);
  const rules = [
    'Sos un analista UFC conversacional en espanol, natural y concreto.',
    `Fecha de referencia actual: ${today}.`,
    'Usa emojis de forma visible para mejorar legibilidad y tono (sin saturar: 1-2 por seccion).',
    'Objetivo principal: dar respuestas coherentes entre turnos y aprovechar herramientas antes de pedir datos al usuario.',
    'Para preguntas de calendario/evento/cartelera (por fecha o proximo evento), SIEMPRE usa web_search antes de responder.',
    'Para consultas con hoy/manana/ahora/en vivo, resolve primero fecha/hora local del usuario usando TEMPORAL_CONTEXT y contempla ventana nocturna (dia actual + dia anterior + siguiente inmediato).',
    'Antes de afirmar "no hay evento", valida explicitamente la ventana temporal completa y cita la fecha absoluta usada.',
    'Si hay conflicto entre fuentes, prioriza ufc.com, luego espn.com, luego otras.',
    'No inventes eventos ni fechas. Si no logras confirmar con web_search, dilo explicitamente.',
    'Cuando listes una cartelera, llama set_event_card para guardar evento+peleas en memoria.',
    'Si piden analisis de una pelea concreta, usa get_fighter_history para sustentar pick tecnico con historial local.',
    'Si no hay historial interno suficiente, complementa con web_search y no menciones que buscaste en la web.',
    'No menciones el backend, caches ni herramientas internas al usuario.',
    'No pidas historial de peleadores al usuario si la herramienta puede obtenerlo.',
    'Solo pide cuotas si el usuario quiere EV/staking fino; antes de pedirlas, intenta get_user_odds para usar cuotas guardadas.',
    'Cuando haya cuotas guardadas relevantes, usalas automaticamente sin pedirle al usuario que las reenvie.',
    'Si el usuario pregunta por su ledger/balance/apuestas previas, usa get_user_profile para responder con su historial y resumen.',
    'Para listar apuestas existentes y resolver referencias ambiguas, usa list_user_bets.',
    'Para cambiar estado de apuestas existentes (WON/LOST/PENDING) o borrar/archivar, usa mutate_user_bets, nunca record_user_bet.',
    'Si la referencia de pelea es ambigua (esa/anterior/recien), no ejecutes mutaciones: pedi desambiguacion con bet_id.',
    'Si mutate_user_bets responde requiresConfirmation=true, pedile confirmacion explicita al usuario y luego ejecuta con confirm=true + confirmationToken.',
    'Nunca confirmes una mutacion de ledger sin mostrar receipt (bet_id y nuevo estado).',
    'Si el usuario pide corregir/revertir, usa undo_last_mutation para deshacer la ultima mutacion sensible.',
    'Usa la memoria conversacional para referencias como pelea 1, esa pelea, bankroll y apuestas previas.',
    'No muestres tablas crudas de muchas filas salvo pedido explicito; sintetiza hallazgos relevantes.',
    'Si actualizas o detectas datos de perfil del usuario, persiste con update_user_profile.',
    'Cuando sugieras stake, respeta min_stake_amount y min_units_per_bet del perfil; si el edge no justifica ese piso, propone NO_BET en lugar de stake simbolico.',
    'Si el usuario provee cuotas/odds de una sola pelea (texto o imagen), responde con formato estructurado: intro breve, separador, encabezado de pelea + cuotas recibidas, separador, "Lectura de la pelea" con bullets claros, separador, "Mi probabilidad estimada", separador, "EV (valor esperado)" con picks y EV, separador, "RECOMENDACIONES" (pick principal / valor / agresivo) con stake en unidades si hay unit_size, separador, "Que NO jugaria", separador, "Resumen rapido".',
    'Si el usuario provee cuotas de varias peleas, aplica el mismo formato por pelea (secciones repetidas) y al final agrega un "Resumen global" con los picks principales ordenados por solidez.',
    'Toda recomendacion debe incluir "Fundamento de la eleccion": tesis breve, riesgos y regla de entrada (cuota minima o condicion de no-bet).',
    'Cuando el usuario provea cuotas (texto o imagen), construye un JSON estructurado por pelea y llama store_user_odds una vez por pelea. Inclui sportsbook si el usuario lo menciona.',
    'Para peleas proximas, realiza una busqueda web rapida enfocada en cortes de peso agresivos, fallos de peso, hospitalizaciones o cambios de ultima hora en la semana previa; si hay señales relevantes, ajusta el analisis.',
    'Mantene el formato limpio y util para apostar; no repitas las cuotas mas de una vez.',
  ].join(' ');

  if (!knowledgeSnippet) {
    return rules;
  }

  return `${rules}\n\n[PLAYBOOK_SNIPPET]\n${knowledgeSnippet}`;
}

function buildRecentTurnsText(turns = []) {
  if (!turns.length) {
    return 'Sin turnos previos.';
  }

  return turns
    .map((turn) => `${turn.role === 'assistant' ? 'Assistant' : 'User'}: ${turn.content}`)
    .join('\n');
}

function buildUserPayload({
  originalMessage,
  resolvedMessage,
  resolution,
  sessionMemory,
  temporalContext,
  recentTurns,
  hasMedia,
  extraSections = [],
}) {
  const trimmed = String(originalMessage || '').trim();
  const sections = ['[USER_MESSAGE]', trimmed || (hasMedia ? 'El usuario envio un archivo multimedia sin texto.' : '')];

  if (resolution?.resolvedFight) {
    sections.push(
      '',
      '[CONVERSATION_CONTEXT]',
      `Referencia de pelea resuelta: ${resolution.resolvedFight.fighterA} vs ${resolution.resolvedFight.fighterB}.`
    );
  }

  if (sessionMemory) {
    sections.push('', '[SESSION_MEMORY]', sessionMemory);
  }

  if (temporalContext) {
    sections.push('', '[TEMPORAL_CONTEXT]', temporalContext);
  }

  sections.push('', '[RECENT_TURNS]', buildRecentTurnsText(recentTurns));

  if (resolvedMessage && resolvedMessage !== originalMessage) {
    sections.push('', '[RESOLVED_MESSAGE_FOR_REASONING]', resolvedMessage);
  }

  if (extraSections.length) {
    sections.push('', ...extraSections);
  }

  return sections.join('\n');
}

function rowContainsFighter(row = [], fighter = '') {
  const fighterNorm = normalise(fighter).trim();
  if (!fighterNorm) {
    return false;
  }

  const rowText = row.map((value) => normalise(value)).join(' | ');
  const fighterTokens = fighterNorm.split(/\s+/).filter(Boolean);

  if (fighterTokens.length >= 2) {
    return rowText.includes(fighterNorm);
  }

  return rowText.split(/[^a-z0-9]+/).includes(fighterNorm);
}

function isWinForFighter(row = [], fighter = '') {
  const winner = normalise(row[5] || row[4] || '');
  const fighterNorm = normalise(fighter);
  if (!winner || !fighterNorm) {
    return false;
  }
  return winner.includes(fighterNorm);
}

function isFinish(method = '') {
  const norm = normalise(method);
  return norm.includes('ko') || norm.includes('tko') || norm.includes('submission');
}

function inferOpponent(row = [], fighter = '') {
  const fighterA = String(row[2] || '').trim();
  const fighterB = String(row[3] || '').trim();

  if (!fighterA && !fighterB) {
    return 'oponente no identificado';
  }

  if (rowContainsFighter([fighterA], fighter)) {
    return fighterB || 'oponente no identificado';
  }
  if (rowContainsFighter([fighterB], fighter)) {
    return fighterA || 'oponente no identificado';
  }

  return fighterB || fighterA || 'oponente no identificado';
}

function summariseFighterRows(rows = [], fighter = '') {
  const fighterRows = rows.filter((row) => rowContainsFighter(row, fighter));
  if (!fighterRows.length) {
    return {
      fighter,
      sampleSize: 0,
      wins: 0,
      losses: 0,
      finishes: 0,
      recent: [],
      note: 'sin filas historicas relevantes',
    };
  }

  const wins = fighterRows.filter((row) => isWinForFighter(row, fighter)).length;
  const losses = fighterRows.length - wins;
  const finishes = fighterRows.filter((row) => isFinish(row[6] || '')).length;
  const recent = fighterRows.slice(0, 4).map((row) => ({
    date: String(row[0] || 'fecha n/d').trim(),
    opponent: inferOpponent(row, fighter),
    result: isWinForFighter(row, fighter) ? 'W' : 'L',
    method: String(row[6] || 'metodo n/d').trim(),
  }));

  return {
    fighter,
    sampleSize: fighterRows.length,
    wins,
    losses,
    finishes,
    recent,
  };
}

function buildHistoryToolResult(historyResult = {}, cacheStatus = null) {
  const fighters = Array.isArray(historyResult.fighters) ? historyResult.fighters : [];
  const rows = Array.isArray(historyResult.rows) ? historyResult.rows : [];
  const summaries = fighters.map((fighter) => summariseFighterRows(rows, fighter));

  const previewRows = rows.slice(0, MAX_HISTORY_PREVIEW_ROWS).map((row) => ({
    date: row[0] || null,
    event: row[1] || null,
    fighterA: row[2] || null,
    fighterB: row[3] || null,
    division: row[4] || null,
    winner: row[5] || null,
    method: row[6] || null,
    round: row[7] || null,
    time: row[8] || null,
  }));

  return {
    ok: true,
    fighters,
    rowCount: rows.length,
    summaries,
    previewRows,
    hasMoreRows: rows.length > previewRows.length,
  };
}

function buildResponsesTools({ timezone = WEB_SEARCH_TIMEZONE } = {}) {
  const normalizedTz = normalizeTimeZone(timezone || WEB_SEARCH_TIMEZONE);
  const tools = [
    {
      type: 'web_search',
      search_context_size: WEB_SEARCH_CONTEXT_SIZE,
      user_location: {
        type: 'approximate',
        country: WEB_SEARCH_COUNTRY,
        ...(WEB_SEARCH_REGION ? { region: WEB_SEARCH_REGION } : {}),
        ...(WEB_SEARCH_CITY ? { city: WEB_SEARCH_CITY } : {}),
        ...(normalizedTz ? { timezone: normalizedTz } : {}),
      },
    },
    ...FUNCTION_TOOLS,
  ];

  return tools;
}

function extractFunctionCalls(response) {
  const output = Array.isArray(response?.output) ? response.output : [];
  return output.filter((item) => item?.type === 'function_call');
}

function extractResponseText(response) {
  const direct = String(response?.output_text || '').trim();
  if (direct) {
    return direct;
  }

  const output = Array.isArray(response?.output) ? response.output : [];
  for (const item of output) {
    if (item?.type !== 'message' || !Array.isArray(item.content)) {
      continue;
    }

    for (const content of item.content) {
      if (content?.type === 'output_text' && String(content.text || '').trim()) {
        return String(content.text).trim();
      }
    }
  }

  return '';
}

function extractCitationsFromResponse(response) {
  const output = Array.isArray(response?.output) ? response.output : [];
  const citations = [];
  const seen = new Set();

  for (const item of output) {
    if (item?.type === 'message' && Array.isArray(item.content)) {
      for (const content of item.content) {
        if (content?.type !== 'output_text' || !Array.isArray(content.annotations)) {
          continue;
        }

        for (const annotation of content.annotations) {
          if (annotation?.type !== 'url_citation' || !annotation.url) {
            continue;
          }

          const key = String(annotation.url).trim();
          if (!key || seen.has(key)) {
            continue;
          }
          seen.add(key);
          citations.push({
            title: annotation.title || annotation.url,
            url: annotation.url,
          });
        }
      }
    }

    if (item?.type === 'web_search_call' && item.action?.type === 'search') {
      const sources = Array.isArray(item.action.sources) ? item.action.sources : [];
      for (const source of sources) {
        if (!source?.url) {
          continue;
        }
        const key = String(source.url).trim();
        if (!key || seen.has(key)) {
          continue;
        }
        seen.add(key);
        citations.push({
          title: source.title || source.url,
          url: source.url,
        });
      }
    }
  }

  return citations;
}

function hasWebSearchCall(response) {
  const output = Array.isArray(response?.output) ? response.output : [];
  return output.some((item) => item?.type === 'web_search_call');
}

function sanitizeCardFights(rawFights = []) {
  if (!Array.isArray(rawFights)) {
    return [];
  }

  return rawFights
    .map((fight) => ({
      fighterA: String(fight?.fighterA || '').trim(),
      fighterB: String(fight?.fighterB || '').trim(),
    }))
    .filter((fight) => fight.fighterA && fight.fighterB)
    .slice(0, 12)
    .map((fight, idx) => ({
      ...fight,
      cardIndex: idx + 1,
    }));
}

function formatCitationsFooter(citations = []) {
  if (!citations.length) {
    return '';
  }

  const lines = citations.slice(0, 4).map((item, idx) => {
    return `${idx + 1}. ${item.title} - ${item.url}`;
  });

  return `\n\nFuentes:\n${lines.join('\n')}`;
}

function shouldShowCitations(userMessage = '') {
  if (SHOW_SOURCES_BY_DEFAULT) {
    return true;
  }

  const text = normalise(userMessage);
  return /\b(fuente|fuentes|source|sources|cita|citas|citation|citations|referencia|referencias|link|links|url|urls)\b/.test(
    text
  );
}

async function runResponsesWithTools({
  client,
  tools,
  instructions,
  input,
  executeTool,
  model,
}) {
  const activeModel = model || MODEL;
  const usageTotals = {
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    reasoning_tokens: 0,
    cached_tokens: 0,
  };
  const usageBreakdown = [];

  function accumulateUsage(currentResponse) {
    const usage = currentResponse?.usage;
    if (!usage || typeof usage !== 'object') {
      return;
    }

    usageBreakdown.push({
      response_id: currentResponse.id,
      usage,
    });

    if (Number.isFinite(Number(usage.input_tokens))) {
      usageTotals.input_tokens += Number(usage.input_tokens);
    }
    if (Number.isFinite(Number(usage.output_tokens))) {
      usageTotals.output_tokens += Number(usage.output_tokens);
    }
    if (Number.isFinite(Number(usage.total_tokens))) {
      usageTotals.total_tokens += Number(usage.total_tokens);
    }

    const reasoningTokens =
      usage.reasoning_tokens ??
      usage.output_tokens_details?.reasoning_tokens ??
      null;
    if (Number.isFinite(Number(reasoningTokens))) {
      usageTotals.reasoning_tokens += Number(reasoningTokens);
    }

    const cachedTokens =
      usage.cached_tokens ?? usage.input_tokens_details?.cached_tokens ?? null;
    if (Number.isFinite(Number(cachedTokens))) {
      usageTotals.cached_tokens += Number(cachedTokens);
    }
  }

  let response = await client.responses.create({
    model: activeModel,
    temperature: TEMPERATURE,
    instructions,
    input,
    tools,
    include: INCLUDE_FIELDS,
    tool_choice: 'auto',
  });

  accumulateUsage(response);

  let usedWebSearch = hasWebSearchCall(response);
  const citationMap = new Map();
  for (const citation of extractCitationsFromResponse(response)) {
    citationMap.set(citation.url, citation);
  }

  for (let round = 1; round <= MAX_TOOL_ROUNDS; round += 1) {
    const functionCalls = extractFunctionCalls(response);
    if (!functionCalls.length) {
      break;
    }

    const outputs = [];
    for (const call of functionCalls) {
      console.log(`🛠️ Betting Wizard tool call: ${call.name}`);
      let toolResult;
      try {
        toolResult = await executeTool(call);
      } catch (error) {
        toolResult = {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }

      outputs.push({
        type: 'function_call_output',
        call_id: call.call_id,
        output: JSON.stringify(toolResult),
      });
    }

    response = await client.responses.create({
      model: activeModel,
      temperature: TEMPERATURE,
      instructions,
      previous_response_id: response.id,
      input: outputs,
      tools,
      include: INCLUDE_FIELDS,
      tool_choice: 'auto',
    });

    accumulateUsage(response);

    usedWebSearch = usedWebSearch || hasWebSearchCall(response);
    for (const citation of extractCitationsFromResponse(response)) {
      citationMap.set(citation.url, citation);
    }
  }

  return {
    reply: extractResponseText(response),
    usedWebSearch,
    citations: Array.from(citationMap.values()),
    usage: {
      totals: usageTotals,
      breakdown: usageBreakdown,
    },
  };
}

export function createBettingWizard({
  fightsScalper,
  conversationStore,
  userStore,
  client: providedClient,
} = {}) {
  ensureConfigured(providedClient);
  const client = getOpenAIClient(providedClient);
  logConfiguration();
  const pendingLedgerMutationsByToken = new Map();
  const pendingLedgerMutationTokensByScope = new Map();

  function mutationScopeKey({ chatId, userId } = {}) {
    return `${chatId || 'default'}:${userId || 'anon'}`;
  }

  function savePendingMutation(scopeKey, payload) {
    if (!scopeKey || !payload) return null;
    const token = createMutationToken();
    pendingLedgerMutationsByToken.set(token, {
      ...payload,
      scopeKey,
      token,
      createdAt: Date.now(),
      expiresAt: Date.now() + 10 * 60 * 1000,
    });
    const list = pendingLedgerMutationTokensByScope.get(scopeKey) || [];
    list.push(token);
    pendingLedgerMutationTokensByScope.set(scopeKey, list);
    return token;
  }

  function removeTokenFromScope(scopeKey, token) {
    if (!scopeKey || !token) return;
    const list = pendingLedgerMutationTokensByScope.get(scopeKey) || [];
    const next = list.filter((value) => value !== token);
    if (next.length) {
      pendingLedgerMutationTokensByScope.set(scopeKey, next);
    } else {
      pendingLedgerMutationTokensByScope.delete(scopeKey);
    }
  }

  function consumePendingMutation(scopeKey, token) {
    if (!scopeKey || !token) return null;
    const entry = pendingLedgerMutationsByToken.get(token);
    if (!entry) return null;
    if (entry.scopeKey !== scopeKey) return null;
    if (entry.expiresAt <= Date.now()) {
      pendingLedgerMutationsByToken.delete(token);
      removeTokenFromScope(scopeKey, token);
      return null;
    }
    pendingLedgerMutationsByToken.delete(token);
    removeTokenFromScope(scopeKey, token);
    return entry;
  }

  function getPendingMutationsForScope(scopeKey) {
    if (!scopeKey) return [];
    const tokens = pendingLedgerMutationTokensByScope.get(scopeKey) || [];
    const now = Date.now();
    const entries = [];
    for (const token of tokens) {
      const entry = pendingLedgerMutationsByToken.get(token);
      if (!entry) continue;
      if (entry.expiresAt <= now) {
        pendingLedgerMutationsByToken.delete(token);
        continue;
      }
      entries.push(entry);
    }
    entries.sort((a, b) => a.createdAt - b.createdAt);
    const activeTokens = entries.map((entry) => entry.token);
    if (activeTokens.length) {
      pendingLedgerMutationTokensByScope.set(scopeKey, activeTokens);
    } else {
      pendingLedgerMutationTokensByScope.delete(scopeKey);
    }
    return entries;
  }

  function consumeAllPendingMutations(scopeKey) {
    const entries = getPendingMutationsForScope(scopeKey);
    for (const entry of entries) {
      pendingLedgerMutationsByToken.delete(entry.token);
    }
    pendingLedgerMutationTokensByScope.delete(scopeKey);
    return entries;
  }

  function cleanupPendingMutations() {
    const now = Date.now();
    for (const [token, value] of pendingLedgerMutationsByToken.entries()) {
      if (!value || value.expiresAt <= now) {
        pendingLedgerMutationsByToken.delete(token);
        if (value?.scopeKey) {
          removeTokenFromScope(value.scopeKey, token);
        }
      }
    }
  }

  async function handleMessage(message, context = {}) {
    cleanupPendingMutations();
    const chatId = String(context.chatId ?? 'default');
    const userId = context.userId ? String(context.userId) : null;
    const originalMessage = context.originalMessage || String(message || '');
    const resolution =
      context.resolution ||
      conversationStore?.resolveMessage?.(chatId, originalMessage) || {
        originalMessage,
        resolvedMessage: message,
        resolvedFight: null,
      };
    const resolvedMessage = context.resolvedMessage || resolution.resolvedMessage || message;

    const runtimeState = {
      resolvedFight: resolution?.resolvedFight || null,
      eventCard: null,
    };

    const wantsLedger = hasLedgerSignals(originalMessage);
    const wantsOdds = hasOddsRequestSignals(originalMessage);
    const wantsBetDecision = hasBetDecisionSignals(originalMessage);
    let oddsSnapshot = null;
    let ledgerSummary = null;
    let userProfile = null;

    if (userId && userStore) {
      if (userStore.getUserProfile) {
        const profile = userStore.getUserProfile(userId);
        userProfile = profile || null;
        if (conversationStore?.patch) {
          conversationStore.patch(chatId, { userProfile: profile });
        }
      }

      if (userStore.getBetHistory) {
        const betHistory = userStore.getBetHistory(userId, 10);
        if (conversationStore?.patch) {
          conversationStore.patch(chatId, { betHistory });
        }
      }

      if (userStore.getLedgerSummary) {
        ledgerSummary = userStore.getLedgerSummary(userId);
        if (conversationStore?.patch) {
          conversationStore.patch(chatId, { ledgerSummary });
        }
      }

      if (
        userStore.getLatestOddsSnapshot &&
        (wantsOdds || wantsBetDecision)
      ) {
        const fightRef = resolution?.resolvedFight || null;
        oddsSnapshot = userStore.getLatestOddsSnapshot(userId, {
          fighterA: fightRef?.fighterA || null,
          fighterB: fightRef?.fighterB || null,
        });
      }
    }

    if (!userProfile && conversationStore?.getSession) {
      userProfile = conversationStore.getSession(chatId)?.userProfile || null;
    }

    const temporalContext = buildTemporalContextSection({
      timezone: userProfile?.timezone || DEFAULT_USER_TIMEZONE,
      originalMessage,
    });

    const stakePreference = parseStakePreferenceMessage(originalMessage);
    if (stakePreference && userId && userStore?.updateUserProfile) {
      const updates = {};
      if (stakePreference.minStakeAmount !== null) {
        updates.minStakeAmount = stakePreference.minStakeAmount;
      }
      if (stakePreference.minUnitsPerBet !== null) {
        updates.minUnitsPerBet = stakePreference.minUnitsPerBet;
      }

      if (Object.keys(updates).length) {
        const nextProfile = userStore.updateUserProfile(userId, updates) || {};
        if (conversationStore?.patch) {
          conversationStore.patch(chatId, { userProfile: nextProfile });
        }
        const lines = [
          '✅ Perfil de staking actualizado.',
          `- Piso por apuesta: ${formatUnits(
            toNumberOrNull(nextProfile.minUnitsPerBet) ?? STAKE_MIN_UNITS_DEFAULT
          )}u / ${formatArsAmount(
            toNumberOrNull(nextProfile.minStakeAmount) ?? STAKE_MIN_AMOUNT_DEFAULT
          )}`,
          'En las próximas recomendaciones voy a respetar ese mínimo.',
        ];
        return {
          reply: lines.join('\n'),
          metadata: {
            resolvedFight: runtimeState.resolvedFight,
            eventCard: runtimeState.eventCard,
          },
        };
      }
    }

    const mutationScope = mutationScopeKey({ chatId, userId });
    const confirmationIntent = parseConfirmationIntent(originalMessage);

    if (userId && userStore?.applyBetMutation) {
      const pendingNow = getPendingMutationsForScope(mutationScope);
      if (
        pendingNow.length &&
        confirmationIntent.hasPositive &&
        !confirmationIntent.hasNegative
      ) {
        const selectedEntries = [];

        if (confirmationIntent.tokens.length) {
          for (const token of confirmationIntent.tokens) {
            const consumed = consumePendingMutation(mutationScope, token);
            if (consumed) {
              selectedEntries.push(consumed);
            }
          }
        } else {
          const matchesIntent = (entry) => {
            if (confirmationIntent.wantsAll) {
              return true;
            }

            const operation = String(entry.payload?.operation || '').trim();
            const result = String(entry.payload?.result || '').trim();
            let hasSpecificHint = false;

            if (confirmationIntent.wantsArchive) {
              hasSpecificHint = true;
              if (operation === 'archive') {
                return true;
              }
            }

            if (confirmationIntent.wantsSetPending) {
              hasSpecificHint = true;
              if (operation === 'set_pending') {
                return true;
              }
            }

            if (confirmationIntent.wantsSettle || confirmationIntent.settleResult) {
              hasSpecificHint = true;
              if (operation === 'settle') {
                if (!confirmationIntent.settleResult) {
                  return true;
                }
                if (result === confirmationIntent.settleResult) {
                  return true;
                }
              }
            }

            // Flexible default: plain "confirmo" applies all pending.
            if (!hasSpecificHint) {
              return true;
            }
            return false;
          };

          const filtered = pendingNow.filter(matchesIntent);
          const source = filtered.length ? filtered : pendingNow;
          for (const entry of source) {
            const consumed = consumePendingMutation(mutationScope, entry.token);
            if (consumed) {
              selectedEntries.push(consumed);
            }
          }
        }

        if (!selectedEntries.length) {
          const pendingHint = getPendingMutationsForScope(mutationScope);
          const hint = pendingHint.length
            ? `Pendientes: ${pendingHint.map((entry) => entry.token).join(', ')}`
            : 'No hay mutaciones pendientes activas para confirmar.';
          return {
            reply: `No encontré confirmaciones pendientes válidas. ${hint}`,
            metadata: {
              resolvedFight: runtimeState.resolvedFight,
              eventCard: runtimeState.eventCard,
            },
          };
        }

        const outcomes = [];
        for (const entry of selectedEntries) {
          const applyPayload = {
            ...entry.payload,
            confirm: true,
            metadata: {
              ...(entry.payload?.metadata || {}),
              confirmationToken: entry.token,
              confirmationSource: 'user_confirm_message',
            },
          };
          const applied = userStore.applyBetMutation(userId, applyPayload);
          outcomes.push({
            token: entry.token,
            operation: entry.payload?.operation || '',
            applied,
          });
        }

        const success = outcomes.filter((item) => item.applied?.ok);
        const failed = outcomes.filter((item) => !item.applied?.ok);
        const lines = [];

        if (success.length) {
          lines.push(`✅ Confirmación aplicada: ${success.length} mutación(es).`);
          for (const item of success) {
            const operation = formatMutationActionLabel(item.operation);
            const count = Number(item.applied?.affectedCount) || 0;
            lines.push(`- ${operation} (${item.token}): ${count} apuesta(s) afectada(s).`);
            const receipts = Array.isArray(item.applied?.receipts)
              ? item.applied.receipts.slice(0, 5)
              : [];
            for (const receipt of receipts) {
              const descriptor = [receipt.eventName, receipt.fight, receipt.pick]
                .filter(Boolean)
                .join(' | ');
              lines.push(
                `  • bet_id ${receipt.betId}: ${receipt.previousResult || 'pending'} -> ${receipt.newResult || 'pending'}${
                  descriptor ? ` | ${descriptor}` : ''
                }`
              );
            }
          }
        }

        if (failed.length) {
          lines.push('', `⚠️ Mutaciones con error: ${failed.length}.`);
          for (const item of failed) {
            lines.push(
              `- ${formatMutationActionLabel(item.operation)} (${item.token}): ${
                item.applied?.error || 'error_desconocido'
              }`
            );
          }
        }

        if (!lines.length) {
          lines.push('No hubo cambios para confirmar en este turno.');
        }

        return {
          reply: lines.join('\n'),
          metadata: {
            resolvedFight: runtimeState.resolvedFight,
            eventCard: runtimeState.eventCard,
          },
        };
      }
    }

    if (userId && userStore?.undoLastBetMutation && isUndoRequest(originalMessage)) {
      const undone = userStore.undoLastBetMutation(userId, {});
      if (!undone?.ok) {
        return {
          reply:
            undone?.message ||
            'No encontre una mutacion reciente para revertir. Si queres, pasame el bet_id y lo revisamos manualmente.',
          metadata: {
            resolvedFight: runtimeState.resolvedFight,
            eventCard: runtimeState.eventCard,
          },
        };
      }

      const receipt = undone.receipt || {};
      const lines = [
        '✅ Reversion aplicada correctamente.',
        `- Mutacion revertida: ${String(undone.undoneAction || 'N/D').toUpperCase()} (#${undone.undoneMutationId || 'N/D'})`,
        `- bet_id: ${receipt.betId || 'N/D'}`,
      ];
      if (receipt.eventName) lines.push(`- Evento: ${receipt.eventName}`);
      if (receipt.fight) lines.push(`- Pelea: ${receipt.fight}`);
      if (receipt.pick) lines.push(`- Pick: ${receipt.pick}`);
      lines.push(
        `- Estado: ${(receipt.previousResult || 'pending').toUpperCase()} -> ${(receipt.newResult || 'pending').toUpperCase()}`
      );

      return {
        reply: lines.join('\n'),
        metadata: {
          resolvedFight: runtimeState.resolvedFight,
          eventCard: runtimeState.eventCard,
        },
      };
    }

    if (userId && userStore?.listUserBets && isLiveFightQueueQuestion(originalMessage)) {
      const pendingBets = userStore.listUserBets(userId, {
        status: 'pending',
        includeArchived: false,
        limit: 60,
      });
      const liveHint = chooseLikelyActiveFightFromPendingBets(pendingBets);

      if (liveHint.type === 'single' && liveHint.top) {
        const top = liveHint.top;
        const idsPreview = (top.betIds || []).slice(0, 4).join(', ');
        const lines = [
          `Ahora, por tu contexto de apuestas abiertas, la pelea que sigue/estás monitoreando es:`,
          '',
          `🥊 ${top.fight}`,
          `Evento: ${top.eventName}`,
          '',
          `Lo infiero por ${top.count} apuesta(s) pending en esa pelea${
            idsPreview ? ` (bet_id: ${idsPreview})` : ''
          }.`,
          'Si querés, te confirmo la secuencia oficial en vivo en el próximo turno.',
        ];
        return {
          reply: lines.join('\n'),
          metadata: {
            resolvedFight: runtimeState.resolvedFight,
            eventCard: runtimeState.eventCard,
          },
        };
      }

      if (liveHint.type === 'ambiguous') {
        const options = (liveHint.ranked || []).slice(0, 3).map((entry, idx) => {
          return `${idx + 1}. ${entry.fight} (${entry.eventName}) - ${entry.count} pending`;
        });
        const lines = [
          'Tengo más de una pelea candidata en tus apuestas pendientes y no quiero inventarte la "que sigue".',
          '',
          ...options,
          '',
          'Decime el número (1/2/3) o pasame el fight exacto y te lo confirmo.',
        ];
        return {
          reply: lines.join('\n'),
          metadata: {
            resolvedFight: runtimeState.resolvedFight,
            eventCard: runtimeState.eventCard,
          },
        };
      }
    }

    const runMutateUserBets = async (rawArgs = {}, { fromLegacyRecordTool = false } = {}) => {
      if (!userId) {
        return { ok: false, error: 'userId no disponible para mutaciones de apuestas.' };
      }
      if (!userStore?.previewBetMutation || !userStore?.applyBetMutation) {
        return {
          ok: false,
          error: 'userStore no soporta previewBetMutation/applyBetMutation.',
        };
      }

      const operation = String(rawArgs.operation || '').trim().toLowerCase();
      const normalizedResult = normalizeBetResult(rawArgs.result);
      const betIds = parseBetIds(rawArgs.betIds);
      const inferredFight =
        String(rawArgs.fight || '').trim() ||
        resolvedFightLabel(runtimeState.resolvedFight || resolution?.resolvedFight || null) ||
        '';
      const payload = {
        operation,
        result: normalizedResult || undefined,
        betIds: betIds.length ? betIds : undefined,
        eventName: rawArgs.eventName ? String(rawArgs.eventName).trim() : undefined,
        fight: inferredFight || undefined,
        pick: rawArgs.pick ? String(rawArgs.pick).trim() : undefined,
        limit: Number.isFinite(Number(rawArgs.limit)) ? Number(rawArgs.limit) : undefined,
        metadata: {
          source: fromLegacyRecordTool ? 'legacy_record_user_bet' : 'mutate_user_bets',
          reason: rawArgs.reason ? String(rawArgs.reason).trim() : null,
          isDestructive: operation === 'archive' || operation === 'settle',
          chatId,
          originalMessage: truncateText(originalMessage, 300),
        },
      };

      if (operation === 'settle' && !normalizedResult) {
        return {
          ok: false,
          error: 'settle_requires_result',
        };
      }

      const fightNotStartedSignals = /\b(no empezo|no empezó|todavia no empezo|todavía no empezó|aun no empezo|aún no empezó)\b/i;
      if (operation === 'settle' && fightNotStartedSignals.test(originalMessage)) {
        return {
          ok: false,
          error: 'fight_not_finished_guard',
          message:
            'No se puede cerrar WON/LOST una pelea marcada como no iniciada. Confirmá el resultado al finalizar.',
        };
      }

      const ambiguousReference = hasAmbiguousFightReference(originalMessage);
      if (operation === 'settle' && ambiguousReference && !betIds.length) {
        const candidates = userStore?.listUserBets
          ? userStore.listUserBets(userId, {
              status: 'pending',
              includeArchived: false,
              limit: 8,
            })
          : [];
        return {
          ok: false,
          error: 'ambiguous_fight_reference',
          requiresDisambiguation: true,
          candidates,
          message:
            'La referencia de pelea es ambigua (ej: "anterior/esa"). Pasame el bet_id exacto o confirmá la pelea exacta antes de cerrar.',
        };
      }

      const hasStrongSelector =
        betIds.length > 0 ||
        Boolean(payload.eventName) ||
        Boolean(payload.fight) ||
        Boolean(payload.pick);
      if (
        (operation === 'settle' || operation === 'archive' || operation === 'set_pending') &&
        !hasStrongSelector
      ) {
        const candidates = userStore?.listUserBets
          ? userStore.listUserBets(userId, {
              status: operation === 'settle' ? 'pending' : null,
              includeArchived: false,
              limit: 8,
            })
          : [];
        return {
          ok: false,
          error: 'missing_disambiguation_selector',
          requiresDisambiguation: true,
          candidates,
          message:
            'Necesito desambiguar que apuesta querés tocar. Indicame bet_id (o pelea exacta + pick) y lo ejecuto.',
        };
      }

      const confirm = rawArgs.confirm === true;
      const confirmationToken = String(rawArgs.confirmationToken || '').trim();

      if (confirm) {
        let pending = null;
        if (confirmationToken) {
          pending = consumePendingMutation(mutationScope, confirmationToken);
        } else {
          const pendingByScope = getPendingMutationsForScope(mutationScope);
          const matching = pendingByScope.filter((entry) => {
            const sameOperation =
              String(entry.payload?.operation || '') === String(payload.operation || '');
            const sameResult =
              !payload.result || String(entry.payload?.result || '') === String(payload.result || '');
            return sameOperation && sameResult;
          });
          if (matching.length === 1) {
            pending = consumePendingMutation(mutationScope, matching[0].token);
          }
        }

        if (!pending) {
          return {
            ok: false,
            error: 'invalid_or_expired_confirmation_token',
            needsConfirmation: true,
            pendingTokens: getPendingMutationsForScope(mutationScope).map((entry) => ({
              token: entry.token,
              operation: entry.payload?.operation || null,
              result: entry.payload?.result || null,
            })),
          };
        }

        const applyPayload = {
          ...pending.payload,
          confirm: true,
          metadata: {
            ...pending.payload.metadata,
            confirmationToken,
          },
        };

        const applied = userStore.applyBetMutation(userId, applyPayload);
        if (!applied?.ok) {
          return applied;
        }

        return {
          ok: true,
          mutationReceipt: {
            operation: applied.operation,
            affectedCount: applied.affectedCount,
            receipts: applied.receipts || [],
          },
          ledgerSummary: applied.ledgerSummary || null,
        };
      }

      const preview = userStore.previewBetMutation(userId, payload);
      if (!preview?.ok) {
        return preview;
      }

      if (preview.requiresConfirmation) {
        const token = savePendingMutation(mutationScope, { payload });
        return {
          ok: false,
          requiresConfirmation: true,
          confirmationToken: token,
          preview: {
            operation: preview.operation,
            result: preview.result || null,
            candidateCount: preview.candidates?.length || 0,
            candidates: preview.candidates || [],
          },
          message:
            'Mutacion sensible detectada. Pedi confirmacion explicita del usuario y luego reintenta con confirm=true + confirmationToken.',
        };
      }

      const applied = userStore.applyBetMutation(userId, {
        ...payload,
        confirm: true,
      });
      if (!applied?.ok) {
        return applied;
      }

      return {
        ok: true,
        mutationReceipt: {
          operation: applied.operation,
          affectedCount: applied.affectedCount,
          receipts: applied.receipts || [],
        },
        ledgerSummary: applied.ledgerSummary || null,
      };
    };

    const executeTool = async (call) => {
      const name = call.name || '';
      const args = parseToolArgs(call.arguments || '{}');

      switch (name) {
        case 'get_fighter_history': {
          if (!fightsScalper?.getFighterHistory) {
            return {
              ok: false,
              error: 'fightsScalperTool no esta disponible.',
            };
          }

          const fighters = Array.isArray(args.fighters)
            ? args.fighters.map((value) => String(value).trim()).filter(Boolean).slice(0, 4)
            : undefined;
          const query = String(args.query || resolvedMessage || originalMessage || '').trim();
          const strict =
            typeof args.strict === 'boolean'
              ? args.strict
              : Boolean(fighters && fighters.length);

          const result = await fightsScalper.getFighterHistory({
            message: query,
            fighters,
            strict,
          });

          if (result?.fighters?.length >= 2 && conversationStore?.setLastResolvedFight) {
            const resolvedFight = {
              fighterA: result.fighters[0],
              fighterB: result.fighters[1],
            };
            conversationStore.setLastResolvedFight(chatId, resolvedFight);
            runtimeState.resolvedFight = resolvedFight;
          }

          const cacheStatus = fightsScalper?.getFightHistoryCacheStatus
            ? fightsScalper.getFightHistoryCacheStatus()
            : null;

          return buildHistoryToolResult(result, cacheStatus);
        }

        case 'get_user_profile': {
          if (!userId) {
            return { ok: false, error: 'userId no disponible para perfil.' };
          }

          const profile = userStore?.getUserProfile
            ? userStore.getUserProfile(userId)
            : {};
          const recentBets = userStore?.getBetHistory
            ? userStore.getBetHistory(userId, 8)
            : [];
          const ledger = userStore?.getLedgerSummary
            ? userStore.getLedgerSummary(userId)
            : null;

          return {
            ok: true,
            userProfile: profile,
            recentBets,
            ledger,
          };
        }

        case 'update_user_profile': {
          if (!userId) {
            return { ok: false, error: 'userId no disponible para perfil.' };
          }
          if (!userStore?.updateUserProfile) {
            return {
              ok: false,
              error: 'userStore no soporta updateUserProfile.',
            };
          }

          const updates = {
            bankroll: toNumberOrNull(args.bankroll),
            unitSize: toNumberOrNull(args.unitSize),
            riskProfile: args.riskProfile ? String(args.riskProfile).trim() : null,
            currency: args.currency ? String(args.currency).trim() : null,
            timezone: args.timezone ? normalizeTimeZone(String(args.timezone)) : null,
            minStakeAmount: toNumberOrNull(args.minStakeAmount),
            minUnitsPerBet: toNumberOrNull(args.minUnitsPerBet),
            targetEventUtilizationPct: toNumberOrNull(args.targetEventUtilizationPct),
            notes: args.notes ? truncateText(String(args.notes), 400) : '',
          };

          Object.keys(updates).forEach((key) => {
            const value = updates[key];
            if (value === null || value === '') {
              delete updates[key];
            }
          });

          if (!Object.keys(updates).length) {
            return {
              ok: false,
              error: 'No hay campos validos para actualizar.',
            };
          }

          const profile = userStore.updateUserProfile(userId, updates);
          return {
            ok: true,
            userProfile: profile,
          };
        }

        case 'record_user_bet': {
          if (!userId) {
            return { ok: false, error: 'userId no disponible para apuestas.' };
          }
          if (!userStore?.addBetRecord) {
            return {
              ok: false,
              error: 'userStore no soporta addBetRecord.',
            };
          }

          if (args.operation) {
            return runMutateUserBets(args, { fromLegacyRecordTool: true });
          }

          const record = {
            eventName: args.eventName ? String(args.eventName).trim() : null,
            fight: args.fight ? String(args.fight).trim() : null,
            pick: args.pick ? String(args.pick).trim() : null,
            odds: toNumberOrNull(args.odds),
            stake: toNumberOrNull(args.stake),
            units: toNumberOrNull(args.units),
            result: normalizeBetResult(args.result) || 'pending',
            notes: args.notes ? truncateText(String(args.notes), 240) : null,
          };

          const looksLikeLegacySettle =
            record.result &&
            record.result !== 'pending' &&
            record.stake === null &&
            record.units === null &&
            record.odds === null;

          if (looksLikeLegacySettle) {
            return runMutateUserBets(
              {
                operation: 'settle',
                result: record.result,
                betIds: parseBetIds(args.betIds),
                eventName: record.eventName,
                fight: record.fight,
                pick: record.pick,
                confirm: args.confirm === true,
                confirmationToken: args.confirmationToken
                  ? String(args.confirmationToken).trim()
                  : '',
                reason: 'legacy_record_user_bet_settle',
              },
              { fromLegacyRecordTool: true }
            );
          }

          const stored = userStore.addBetRecord(userId, record);
          return {
            ok: true,
            record: stored,
            mutationReceipt: {
              action: 'create',
              betId: stored?.id || null,
              newResult: stored?.result || null,
              updatedAt: stored?.updatedAt || stored?.recordedAt || null,
            },
          };
        }

        case 'list_user_bets': {
          if (!userId) {
            return { ok: false, error: 'userId no disponible para apuestas.' };
          }
          if (!userStore?.listUserBets) {
            return { ok: false, error: 'userStore no soporta listUserBets.' };
          }

          const bets = userStore.listUserBets(userId, {
            eventName: args.eventName ? String(args.eventName).trim() : null,
            fight:
              args.fight
                ? String(args.fight).trim()
                : resolvedFightLabel(runtimeState.resolvedFight || resolution?.resolvedFight),
            pick: args.pick ? String(args.pick).trim() : null,
            status: args.status ? String(args.status).trim() : null,
            includeArchived: args.includeArchived === true,
            limit: Number.isFinite(Number(args.limit)) ? Number(args.limit) : 30,
          });

          return {
            ok: true,
            count: bets.length,
            bets,
          };
        }

        case 'mutate_user_bets': {
          return runMutateUserBets(args);
        }

        case 'undo_last_mutation': {
          if (!userId) {
            return { ok: false, error: 'userId no disponible para undo.' };
          }
          if (!userStore?.undoLastBetMutation) {
            return {
              ok: false,
              error: 'userStore no soporta undoLastBetMutation.',
            };
          }
          return userStore.undoLastBetMutation(userId, {
            windowMinutes: Number.isFinite(Number(args.windowMinutes))
              ? Number(args.windowMinutes)
              : undefined,
          });
        }

        case 'store_user_odds': {
          if (!userId) {
            return { ok: false, error: 'userId no disponible para odds.' };
          }
          if (!userStore?.addOddsSnapshot) {
            return {
              ok: false,
              error: 'userStore no soporta addOddsSnapshot.',
            };
          }

          const payload =
            args.oddsPayload && typeof args.oddsPayload === 'object'
              ? args.oddsPayload
              : args;

          const stored = userStore.addOddsSnapshot(userId, payload);
          return {
            ok: true,
            stored,
          };
        }

        case 'get_user_odds': {
          if (!userId) {
            return { ok: false, error: 'userId no disponible para odds.' };
          }
          if (!userStore?.getLatestOddsSnapshot) {
            return {
              ok: false,
              error: 'userStore no soporta getLatestOddsSnapshot.',
            };
          }

          const payload = {
            fightId: args.fightId ? String(args.fightId).trim() : null,
            fighterA: args.fighterA ? String(args.fighterA).trim() : null,
            fighterB: args.fighterB ? String(args.fighterB).trim() : null,
            eventName: args.eventName ? String(args.eventName).trim() : null,
            eventDate: args.eventDate ? String(args.eventDate).trim() : null,
          };

          const odds = userStore.getLatestOddsSnapshot(userId, payload);
          return {
            ok: true,
            odds,
          };
        }

        case 'set_event_card': {
          if (!conversationStore?.setLastCard) {
            return {
              ok: false,
              error: 'conversationStore no soporta setLastCard.',
            };
          }

          const fights = sanitizeCardFights(args.fights || []);
          if (!fights.length) {
            return {
              ok: false,
              error: 'No se detectaron peleas validas para guardar.',
            };
          }

          const card = {
            eventName: args.eventName ? String(args.eventName).trim() : null,
            date: args.date ? String(args.date).trim() : null,
            fights,
          };

          conversationStore.setLastCard(chatId, card);
          runtimeState.eventCard = card;
          runtimeState.resolvedFight = fights[0];

          return {
            ok: true,
            eventCard: card,
          };
        }

        default:
          return {
            ok: false,
            error: `Tool desconocida: ${name}`,
          };
      }
    };

    try {
      console.log(`🧠 Betting Wizard recibio (${chatId}): ${originalMessage}`);

      const recentTurns = conversationStore?.getRecentTurns
        ? conversationStore.getRecentTurns(chatId, MAX_RECENT_TURNS)
        : [];
      const session = conversationStore?.getSession
        ? conversationStore.getSession(chatId)
        : null;
      const sessionMemory = formatSessionMemory(session);

      const systemPrompt = buildSystemPrompt(loadKnowledgeSnippet());
      const mediaItems = Array.isArray(context.inputItems) ? context.inputItems : [];
      const hasMedia = mediaItems.length > 0;
      const useDecisionModel = shouldUseDecisionModel({
        message: originalMessage,
        hasMedia,
      });
      const modelToUse = useDecisionModel ? DECISION_MODEL : MODEL;

      let creditState = null;
      let estimatedCost = 0;
      let costBreakdown = null;

      if (CREDIT_ENFORCE && userId && userStore?.getCreditState) {
        creditState = userStore.getCreditState(userId, CREDIT_FREE_WEEKLY);
        const dayIso = getUtcDayIso();
        const { weekStartIso, weekEndIso } = getWeekBoundsUtc();
        const usageCounters = userStore.getUsageCounters
          ? userStore.getUsageCounters({
              userId,
              dayIso,
              weekStartIso,
              weekEndIso,
            })
          : { imagesToday: 0, audioSecondsWeek: 0 };

        const imagesToday = Number(usageCounters.imagesToday) || 0;
        const newImages = Number(context.mediaStats?.imageCount) || 0;
        const prevImageOver = Math.max(0, imagesToday - CREDIT_IMAGE_DAILY_FREE);
        const newImageOver = Math.max(
          0,
          imagesToday + newImages - CREDIT_IMAGE_DAILY_FREE
        );
        const imageCost = (newImageOver - prevImageOver) * CREDIT_IMAGE_OVERAGE_COST;

        const audioSecondsWeek = Number(usageCounters.audioSecondsWeek) || 0;
        const newAudioSeconds = Number(context.mediaStats?.audioSeconds) || 0;
        const prevAudioOver = Math.max(
          0,
          audioSecondsWeek / 60 - CREDIT_AUDIO_WEEKLY_FREE_MINUTES
        );
        const newAudioOver = Math.max(
          0,
          (audioSecondsWeek + newAudioSeconds) / 60 - CREDIT_AUDIO_WEEKLY_FREE_MINUTES
        );
        const audioCost = (newAudioOver - prevAudioOver) * CREDIT_AUDIO_OVERAGE_COST;

        const decisionCost = useDecisionModel ? CREDIT_DECISION_COST : 0;

        estimatedCost = Math.max(0, decisionCost + imageCost + audioCost);
        costBreakdown = {
          decisionCost,
          imageCost,
          audioCost,
          newImages,
          newAudioSeconds,
        };

        const availableCredits = creditState?.availableCredits ?? 0;
        if (estimatedCost > 0 && availableCredits < estimatedCost) {
          return {
            reply: buildPaywallMessage({
              availableCredits,
              neededCredits: estimatedCost,
              userId,
            }),
            metadata: {
              resolvedFight: runtimeState.resolvedFight,
              eventCard: runtimeState.eventCard,
            },
          };
        }
      }

      const extraSections = [];
      if (wantsLedger && ledgerSummary) {
        extraSections.push(
          '[LEDGER_SUMMARY]',
          JSON.stringify(ledgerSummary, null, 2)
        );
      }

      if (wantsLedger && userStore?.getBetHistory) {
        const bets = userStore.getBetHistory(userId, 10);
        if (bets?.length) {
          extraSections.push('[RECENT_BETS]', JSON.stringify(bets, null, 2));
        }
      }

      if ((wantsOdds || wantsBetDecision) && oddsSnapshot) {
        extraSections.push('[ODDS_SNAPSHOT]', JSON.stringify(oddsSnapshot, null, 2));
      }

      const userPayload = buildUserPayload({
        originalMessage,
        resolvedMessage,
        resolution,
        sessionMemory,
        temporalContext: temporalContext.sectionText,
        recentTurns,
        hasMedia,
        extraSections,
      });

      const tools = buildResponsesTools({ timezone: temporalContext.timezone });

      const messageContent = [{ type: 'input_text', text: userPayload }];
      const extraItems = [];
      for (const item of mediaItems) {
        if (!item || !item.type) continue;
        if (item.type === 'input_image' || item.type === 'input_file') {
          messageContent.push(item);
        } else {
          extraItems.push(item);
        }
      }

      const inputPayload = [
        {
          role: 'user',
          content: messageContent,
        },
        ...extraItems,
      ];

      const result = await runResponsesWithTools({
        client,
        tools,
        instructions: systemPrompt,
        input: hasMedia ? inputPayload : userPayload,
        executeTool,
        model: modelToUse,
      });

      if (userStore?.recordUsage && userId) {
        try {
          userStore.recordUsage({
            userId,
            sessionId: chatId,
            model: modelToUse || MODEL,
            usage: result.usage,
            usedWebSearch: result.usedWebSearch,
            inputImages: context.mediaStats?.imageCount || 0,
            audioSeconds: context.mediaStats?.audioSeconds || 0,
          });
        } catch (usageError) {
          console.error('⚠️ No se pudo guardar usage:', usageError);
        }
      }

      if (CREDIT_ENFORCE && userId && userStore?.spendCredits && estimatedCost > 0) {
        try {
          userStore.spendCredits(userId, estimatedCost, {
            reason: 'analysis',
            metadata: {
              model: modelToUse || MODEL,
              ...costBreakdown,
            },
          });
        } catch (creditError) {
          console.error('⚠️ No se pudo debitar credits:', creditError);
        }
      }

      if (isCalendarQuestion(originalMessage) && !result.usedWebSearch) {
        return {
          reply:
            'No pude validar en vivo la cartelera/calendario ahora mismo. Si queres, reformulalo con fecha exacta y lo reintento.',
          metadata: {
            resolvedFight: runtimeState.resolvedFight,
            eventCard: runtimeState.eventCard,
          },
        };
      }

      const reply = result.reply?.trim();
      if (!reply) {
        return {
          reply:
            'No pude terminar el analisis en este turno. Si queres, reformulalo en una frase y lo reintento.',
          metadata: {
            resolvedFight: runtimeState.resolvedFight,
            eventCard: runtimeState.eventCard,
          },
        };
      }

      const citationFooter = shouldShowCitations(originalMessage)
        ? formatCitationsFooter(result.citations)
        : '';
      const replyWithRationale = enforceRationaleSection(reply, originalMessage);
      const replyWithStakeCalibration = enforceStakeCalibration(
        replyWithRationale,
        originalMessage,
        userProfile || {}
      );
      const replyWithTemporalGuard = enforceCalendarNoEventContext(
        replyWithStakeCalibration,
        originalMessage,
        temporalContext
      );

      return {
        reply: `${replyWithTemporalGuard}${citationFooter}`,
        metadata: {
          resolvedFight: runtimeState.resolvedFight,
          eventCard: runtimeState.eventCard,
        },
      };
    } catch (error) {
      console.error('💥 Error en Betting Wizard:', error);
      return {
        reply: '⚠️ Betting Wizard no esta disponible ahora.',
        metadata: {
          resolvedFight: runtimeState.resolvedFight,
          eventCard: runtimeState.eventCard,
        },
      };
    }
  }

  return { handleMessage };
}

export default { createBettingWizard };
