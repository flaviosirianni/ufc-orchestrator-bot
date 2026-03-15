import fs from 'node:fs';
import path from 'node:path';
import OpenAI from 'openai';
import '../core/env.js';
import { resolveAutoSettlementCandidate } from '../core/autoSettlement.js';

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
const STAKE_EVENT_UTILIZATION_CONSERVADOR = Number(
  process.env.STAKE_EVENT_UTILIZATION_CONSERVADOR ?? '28'
);
const STAKE_EVENT_UTILIZATION_MODERADO = Number(
  process.env.STAKE_EVENT_UTILIZATION_MODERADO ?? '35'
);
const STAKE_EVENT_UTILIZATION_AGRESIVO = Number(
  process.env.STAKE_EVENT_UTILIZATION_AGRESIVO ?? '45'
);
const STAKE_MAX_PICK_EXPOSURE_CONSERVADOR = Number(
  process.env.STAKE_MAX_PICK_EXPOSURE_CONSERVADOR ?? '16'
);
const STAKE_MAX_PICK_EXPOSURE_MODERADO = Number(
  process.env.STAKE_MAX_PICK_EXPOSURE_MODERADO ?? '22'
);
const STAKE_MAX_PICK_EXPOSURE_AGRESIVO = Number(
  process.env.STAKE_MAX_PICK_EXPOSURE_AGRESIVO ?? '30'
);
const PICK_COMMITTEE_ENABLED = process.env.BETTING_PICK_COMMITTEE === 'true';
const PICK_COMMITTEE_MODEL =
  process.env.BETTING_PICK_COMMITTEE_MODEL || DECISION_MODEL || MODEL;
const PICK_COMMITTEE_MIN_EDGE_PCT = Number(process.env.BETTING_MIN_EDGE_PCT ?? '4');
const PICK_COMMITTEE_MIN_CONFIDENCE = Number(
  process.env.BETTING_MIN_CONFIDENCE ?? '58'
);
const PICK_COMMITTEE_MAX_PENALTY = Number(
  process.env.BETTING_MAX_CONFIDENCE_PENALTY ?? '45'
);
const EVENT_INTEL_NEWS_USER_LIMIT = Number(process.env.EVENT_INTEL_NEWS_USER_LIMIT ?? '8');
const EVENT_INTEL_PROJECTION_NEWS_LIMIT = Number(
  process.env.EVENT_INTEL_PROJECTION_NEWS_LIMIT ?? '80'
);
const EVENT_INTEL_NEWS_DEFAULT_MIN_IMPACT =
  process.env.EVENT_INTEL_NEWS_DEFAULT_MIN_IMPACT || 'medium';
const FACT_FRESHNESS_MAX_AGE_DAYS = Math.max(
  30,
  Number(process.env.FACT_FRESHNESS_MAX_AGE_DAYS ?? '420')
);

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
      'Actualiza apuestas existentes (settle/set_pending/archive) con guardrails. Acepta mutacion simple o compuesta por pasos.',
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
        transactionPolicy: {
          type: 'string',
          description: 'Para steps compuestos: all_or_nothing.',
        },
        steps: {
          type: 'array',
          description:
            'Lista de mutaciones a ejecutar en lote (cada paso usa el mismo esquema de operation/result/selectores).',
          items: {
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
              },
              eventName: { type: 'string' },
              fight: { type: 'string' },
              pick: { type: 'string' },
              limit: { type: 'number' },
              reason: { type: 'string' },
            },
            additionalProperties: false,
          },
        },
      },
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

function hasConcreteOddsContext(message = '') {
  const text = normalise(message);
  if (!text) return false;

  if (/@\s?\d+([.,]\d+)?/.test(text)) {
    return true;
  }

  if (/\b(?:cuota|odds?|quote|linea|línea)\b[^0-9@]{0,10}@?\s*\d+([.,]\d+)?/.test(text)) {
    return true;
  }

  if (/\b(o|u)\s?\d+([.,]\d+)?\b/.test(text)) {
    return true;
  }

  if (
    /\b(moneyline|ml|over|under|totales|props)\b/.test(text) &&
    /\b\d+([.,]\d+)?\b/.test(text)
  ) {
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

function hasCreditSignals(message = '') {
  const text = normalise(message);
  if (!text) return false;
  return /\b(credito|creditos|credits|saldo|recarga|cargar creditos|topup|packs?)\b/.test(
    text
  );
}

function hasLatestNewsSignals(message = '') {
  const text = normalise(message);
  if (!text) return false;
  return /\b(ultimas novedades|ultimas noticias|ultimas novedaes|novedades|novedaes|noticias relevantes|latest news|news)\b/.test(
    text
  ) && /\b(ufc|evento|proximo|peleador|peleadores)\b/.test(text);
}

function hasEventProjectionSignals(message = '') {
  const text = normalise(message);
  if (!text) return false;
  return /\b(proyeccion|proyecciones|prediccion|predicciones|que crees que va a pasar|projections?)\b/.test(
    text
  ) && /\b(ufc|evento|proximo|pelea|peleas)\b/.test(text);
}

function hasLiveEventStatusSignals(message = '') {
  const text = normalise(message);
  if (!text) return false;
  if (
    /\b(pelea|fight|combate)\b/.test(text) &&
    /\b(viene|sigue|falta|faltan|proxima|próxima)\b/.test(text)
  ) {
    return false;
  }
  const hasLiveWords = /\b(ahora|ahora mismo|en vivo|vivo|live|en este momento)\b/.test(text);
  const hasEventWords = /\b(ufc|evento|cartelera|main card|main event)\b/.test(text);
  const hasAskWords = /\b(que|cual|fijate|decime|dime|mostrame|hay|esta)\b/.test(text);
  return hasLiveWords && hasEventWords && hasAskWords;
}

function hasFightResultLookupSignals(message = '') {
  const text = normalise(message);
  if (!text) return false;
  if (
    /\b(como salio|como salieron|como termino|como terminaron|resultado|quien gano|quien ganó|ya termino|ya terminó|ya finalizo|ya finalizó|ya terminaron|ya finalizaron)\b/.test(
      text
    )
  ) {
    return true;
  }
  const hasResultWords =
    /\b(resultado|salio|salieron|termino|terminaron|finalizo|finalizaron|gano|ganaron|ganador|winner)\b/.test(
      text
    );
  const hasFightWords = /\b(pelea|fight|combate|vs|versus|evento|ufc)\b/.test(text);
  return hasResultWords && hasFightWords;
}

function parseNewsAlertsIntent(message = '') {
  const text = normalise(message);
  if (!text || !/\b(alerta|alertas)\b/.test(text)) {
    return null;
  }

  const wantsStatus = /\b(estado|status|como estan|como quedaron)\b/.test(text);
  const wantsEnable = /\b(activar|activa|encender|habilitar|on)\b/.test(text);
  const wantsDisable = /\b(desactivar|desactiva|apagar|off|silenciar)\b/.test(text);
  const wantsToggle = /\b(toggle|cambiar)\b/.test(text);

  if (!wantsStatus && !wantsEnable && !wantsDisable && !wantsToggle) {
    return { type: 'status' };
  }
  if (wantsEnable) {
    return { type: 'set', enabled: true };
  }
  if (wantsDisable) {
    return { type: 'set', enabled: false };
  }
  if (wantsToggle) {
    return { type: 'toggle' };
  }
  return { type: 'status' };
}

function normalizeImpactBucket(value = 'medium') {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'high' || raw === 'medium' || raw === 'low') return raw;
  if (raw === 'alto' || raw === 'alta') return 'high';
  if (raw === 'medio' || raw === 'media') return 'medium';
  if (raw === 'bajo' || raw === 'baja') return 'low';
  return 'medium';
}

function impactRank(level = 'medium') {
  const normalized = normalizeImpactBucket(level);
  if (normalized === 'high') return 3;
  if (normalized === 'medium') return 2;
  return 1;
}

function impactWeight(level = 'medium') {
  const normalized = normalizeImpactBucket(level);
  if (normalized === 'high') return 18;
  if (normalized === 'medium') return 9;
  return 4;
}

function formatImpactBadge(level = 'medium') {
  const normalized = normalizeImpactBucket(level);
  if (normalized === 'high') return '🔴 alta';
  if (normalized === 'medium') return '🟠 media';
  return '🟢 baja';
}

function toFighterSlug(name = '') {
  return normalise(name)
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function textMentionsFighter(text = '', fighterName = '') {
  const normalizedText = normalise(text);
  const normalizedFighter = normalise(fighterName);
  if (!normalizedText || !normalizedFighter) return false;
  if (normalizedText.includes(normalizedFighter)) return true;
  const surname = normalizedFighter.split(/\s+/).filter(Boolean).slice(-1)[0] || '';
  if (surname.length >= 4 && normalizedText.includes(surname)) return true;
  return false;
}

function inferNewsDirection(title = '') {
  const text = normalise(title);
  if (!text) return 0;
  const negativeSignals =
    /\b(injury|injured|out of|out for|withdraw|withdrawn|replacement|replaced|miss weight|weight miss|hospital|suspend|suspended|visa issue|cancel|cancelled|failed weigh|medical issue)\b/;
  const positiveSignals =
    /\b(cleared|healthy|ready|in shape|great camp|looks sharp|on weight|fully fit)\b/;
  if (negativeSignals.test(text)) return -1;
  if (positiveSignals.test(text)) return 1;
  return 0;
}

function newsItemTargetsFighter(item = {}, fighterName = '') {
  const slug = String(item?.fighterSlug || '').trim().toLowerCase();
  const targetSlug = toFighterSlug(fighterName);
  if (slug && targetSlug && slug === targetSlug) return true;
  const text = [item?.fighterName, item?.title, item?.summary].filter(Boolean).join(' ');
  return textMentionsFighter(text, fighterName);
}

function compareNewsPriority(a, b) {
  const impactDiff = impactRank(b?.impactLevel) - impactRank(a?.impactLevel);
  if (impactDiff !== 0) return impactDiff;
  const confidenceDiff = Number(b?.confidenceScore || 0) - Number(a?.confidenceScore || 0);
  if (confidenceDiff !== 0) return confidenceDiff;
  const timeA = Date.parse(String(a?.publishedAt || a?.fetchedAt || '')) || 0;
  const timeB = Date.parse(String(b?.publishedAt || b?.fetchedAt || '')) || 0;
  return timeB - timeA;
}

function formatEventDateLabel(eventDateUtc = '', timezone = DEFAULT_USER_TIMEZONE) {
  const raw = String(eventDateUtc || '').trim();
  if (!raw) return 'N/D';
  const isoLike = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T12:00:00Z` : raw;
  return formatIsoForUser(isoLike, timezone);
}

function toIsoDateSafe(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const parsedMs = Date.parse(raw);
  if (!Number.isFinite(parsedMs)) return null;
  return new Date(parsedMs).toISOString().slice(0, 10);
}

function toIsoDateStrict(year, month, day) {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const candidate = new Date(Date.UTC(y, m - 1, d));
  if (
    candidate.getUTCFullYear() !== y ||
    candidate.getUTCMonth() + 1 !== m ||
    candidate.getUTCDate() !== d
  ) {
    return null;
  }
  return candidate.toISOString().slice(0, 10);
}

function parseHistoryDateCellToIso(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return null;

  const isoMatch = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (isoMatch) {
    return toIsoDateStrict(isoMatch[1], isoMatch[2], isoMatch[3]);
  }

  const dayFirst = raw.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/);
  if (dayFirst) {
    const year = Number(dayFirst[3]) < 100 ? 2000 + Number(dayFirst[3]) : Number(dayFirst[3]);
    return toIsoDateStrict(year, dayFirst[2], dayFirst[1]);
  }

  return toIsoDateSafe(raw);
}

function pickLatestIsoDate(...values) {
  const candidates = values.flat().map((value) => toIsoDateSafe(value || '')).filter(Boolean);
  if (!candidates.length) return null;
  let latest = candidates[0];
  for (const isoDate of candidates.slice(1)) {
    if (dateDiffInDays(isoDate, latest) > 0) {
      latest = isoDate;
    }
  }
  return latest;
}

function dateDiffInDays(isoA = '', isoB = '') {
  const a = String(isoA || '').trim();
  const b = String(isoB || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a) || !/^\d{4}-\d{2}-\d{2}$/.test(b)) {
    return Number.POSITIVE_INFINITY;
  }
  const msA = Date.parse(`${a}T00:00:00Z`);
  const msB = Date.parse(`${b}T00:00:00Z`);
  if (!Number.isFinite(msA) || !Number.isFinite(msB)) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.round((msA - msB) / 86400000);
}

function resolveReferenceDateIso({
  referenceDateIso = null,
  nowMs = Date.now(),
  timezone = DEFAULT_USER_TIMEZONE,
} = {}) {
  const explicit = toIsoDateSafe(referenceDateIso || '');
  if (explicit) return explicit;
  const localNow = extractLocalDateTimeParts(new Date(nowMs), normalizeTimeZone(timezone));
  return toIsoDateSafe(localNow.dateIso) || new Date(nowMs).toISOString().slice(0, 10);
}

function isEventStateNearToday(
  eventState = null,
  nowMs = Date.now(),
  maxDistanceDays = 1,
  { referenceDateIso = null, timezone = DEFAULT_USER_TIMEZONE } = {}
) {
  const eventDate = toIsoDateSafe(eventState?.eventDateUtc || '');
  if (!eventDate) return false;
  const todayIso = resolveReferenceDateIso({ referenceDateIso, nowMs, timezone });
  const distance = Math.abs(dateDiffInDays(eventDate, todayIso));
  return Number.isFinite(distance) && distance <= Math.max(0, Number(maxDistanceDays) || 0);
}

function collectMonitoredFightersFromMainCard(mainCard = []) {
  const fights = Array.isArray(mainCard) ? mainCard : [];
  const out = [];
  const seen = new Set();
  for (const fight of fights) {
    for (const raw of [fight?.fighterA, fight?.fighterB]) {
      const name = String(raw || '').trim();
      if (!name) continue;
      const key = normalise(name);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(name);
    }
  }
  return out;
}

function buildLiveOddsFightHints(oddsEvents = [], nowMs = Date.now()) {
  const rows = Array.isArray(oddsEvents) ? oddsEvents : [];
  if (!rows.length) return [];
  const near = rows
    .filter((row) => {
      const commenceMs = Date.parse(String(row?.commenceTime || ''));
      if (!Number.isFinite(commenceMs)) return false;
      const deltaHours = Math.abs(commenceMs - nowMs) / 3600000;
      return deltaHours <= 10;
    })
    .sort((a, b) => {
      const aMs = Date.parse(String(a?.commenceTime || '')) || 0;
      const bMs = Date.parse(String(b?.commenceTime || '')) || 0;
      const aDelta = Math.abs(aMs - nowMs);
      const bDelta = Math.abs(bMs - nowMs);
      if (aDelta !== bDelta) return aDelta - bDelta;
      return aMs - bMs;
    });

  const seen = new Set();
  const hints = [];
  for (const row of near) {
    const home = String(row?.homeTeam || '').trim();
    const away = String(row?.awayTeam || '').trim();
    if (!home || !away) continue;
    const key = [normalise(home), normalise(away)].sort().join('::');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    hints.push(`${home} vs ${away}`);
    if (hints.length >= 4) break;
  }
  return hints;
}

function mergeOddsEventRows(...lists) {
  const rows = lists.flatMap((items) => (Array.isArray(items) ? items : []));
  if (!rows.length) return [];
  const merged = new Map();
  for (const row of rows) {
    const eventId = String(row?.eventId || '').trim();
    const eventName = String(row?.eventName || '').trim();
    const commence = String(row?.commenceTime || '').trim();
    const home = String(row?.homeTeam || '').trim();
    const away = String(row?.awayTeam || '').trim();
    const fightKey =
      home && away ? `${normalise(home)}::${normalise(away)}` : '';
    const key = eventId
      ? `${eventId}::${fightKey || commence || normalise(eventName)}`
      : `${normalise(eventName)}::${commence}::${fightKey || 'no_fight'}`;
    if (!key) continue;
    const current = merged.get(key);
    if (!current) {
      merged.set(key, row);
      continue;
    }

    const currentUpdated = Date.parse(
      String(current?.lastScoresSyncAt || current?.lastOddsSyncAt || current?.updatedAt || '')
    );
    const candidateUpdated = Date.parse(
      String(row?.lastScoresSyncAt || row?.lastOddsSyncAt || row?.updatedAt || '')
    );

    if (
      Number.isFinite(candidateUpdated) &&
      (!Number.isFinite(currentUpdated) || candidateUpdated > currentUpdated)
    ) {
      merged.set(key, row);
    } else if (!current?.scores && Array.isArray(row?.scores) && row.scores.length) {
      merged.set(key, row);
    } else if (current?.completed === true && row?.completed === false) {
      merged.set(key, row);
    }
  }
  return Array.from(merged.values());
}

function buildEventStateFromOddsRows({
  oddsRows = [],
  eventContext = null,
} = {}) {
  const rows = Array.isArray(oddsRows) ? oddsRows : [];
  if (!rows.length || !eventContext?.eventName) return null;

  const contextEventId = String(eventContext?.eventId || '').trim();
  const contextEventName = normalise(eventContext?.eventName || '');
  const contextEventDate = toIsoDateSafe(eventContext?.eventDate || '');

  const related = rows.filter((row) => {
    const rowEventId = String(row?.eventId || '').trim();
    if (contextEventId && rowEventId && rowEventId === contextEventId) {
      return true;
    }
    const rowEventName = normalise(row?.eventName || '');
    if (!rowEventName || rowEventName !== contextEventName) {
      return false;
    }
    if (!contextEventDate) return true;
    const rowDate = toIsoDateSafe(row?.commenceTime || '');
    if (!rowDate) return true;
    return Math.abs(dateDiffInDays(rowDate, contextEventDate)) <= 1;
  });

  if (!related.length) return null;

  const fightMap = new Map();
  let latestSyncMs = 0;
  for (const row of related) {
    const fighterA = String(row?.homeTeam || '').trim();
    const fighterB = String(row?.awayTeam || '').trim();
    if (!fighterA || !fighterB) continue;
    const fightKey = [normalise(fighterA), normalise(fighterB)].sort().join('::');
    if (!fightKey) continue;

    const syncMs =
      Date.parse(String(row?.lastScoresSyncAt || row?.lastOddsSyncAt || row?.updatedAt || '')) || 0;
    latestSyncMs = Math.max(latestSyncMs, syncMs);

    const existing = fightMap.get(fightKey) || {
      fighterA,
      fighterB,
      isCompleted: false,
      hasScores: false,
      updatedMs: 0,
    };
    const nextCompleted = existing.isCompleted || row?.completed === true;
    const nextHasScores = existing.hasScores || (Array.isArray(row?.scores) && row.scores.length > 0);
    const updatedMs = Math.max(existing.updatedMs || 0, syncMs);

    fightMap.set(fightKey, {
      fighterA: existing.fighterA || fighterA,
      fighterB: existing.fighterB || fighterB,
      isCompleted: nextCompleted,
      hasScores: nextHasScores,
      updatedMs,
    });
  }

  const fights = Array.from(fightMap.values())
    .sort((a, b) => {
      if (a.isCompleted !== b.isCompleted) {
        return a.isCompleted ? 1 : -1;
      }
      return (b.updatedMs || 0) - (a.updatedMs || 0);
    })
    .map((fight, index) => ({
      fightId: `fight_${index + 1}`,
      fighterA: fight.fighterA,
      fighterB: fight.fighterB,
      isCompleted: Boolean(fight.isCompleted),
      hasScores: Boolean(fight.hasScores),
    }));

  if (!fights.length) return null;

  const eventId =
    contextEventId ||
    String(related[0]?.eventId || '').trim() ||
    `${normalise(eventContext.eventName)}_${contextEventDate || 'unknown'}`;
  return {
    eventId,
    eventName: String(eventContext.eventName || '').trim(),
    eventDateUtc: contextEventDate || toIsoDateSafe(related[0]?.commenceTime || ''),
    sourcePrimary: 'odds_scores_live',
    updatedAt: latestSyncMs > 0 ? new Date(latestSyncMs).toISOString() : null,
    mainCard: fights,
  };
}

function shouldPreferOddsEventForIntel({
  fallbackEventState = null,
  liveEventState = null,
  liveOddsContext = null,
  nowMs = Date.now(),
  referenceDateIso = null,
  timezone = DEFAULT_USER_TIMEZONE,
} = {}) {
  if (!liveEventState?.eventName) return false;
  if (!fallbackEventState?.eventName) return true;

  const fallbackName = normalise(fallbackEventState?.eventName || '');
  const liveName = normalise(liveEventState?.eventName || '');
  const sameName = Boolean(fallbackName && liveName && fallbackName === liveName);

  const todayIso = resolveReferenceDateIso({ referenceDateIso, nowMs, timezone });
  const fallbackDate = toIsoDateSafe(fallbackEventState?.eventDateUtc || '');
  const liveDate = toIsoDateSafe(liveEventState?.eventDateUtc || liveOddsContext?.eventDate || '');
  const fallbackDistance = fallbackDate
    ? Math.abs(dateDiffInDays(fallbackDate, todayIso))
    : Number.POSITIVE_INFINITY;
  const liveDistance = liveDate
    ? Math.abs(dateDiffInDays(liveDate, todayIso))
    : Number.POSITIVE_INFINITY;
  const confidence = Number(liveOddsContext?.confidenceScore || 0);
  const hasOpenFights = Array.isArray(liveEventState?.mainCard)
    ? liveEventState.mainCard.some((fight) => fight?.isCompleted !== true)
    : false;

  if (sameName && fallbackDistance <= 1) return false;
  if (hasOpenFights && liveDistance <= 1 && (!sameName || fallbackDistance > 1)) {
    return true;
  }
  if (!sameName && confidence >= 60 && liveDistance <= 1 && fallbackDistance >= 2) {
    return true;
  }
  if (liveDistance + 1 < fallbackDistance && confidence >= 70) {
    return true;
  }
  return false;
}

function buildSyntheticEventId(eventName = '', eventDateIso = null) {
  const slug = normalise(eventName)
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
  const safeSlug = slug || 'ufc_event';
  const safeDate = String(eventDateIso || '').trim() || 'unknown_date';
  return `${safeSlug}_${safeDate}`;
}

function eventsLikelySame(eventA = null, eventB = null) {
  if (!eventA?.eventName || !eventB?.eventName) return false;
  const idA = String(eventA?.eventId || '').trim();
  const idB = String(eventB?.eventId || '').trim();
  if (idA && idB && idA === idB) return true;

  const nameA = normalise(eventA?.eventName || '');
  const nameB = normalise(eventB?.eventName || '');
  if (!nameA || !nameB || nameA !== nameB) return false;

  const dateA = toIsoDateSafe(eventA?.eventDateUtc || '');
  const dateB = toIsoDateSafe(eventB?.eventDateUtc || '');
  if (!dateA || !dateB) return true;
  return Math.abs(dateDiffInDays(dateA, dateB)) <= 1;
}

function buildEventStateFromWebContext({
  webContext = null,
  fallbackEventState = null,
} = {}) {
  const eventName = String(webContext?.eventName || '').trim();
  if (!eventName) return null;
  const eventDate =
    toIsoDateSafe(webContext?.date || webContext?.eventDateUtc || '') ||
    toIsoDateSafe(fallbackEventState?.eventDateUtc || '');
  const fightsFromWeb = Array.isArray(webContext?.fights)
    ? webContext.fights
        .filter((fight) => fight?.fighterA && fight?.fighterB)
        .map((fight, index) => ({
          fightId: `fight_${index + 1}`,
          fighterA: String(fight.fighterA || '').trim(),
          fighterB: String(fight.fighterB || '').trim(),
          isCompleted: false,
          hasScores: false,
        }))
    : [];

  const fallbackFights = Array.isArray(fallbackEventState?.mainCard)
    ? fallbackEventState.mainCard.filter((fight) => fight?.fighterA && fight?.fighterB)
    : [];
  const fights = fightsFromWeb.length ? fightsFromWeb : fallbackFights;

  const explicitEventId = String(webContext?.eventId || '').trim();
  let eventId = explicitEventId;
  if (!eventId) {
    if (
      fallbackEventState?.eventId &&
      eventsLikelySame(
        {
          eventName,
          eventDateUtc: eventDate,
        },
        fallbackEventState
      )
    ) {
      eventId = String(fallbackEventState.eventId || '').trim();
    } else {
      eventId = buildSyntheticEventId(eventName, eventDate || null);
    }
  }

  return {
    eventId,
    eventName,
    eventDateUtc: eventDate || null,
    sourcePrimary: String(webContext?.source || '').trim() || 'web_live_context',
    updatedAt: new Date().toISOString(),
    mainCard: fights,
  };
}

function mergeEventStateWithLiveSignals({
  baseEventState = null,
  liveEventState = null,
} = {}) {
  const base = baseEventState || null;
  const live = liveEventState || null;
  if (!live?.eventName) return base;
  if (!base?.eventName) return live;
  if (!eventsLikelySame(base, live)) return base;

  const baseFights = Array.isArray(base.mainCard)
    ? base.mainCard.filter((fight) => fight?.fighterA && fight?.fighterB)
    : [];
  const liveFights = Array.isArray(live.mainCard)
    ? live.mainCard.filter((fight) => fight?.fighterA && fight?.fighterB)
    : [];
  if (!baseFights.length) {
    return {
      ...base,
      eventId: base.eventId || live.eventId || null,
      eventDateUtc: base.eventDateUtc || live.eventDateUtc || null,
      sourcePrimary: base.sourcePrimary || live.sourcePrimary || null,
      updatedAt: live.updatedAt || base.updatedAt || null,
      mainCard: liveFights,
    };
  }

  const liveByFightKey = new Map();
  for (const fight of liveFights) {
    const key = [normalise(fight.fighterA), normalise(fight.fighterB)].sort().join('::');
    if (!key) continue;
    liveByFightKey.set(key, fight);
  }

  const merged = [];
  const seen = new Set();
  for (const fight of baseFights) {
    const key = [normalise(fight.fighterA), normalise(fight.fighterB)].sort().join('::');
    if (!key) continue;
    const liveMatch = liveByFightKey.get(key);
    seen.add(key);
    if (liveMatch) {
      merged.push({
        ...fight,
        isCompleted: Boolean(
          fight?.isCompleted === true || liveMatch?.isCompleted === true
        ),
        hasScores: Boolean(fight?.hasScores || liveMatch?.hasScores),
      });
    } else {
      merged.push(fight);
    }
  }
  for (const fight of liveFights) {
    const key = [normalise(fight.fighterA), normalise(fight.fighterB)].sort().join('::');
    if (!key || seen.has(key)) continue;
    merged.push(fight);
  }

  return {
    ...base,
    eventId: base.eventId || live.eventId || null,
    eventDateUtc: base.eventDateUtc || live.eventDateUtc || null,
    sourcePrimary: base.sourcePrimary || live.sourcePrimary || null,
    updatedAt: live.updatedAt || base.updatedAt || null,
    mainCard: merged,
  };
}

function shouldPreferWebEventForIntel({
  fallbackEventState = null,
  webEventState = null,
  nowMs = Date.now(),
  referenceDateIso = null,
  timezone = DEFAULT_USER_TIMEZONE,
} = {}) {
  if (!webEventState?.eventName) return false;
  if (!fallbackEventState?.eventName) return true;

  const sameEvent = eventsLikelySame(fallbackEventState, webEventState);
  const todayIso = resolveReferenceDateIso({ referenceDateIso, nowMs, timezone });
  const fallbackDate = toIsoDateSafe(fallbackEventState?.eventDateUtc || '');
  const webDate = toIsoDateSafe(webEventState?.eventDateUtc || '');
  const fallbackDistance = fallbackDate
    ? Math.abs(dateDiffInDays(fallbackDate, todayIso))
    : Number.POSITIVE_INFINITY;
  const webDistance = webDate
    ? Math.abs(dateDiffInDays(webDate, todayIso))
    : Number.POSITIVE_INFINITY;

  if (sameEvent && fallbackDistance <= 1) return false;
  if (webDistance <= 1 && fallbackDistance > 1) return true;
  if (webDistance + 1 < fallbackDistance) return true;
  return false;
}

function buildLiveOddsEventContext(
  oddsEvents = [],
  nowMs = Date.now(),
  { referenceDateIso = null, timezone = DEFAULT_USER_TIMEZONE } = {}
) {
  const rows = Array.isArray(oddsEvents) ? oddsEvents : [];
  if (!rows.length) return null;
  const todayIso = resolveReferenceDateIso({ referenceDateIso, nowMs, timezone });

  const grouped = new Map();
  for (const row of rows) {
    const commenceMs = Date.parse(String(row?.commenceTime || ''));
    if (!Number.isFinite(commenceMs)) continue;
    const deltaHours = Math.abs(commenceMs - nowMs) / 3600000;
    if (deltaHours > 20) continue;

    const eventName = String(row?.eventName || '').trim();
    if (!eventName) continue;
    const groupKey =
      String(row?.eventId || '').trim() || `${normalise(eventName)}::${toIsoDateSafe(row?.commenceTime) || 'na'}`;
    if (!groupKey) continue;

    const entry =
      grouped.get(groupKey) ||
      {
        eventId: String(row?.eventId || '').trim() || null,
        eventName,
        eventDate: toIsoDateSafe(row?.commenceTime),
        minDeltaMs: Number.POSITIVE_INFINITY,
        fights: new Set(),
        hasScores: false,
        hasInProgressSignal: false,
        latestSyncMs: 0,
        hasCompletedSignal: false,
      };

    entry.minDeltaMs = Math.min(entry.minDeltaMs, Math.abs(commenceMs - nowMs));
    const home = String(row?.homeTeam || '').trim();
    const away = String(row?.awayTeam || '').trim();
    if (home && away) {
      entry.fights.add(`${home} vs ${away}`);
    }
    if (row?.completed === true) {
      entry.hasCompletedSignal = true;
    } else if (row?.completed === false) {
      entry.hasInProgressSignal = true;
    }
    if (Array.isArray(row?.scores) && row.scores.length) {
      entry.hasScores = true;
    }
    const syncMs =
      Date.parse(String(row?.lastScoresSyncAt || row?.lastOddsSyncAt || row?.updatedAt || '')) || 0;
    entry.latestSyncMs = Math.max(entry.latestSyncMs, syncMs);

    grouped.set(groupKey, entry);
  }

  const candidates = Array.from(grouped.values());
  if (!candidates.length) return null;

  const scored = candidates.map((entry) => {
    const minDeltaHours = entry.minDeltaMs / 3600000;
    const eventDateDiff = entry.eventDate
      ? Math.abs(dateDiffInDays(entry.eventDate, todayIso))
      : Number.POSITIVE_INFINITY;
    const freshnessHours =
      entry.latestSyncMs > 0 ? (nowMs - entry.latestSyncMs) / 3600000 : Number.POSITIVE_INFINITY;

    let score = 0;
    score += Math.min(entry.fights.size, 8) * 2.2;
    score += Math.max(0, 12 - minDeltaHours) * 2.1;
    if (entry.hasScores) score += 20;
    if (entry.hasInProgressSignal) score += 11;
    if (entry.hasCompletedSignal && !entry.hasInProgressSignal && !entry.hasScores) score -= 8;
    if (eventDateDiff <= 1) score += 9;
    else if (eventDateDiff >= 3) score -= 6;
    if (freshnessHours <= 3) score += 9;
    else if (freshnessHours <= 8) score += 4;
    else if (freshnessHours >= 30) score -= 4;

    return {
      ...entry,
      confidenceScore: Number(clampNumber(score, 0, 100).toFixed(1)),
      minDeltaHours,
    };
  });
  scored.sort((a, b) => {
    if (b.confidenceScore !== a.confidenceScore) {
      return b.confidenceScore - a.confidenceScore;
    }
    const fightsDiff = b.fights.size - a.fights.size;
    if (fightsDiff !== 0) return fightsDiff;
    return a.minDeltaMs - b.minDeltaMs;
  });

  const best = scored[0];
  return {
    eventId: best.eventId || null,
    eventName: best.eventName,
    eventDate: best.eventDate || null,
    fights: Array.from(best.fights).slice(0, 4),
    confidenceScore: best.confidenceScore,
    minDeltaHours: Number(best.minDeltaHours.toFixed(2)),
    evidence: {
      hasScores: Boolean(best.hasScores),
      hasInProgressSignal: Boolean(best.hasInProgressSignal),
      hasCompletedSignal: Boolean(best.hasCompletedSignal),
      latestSyncAt: best.latestSyncMs > 0 ? new Date(best.latestSyncMs).toISOString() : null,
    },
  };
}

function buildFightProjection({ fight = {}, newsItems = [] } = {}) {
  const fighterA = String(fight?.fighterA || '').trim();
  const fighterB = String(fight?.fighterB || '').trim();
  const candidates = Array.isArray(newsItems) ? newsItems : [];

  let scoreA = 0;
  let scoreB = 0;
  const evidence = [];

  for (const item of candidates) {
    const hitsA = newsItemTargetsFighter(item, fighterA);
    const hitsB = newsItemTargetsFighter(item, fighterB);
    if (!hitsA && !hitsB) continue;

    const direction = inferNewsDirection(item?.title || '');
    const confidenceFactor = clampNumber(Number(item?.confidenceScore || 0), 35, 100) / 100;
    const weight = impactWeight(item?.impactLevel) * confidenceFactor;

    if (direction < 0) {
      if (hitsA && !hitsB) scoreB += weight;
      if (hitsB && !hitsA) scoreA += weight;
    } else if (direction > 0) {
      if (hitsA && !hitsB) scoreA += weight * 0.6;
      if (hitsB && !hitsA) scoreB += weight * 0.6;
    } else {
      if (hitsA && !hitsB) scoreA += weight * 0.12;
      if (hitsB && !hitsA) scoreB += weight * 0.12;
    }

    evidence.push(item);
  }

  const diff = scoreA - scoreB;
  const absDiff = Math.abs(diff);
  let projectedWinner = null;
  let confidence = evidence.length ? 53 : 50;
  let scenario = 'Pelea pareja con la intel disponible.';

  if (absDiff >= 4) {
    projectedWinner = diff > 0 ? fighterA : fighterB;
    confidence = clampNumber(56 + absDiff * 1.3, 56, 84);
    if (absDiff >= 12) {
      scenario = `Ventaja clara para ${projectedWinner} por señales de camp/disponibilidad.`;
    } else {
      scenario = `Ligera ventaja para ${projectedWinner} por señales recientes.`;
    }
  } else if (evidence.some((item) => normalizeImpactBucket(item?.impactLevel) === 'high')) {
    confidence = 54;
    scenario = 'Hay señales de alto impacto, pero todavia contrapuestas.';
  }

  return {
    projectedWinner,
    confidence: Math.round(confidence),
    scenario,
    evidence: evidence.sort(compareNewsPriority).slice(0, 2),
  };
}

function parsePositivePrice(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 1) return null;
  return parsed;
}

function impliedProbabilityPct(decimalOdds) {
  const price = parsePositivePrice(decimalOdds);
  if (!price) return null;
  return Math.min(99.99, Math.max(0.01, 100 / price));
}

function pickFighterPriceFromRow(row = {}, fighterName = '') {
  const target = normalise(fighterName);
  if (!target) return null;

  const candidates = [
    {
      name: row?.outcomeAName || row?.homeTeam || '',
      price: parsePositivePrice(row?.outcomeAPrice),
    },
    {
      name: row?.outcomeBName || row?.awayTeam || '',
      price: parsePositivePrice(row?.outcomeBPrice),
    },
  ];

  const direct = candidates.find((item) => normalise(item.name) === target && item.price);
  if (direct) return direct.price;

  const surname = target.split(/\s+/).filter(Boolean).slice(-1)[0] || '';
  if (surname.length >= 4) {
    const bySurname = candidates.find(
      (item) => normalise(item.name).includes(surname) && item.price
    );
    if (bySurname) return bySurname.price;
  }

  return null;
}

function buildOddsConsensusForFight({
  rows = [],
  fighterA = '',
  fighterB = '',
} = {}) {
  const inputRows = Array.isArray(rows) ? rows : [];
  if (!inputRows.length) return null;

  const latestByBookmaker = new Map();
  for (const row of inputRows) {
    const bookmakerKey = String(row?.bookmakerKey || row?.bookmakerTitle || '').trim();
    if (!bookmakerKey) continue;
    const existing = latestByBookmaker.get(bookmakerKey);
    const thisTs = Date.parse(String(row?.fetchedAt || row?.sourceLastUpdate || '')) || 0;
    const existingTs = existing
      ? Date.parse(String(existing?.fetchedAt || existing?.sourceLastUpdate || '')) || 0
      : 0;
    if (!existing || thisTs >= existingTs) {
      latestByBookmaker.set(bookmakerKey, row);
    }
  }

  let totalA = 0;
  let totalB = 0;
  let count = 0;

  for (const row of latestByBookmaker.values()) {
    const priceA = pickFighterPriceFromRow(row, fighterA);
    const priceB = pickFighterPriceFromRow(row, fighterB);
    if (!priceA || !priceB) continue;
    totalA += priceA;
    totalB += priceB;
    count += 1;
  }

  if (!count) return null;

  const avgA = totalA / count;
  const avgB = totalB / count;
  const impliedA = impliedProbabilityPct(avgA);
  const impliedB = impliedProbabilityPct(avgB);

  return {
    bookmakersCount: count,
    avgPriceA: avgA,
    avgPriceB: avgB,
    impliedA,
    impliedB,
  };
}

function projectionSnapshotMatchesFight(snapshot = {}, fight = {}) {
  const snapshotFightId = String(snapshot?.fightId || '').trim();
  const fightId = String(fight?.fightId || '').trim();
  if (snapshotFightId && fightId && snapshotFightId === fightId) {
    return true;
  }

  const snapA = normalise(snapshot?.fighterA || '');
  const snapB = normalise(snapshot?.fighterB || '');
  const fightA = normalise(fight?.fighterA || '');
  const fightB = normalise(fight?.fighterB || '');
  if (!snapA || !snapB || !fightA || !fightB) return false;
  return (snapA === fightA && snapB === fightB) || (snapA === fightB && snapB === fightA);
}

function describeProjectedMethod(method = '') {
  const key = String(method || '').trim().toLowerCase();
  if (key === 'inside_distance_or_clear_decision') {
    return 'Ventaja clara para llevarse la pelea.';
  }
  if (key === 'decision_lean') {
    return 'Pelea cerrada, con ligera inclinacion a decision.';
  }
  return 'Escenario mixto con leve ventaja del lado proyectado.';
}

function betScoringRecommendationRank(value = 'no_bet') {
  const key = String(value || '').trim().toLowerCase();
  if (key === 'bet') return 3;
  if (key === 'lean') return 2;
  return 1;
}

function betScoringMarketLabel(marketKey = '') {
  const key = String(marketKey || '').trim().toLowerCase();
  if (key === 'moneyline') return 'Moneyline';
  if (key === 'method') return 'Metodo de victoria';
  if (key === 'total_rounds') return 'Total rounds';
  return key || 'Mercado';
}

function betScoringRecommendationBadge(value = 'no_bet') {
  const key = String(value || '').trim().toLowerCase();
  if (key === 'bet') return '✅ BET';
  if (key === 'lean') return '🟡 LEAN';
  return '⛔ NO BET';
}

function betScoringRiskLabel(value = 'high') {
  const key = String(value || '').trim().toLowerCase();
  if (key === 'low') return 'bajo';
  if (key === 'medium') return 'medio';
  return 'alto';
}

function describeBetScoringNoBetReason(reason = '') {
  const key = String(reason || '').trim().toLowerCase();
  if (key === 'projection_missing') return 'falta proyeccion confiable';
  if (key === 'market_odds_unavailable') return 'sin cuotas disponibles';
  if (key === 'selection_odds_unavailable') return 'sin precio para la seleccion';
  if (key === 'insufficient_edge') return 'edge insuficiente';
  return key ? key.replaceAll('_', ' ') : 'sin edge claro';
}

function compareBetScoringRows(left = {}, right = {}) {
  const recDiff =
    betScoringRecommendationRank(right?.recommendation) -
    betScoringRecommendationRank(left?.recommendation);
  if (recDiff !== 0) return recDiff;

  const edgeDiff = Number(right?.edgePct || 0) - Number(left?.edgePct || 0);
  if (edgeDiff !== 0) return edgeDiff;

  const confidenceDiff = Number(right?.confidencePct || 0) - Number(left?.confidencePct || 0);
  if (confidenceDiff !== 0) return confidenceDiff;

  const booksDiff = Number(right?.booksCount || 0) - Number(left?.booksCount || 0);
  if (booksDiff !== 0) return booksDiff;

  const leftTs = Date.parse(String(left?.createdAt || '')) || 0;
  const rightTs = Date.parse(String(right?.createdAt || '')) || 0;
  return rightTs - leftTs;
}

function renderBetScoringLine(snapshot = {}) {
  const rec = String(snapshot?.recommendation || 'no_bet').trim().toLowerCase();
  const marketLabel = betScoringMarketLabel(snapshot?.marketKey);
  const selection = String(snapshot?.selection || '').trim() || 'sin seleccion';
  const odds =
    Number.isFinite(Number(snapshot?.consensusOdds)) && Number(snapshot?.consensusOdds) > 1
      ? ` @${Number(snapshot.consensusOdds).toFixed(2)}`
      : '';

  if (rec === 'no_bet') {
    return `${betScoringRecommendationBadge(rec)} ${marketLabel}: ${selection}${odds} (${describeBetScoringNoBetReason(
      snapshot?.noBetReason
    )}).`;
  }

  const edge = Number(snapshot?.edgePct || 0).toFixed(1);
  const confidence = Number(snapshot?.confidencePct || 0).toFixed(0);
  const stake =
    Number.isFinite(Number(snapshot?.suggestedStakeUnits)) &&
    Number(snapshot?.suggestedStakeUnits) > 0
      ? ` | stake ${formatUnits(snapshot.suggestedStakeUnits)}u`
      : '';
  return `${betScoringRecommendationBadge(rec)} ${marketLabel}: ${selection}${odds} | edge ${edge}% | confianza ${confidence}% | riesgo ${betScoringRiskLabel(
    snapshot?.riskLevel
  )}${stake}.`;
}

function resolveFightLabelForBetScoring(snapshot = {}, fights = []) {
  const rows = Array.isArray(fights) ? fights : [];
  for (const fight of rows) {
    if (projectionSnapshotMatchesFight(snapshot, fight)) {
      return `${fight.fighterA} vs ${fight.fighterB}`;
    }
  }
  const fighterA = String(snapshot?.fighterA || '').trim();
  const fighterB = String(snapshot?.fighterB || '').trim();
  if (fighterA && fighterB) {
    return `${fighterA} vs ${fighterB}`;
  }
  return 'Pelea no identificada';
}

function listTopEventBetOpportunities({ rows = [], fights = [], limit = 5 } = {}) {
  const candidates = (Array.isArray(rows) ? rows : [])
    .filter((row) => {
      const recommendation = String(row?.recommendation || '').trim().toLowerCase();
      if (recommendation !== 'bet' && recommendation !== 'lean') return false;
      if (!Array.isArray(fights) || fights.length === 0) return true;
      return fights.some((fight) => projectionSnapshotMatchesFight(row, fight));
    })
    .sort(compareBetScoringRows);

  const max = Math.max(1, Math.min(10, Number(limit) || 5));
  const seen = new Set();
  const output = [];
  for (const row of candidates) {
    const fightKey =
      String(row?.fightId || '').trim() ||
      `${normalise(row?.fighterA || '')}::${normalise(row?.fighterB || '')}`;
    const marketKey = String(row?.marketKey || '').trim().toLowerCase();
    const dedupeKey = `${fightKey}::${marketKey}`;
    if (!fightKey || !marketKey || seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    output.push({
      ...row,
      fightLabel: resolveFightLabelForBetScoring(row, fights),
    });
    if (output.length >= max) break;
  }
  return output;
}

function detectTargetMarketKey(message = '') {
  const text = normalise(message);
  if (!text) return 'moneyline';
  if (/\b(metodo|método|ko|tko|sub|sumision|sumisión|decision|decisión)\b/.test(text)) {
    return 'method';
  }
  if (/\b(over|under|totales|total rounds|rounds|rondas)\b/.test(text)) {
    return 'total_rounds';
  }
  return 'moneyline';
}

function toOddsNumber(value) {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const normalized = raw
    .replace(/[^\d.,-]/g, '')
    .replace(/\.(?=.*\.)/g, '')
    .replace(',', '.');
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed <= 1 || parsed > 30) return null;
  return parsed;
}

function extractOddsCandidatesFromText(message = '') {
  const text = String(message || '');
  if (!text) return [];
  const candidates = [];

  const cueRegex = /(?:@|\bcuota(?:s)?\b|\bodds?\b|\bprice\b)\s*[:=]?\s*([1-9]\d?(?:[.,]\d{1,3})?)/gi;
  for (const match of text.matchAll(cueRegex)) {
    const value = toOddsNumber(match[1]);
    if (!value) continue;
    candidates.push(value);
  }

  if (!candidates.length && hasOddsSignals(text)) {
    const decimalRegex = /\b([1-9]\d?(?:[.,]\d{1,3}))\b/g;
    for (const match of text.matchAll(decimalRegex)) {
      const value = toOddsNumber(match[1]);
      if (!value) continue;
      candidates.push(value);
    }
  }

  return Array.from(new Set(candidates.map((value) => Number(value.toFixed(3)))));
}

function selectionMatchTokens(selection = '') {
  const normalized = normalise(selection);
  if (!normalized) return [];
  const trimmed = normalized.split(/\bpor\b/)[0] || normalized;
  const words = trimmed
    .split(/\s+/)
    .map((word) => word.trim())
    .filter(Boolean)
    .filter((word) => word.length >= 3)
    .filter((word) => !['over', 'under', 'round', 'rounds', 'ml', 'moneyline'].includes(word));
  const unique = Array.from(new Set(words));
  if (/\bover\b/.test(normalized)) unique.push('over');
  if (/\bunder\b/.test(normalized)) unique.push('under');
  return unique;
}

function extractOddsCandidatesFromSnapshot(snapshot = {}, { selection = '', marketKey = '' } = {}) {
  const oddsNode = snapshot?.odds;
  if (!oddsNode || typeof oddsNode !== 'object') return [];

  const rows = [];
  const queue = [oddsNode];
  const visited = new Set();

  while (queue.length) {
    const node = queue.shift();
    if (!node || typeof node !== 'object') continue;
    if (visited.has(node)) continue;
    visited.add(node);

    if (Array.isArray(node)) {
      for (const item of node) {
        if (item && typeof item === 'object') queue.push(item);
      }
      continue;
    }

    const label = String(
      node.selection ||
        node.name ||
        node.outcome ||
        node.outcomeName ||
        node.fighter ||
        node.team ||
        ''
    ).trim();
    const market = String(node.market || node.marketKey || node.type || '').trim().toLowerCase();

    const directPrice = toOddsNumber(
      node.price ?? node.odds ?? node.decimal ?? node.cuota ?? node.value
    );
    if (directPrice) {
      rows.push({ odds: directPrice, label, market });
    }

    const outcomeA = toOddsNumber(node.outcomeAPrice);
    const outcomeB = toOddsNumber(node.outcomeBPrice);
    if (outcomeA && node.outcomeAName) {
      rows.push({ odds: outcomeA, label: String(node.outcomeAName), market });
    }
    if (outcomeB && node.outcomeBName) {
      rows.push({ odds: outcomeB, label: String(node.outcomeBName), market });
    }

    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') {
        queue.push(value);
      }
    }
  }

  if (!rows.length) return [];

  let filtered = rows.slice();
  const key = String(marketKey || '').trim().toLowerCase();
  if (key === 'method') {
    const byMarket = filtered.filter((row) => /method|outcome|result/.test(row.market));
    if (byMarket.length) filtered = byMarket;
  } else if (key === 'total_rounds') {
    const byMarket = filtered.filter((row) => /total|round/.test(row.market) || /\bover\b|\bunder\b/.test(normalise(row.label)));
    if (byMarket.length) filtered = byMarket;
  }

  const tokens = selectionMatchTokens(selection);
  if (tokens.length) {
    const bySelection = filtered.filter((row) => {
      const haystack = `${normalise(row.label)} ${normalise(row.market)}`;
      return tokens.some((token) => haystack.includes(token));
    });
    if (bySelection.length) filtered = bySelection;
  }

  return filtered;
}

function resolveUserOddsForDeterministicAdjustment({
  originalMessage = '',
  oddsSnapshot = null,
  mediaOddsExtraction = null,
  selection = '',
  marketKey = '',
} = {}) {
  const textCandidates = extractOddsCandidatesFromText(originalMessage);
  if (textCandidates.length === 1) {
    return {
      odds: textCandidates[0],
      source: 'mensaje_usuario',
      ambiguous: false,
    };
  }
  if (textCandidates.length > 1) {
    return {
      odds: null,
      source: 'mensaje_usuario',
      ambiguous: true,
      candidates: textCandidates,
    };
  }

  const media = mediaOddsExtraction?.extracted || null;
  if (media && String(marketKey || '').trim().toLowerCase() === 'moneyline') {
    const tokenSource = selectionMatchTokens(selection);
    const fighterATokens = selectionMatchTokens(media.fighterA || '');
    const fighterBTokens = selectionMatchTokens(media.fighterB || '');
    const selectionNorm = normalise(selection);

    const matchesA =
      tokenSource.some((token) => fighterATokens.includes(token)) ||
      (media.fighterA && selectionNorm.includes(normalise(media.fighterA)));
    const matchesB =
      tokenSource.some((token) => fighterBTokens.includes(token)) ||
      (media.fighterB && selectionNorm.includes(normalise(media.fighterB)));

    if (matchesA && Number.isFinite(Number(media.moneylineA))) {
      return {
        odds: Number(media.moneylineA),
        source: 'media_extraida',
        ambiguous: false,
      };
    }
    if (matchesB && Number.isFinite(Number(media.moneylineB))) {
      return {
        odds: Number(media.moneylineB),
        source: 'media_extraida',
        ambiguous: false,
      };
    }
    const mediaCandidates = [toOddsNumber(media.moneylineA), toOddsNumber(media.moneylineB)].filter(
      (value) => Number.isFinite(Number(value))
    );
    if (mediaCandidates.length === 1) {
      return {
        odds: Number(mediaCandidates[0]),
        source: 'media_extraida',
        ambiguous: false,
      };
    }
    if (mediaCandidates.length > 1) {
      return {
        odds: null,
        source: 'media_extraida',
        ambiguous: true,
        candidates: mediaCandidates.map((value) => Number(Number(value).toFixed(3))),
      };
    }
  }

  const snapshotCandidates = extractOddsCandidatesFromSnapshot(oddsSnapshot, {
    selection,
    marketKey,
  });
  if (!snapshotCandidates.length) {
    return {
      odds: null,
      source: null,
      ambiguous: false,
    };
  }

  const distinct = Array.from(
    new Set(snapshotCandidates.map((row) => Number(row.odds).toFixed(3)))
  ).map(Number);
  if (distinct.length === 1) {
    return {
      odds: distinct[0],
      source: 'snapshot_guardado',
      ambiguous: false,
    };
  }
  return {
    odds: null,
    source: 'snapshot_guardado',
    ambiguous: true,
    candidates: distinct,
  };
}

function computeDeterministicAdjustedScoring(baseRow = {}, userOdds = null) {
  const toFinite = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const parseInputs = (row) => {
    const raw = row?.inputs;
    if (!raw) return {};
    if (typeof raw === 'object') return raw;
    if (typeof raw === 'string') {
      try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : {};
      } catch {
        return {};
      }
    }
    return {};
  };
  const applyMarketGuardrails = ({
    recommendation = 'no_bet',
    edgePct = 0,
    confidencePct = 0,
    row = {},
  } = {}) => {
    const baseRecommendation = String(recommendation || 'no_bet').trim().toLowerCase();
    let finalRecommendation = baseRecommendation;
    let forcedNoBetReason = null;
    const notes = [];

    const inputs = parseInputs(row);
    const booksCount = toFinite(row?.booksCount);
    const lineMovementPct = toFinite(inputs?.lineMovementPct);
    const marketAgreementPct = toFinite(inputs?.marketAgreementPct);
    const dataWindowHours = toFinite(inputs?.dataWindowHours);

    if (Number.isFinite(booksCount) && booksCount < 2 && finalRecommendation !== 'no_bet') {
      finalRecommendation = 'no_bet';
      forcedNoBetReason = 'consenso insuficiente (<2 books)';
      notes.push('Consenso insuficiente entre books.');
    }

    if (Number.isFinite(marketAgreementPct)) {
      if (marketAgreementPct < 50 && finalRecommendation !== 'no_bet') {
        finalRecommendation = 'no_bet';
        forcedNoBetReason = forcedNoBetReason || 'mercado sin consenso suficiente';
        notes.push('Dispersion alta entre books.');
      } else if (marketAgreementPct < 62 && finalRecommendation === 'bet') {
        finalRecommendation = 'lean';
        notes.push('Consenso medio-bajo: BET degradado a LEAN.');
      }
    }

    if (Number.isFinite(lineMovementPct)) {
      if (lineMovementPct <= -5) {
        if (finalRecommendation === 'bet') {
          finalRecommendation = 'lean';
          notes.push('Linea fuertemente en contra: BET degradado a LEAN.');
        }
        if (
          finalRecommendation === 'lean' &&
          (Number(edgePct) < 3.5 || Number(confidencePct) < 64)
        ) {
          finalRecommendation = 'no_bet';
          forcedNoBetReason = forcedNoBetReason || 'linea en contra fuerte';
          notes.push('Linea en contra + edge justo: NO_BET.');
        }
      } else if (lineMovementPct <= -3 && finalRecommendation === 'bet') {
        finalRecommendation = 'lean';
        notes.push('Linea en contra moderada: BET degradado a LEAN.');
      }
    }

    if (Number.isFinite(dataWindowHours)) {
      if (dataWindowHours < 0.5 && finalRecommendation === 'bet') {
        finalRecommendation = 'lean';
        notes.push('Ventana de datos corta: BET degradado a LEAN.');
      }
      if (
        dataWindowHours < 0.25 &&
        finalRecommendation === 'lean' &&
        Number(edgePct) < 3
      ) {
        finalRecommendation = 'no_bet';
        forcedNoBetReason = forcedNoBetReason || 'muestra de mercado insuficiente';
        notes.push('Muestra temporal insuficiente para ejecutar.');
      }
    }

    return {
      baseRecommendation,
      finalRecommendation,
      changedRecommendation: finalRecommendation !== baseRecommendation,
      forcedNoBetReason,
      notes,
      signals: {
        booksCount,
        lineMovementPct,
        marketAgreementPct,
        dataWindowHours,
      },
    };
  };

  const odds = toOddsNumber(userOdds);
  if (!odds) return null;

  const baseEdge = Number(baseRow?.edgePct || 0);
  const baseConfidence = Number(baseRow?.confidencePct || 50);
  const impliedBase = Number(baseRow?.impliedProbabilityPct);
  let modelProb = Number(baseRow?.modelProbabilityPct);
  if (!Number.isFinite(modelProb)) {
    modelProb = Number.isFinite(impliedBase) ? impliedBase + baseEdge : NaN;
  }
  if (!Number.isFinite(modelProb)) {
    return null;
  }

  const impliedUser = 100 / odds;
  const adjustedEdge = modelProb - impliedUser;
  const adjustedConfidence = clampNumber(
    baseConfidence + (adjustedEdge - baseEdge) * 0.9,
    35,
    93
  );

  let recommendation = 'no_bet';
  let reason = 'edge insuficiente a cuota actual';
  if (adjustedEdge >= 4 && adjustedConfidence >= 60) {
    recommendation = 'bet';
    reason = null;
  } else if (adjustedEdge >= 1.5 && adjustedConfidence >= 56) {
    recommendation = 'lean';
    reason = null;
  }

  const guardrail = applyMarketGuardrails({
    recommendation,
    edgePct: adjustedEdge,
    confidencePct: adjustedConfidence,
    row: baseRow,
  });
  if (guardrail.changedRecommendation) {
    recommendation = guardrail.finalRecommendation;
    if (recommendation === 'no_bet') {
      reason = guardrail.forcedNoBetReason || reason || 'bloqueo por guardrails de mercado';
    } else {
      reason = null;
    }
  }

  let suggestedStakeUnits = null;
  if (recommendation !== 'no_bet') {
    const baseline = Number(baseRow?.suggestedStakeUnits);
    const growthFactor = 1 + Math.max(-0.45, Math.min(0.8, (adjustedEdge - baseEdge) / 10));
    const raw =
      Number.isFinite(baseline) && baseline > 0
        ? baseline * growthFactor
        : recommendation === 'bet'
        ? 1.2 + adjustedEdge * 0.08
        : 0.75 + adjustedEdge * 0.05;
    const maxByRecommendation = recommendation === 'bet' ? 4.5 : 2.2;
    const maxWithGuardrail =
      guardrail.changedRecommendation && recommendation === 'lean'
        ? Math.min(maxByRecommendation, 1.6)
        : maxByRecommendation;
    suggestedStakeUnits = clampNumber(
      raw,
      recommendation === 'bet' ? 1 : 0.5,
      maxWithGuardrail
    );
  }

  return {
    odds: Number(odds.toFixed(3)),
    modelProbabilityPct: Number(modelProb.toFixed(2)),
    impliedUserProbabilityPct: Number(impliedUser.toFixed(2)),
    edgePct: Number(adjustedEdge.toFixed(2)),
    confidencePct: Number(adjustedConfidence.toFixed(1)),
    recommendation,
    noBetReason: reason,
    suggestedStakeUnits:
      suggestedStakeUnits === null ? null : Number(suggestedStakeUnits.toFixed(2)),
    guardrails: {
      changedRecommendation: guardrail.changedRecommendation,
      baseRecommendation: guardrail.baseRecommendation,
      finalRecommendation: guardrail.finalRecommendation,
      forcedNoBetReason: guardrail.forcedNoBetReason || null,
      notes: guardrail.notes,
      signals: guardrail.signals,
    },
  };
}

function deterministicRecommendationLabel(value = 'no_bet') {
  const key = String(value || '').trim().toLowerCase();
  if (key === 'bet') return '✅ BET';
  if (key === 'lean') return '🟡 LEAN';
  return '⛔ NO_BET';
}

function enforceDeterministicOddsAdjustment({
  reply = '',
  originalMessage = '',
  wantsBetDecision = false,
  resolvedFight = null,
  precomputedFightBetScoring = [],
  oddsSnapshot = null,
  mediaOddsExtraction = null,
} = {}) {
  const text = String(reply || '').trim();
  if (!text) return text;
  if (!wantsBetDecision || isLedgerOperationMessage(originalMessage)) return text;
  if (!isRecommendationReply(text)) return text;
  if (!resolvedFight?.fighterA || !resolvedFight?.fighterB) return text;

  const rows = Array.isArray(precomputedFightBetScoring) ? precomputedFightBetScoring.slice() : [];
  if (!rows.length) return text;

  const requestedMarket = detectTargetMarketKey(originalMessage);
  const marketRows = rows
    .filter((row) => String(row?.marketKey || '').trim().toLowerCase() === requestedMarket)
    .sort(compareBetScoringRows);
  const targetRows = marketRows.length ? marketRows : rows.sort(compareBetScoringRows);
  const target = targetRows[0];
  if (!target) return text;

  const userOdds = resolveUserOddsForDeterministicAdjustment({
    originalMessage,
    oddsSnapshot,
    mediaOddsExtraction,
    selection: target.selection,
    marketKey: target.marketKey,
  });

  if (/\bajuste deterministico\b/i.test(text)) {
    return text;
  }

  const marketLabel = betScoringMarketLabel(target.marketKey);
  const selection = String(target.selection || '').trim() || 'sin seleccion';
  if (!userOdds?.odds) {
    const lines = [
      '🧮 Ajuste deterministico pendiente',
      `- Mercado objetivo: ${marketLabel}`,
      `- Seleccion objetivo: ${selection}`,
      '- Pick final bloqueado hasta validar tu cuota exacta actual en tu bookie.',
      '- Formato sugerido: `Gaethje ML @2.10 en Bet365` o `Over 2.5 rounds @1.95`.',
    ];
    if (userOdds?.ambiguous && Array.isArray(userOdds?.candidates) && userOdds.candidates.length) {
      lines.push(`- Detecte multiples cuotas candidatas: ${userOdds.candidates.join(', ')}.`);
    }
    return `${text}\n\n${lines.join('\n')}`;
  }

  const adjusted = computeDeterministicAdjustedScoring(target, userOdds.odds);
  if (!adjusted) {
    return text;
  }

  const lines = [
    '🧮 Ajuste deterministico (cuota de tu bookie)',
    `- Mercado: ${marketLabel}`,
    `- Seleccion: ${selection}`,
    `- Cuota usuario: @${adjusted.odds.toFixed(2)} (${userOdds.source || 'fuente no definida'})`,
    `- Prob modelo: ${adjusted.modelProbabilityPct.toFixed(1)}% | Prob implícita cuota: ${adjusted.impliedUserProbabilityPct.toFixed(1)}%`,
    `- Edge ajustado: ${adjusted.edgePct >= 0 ? '+' : ''}${adjusted.edgePct.toFixed(2)}%`,
    `- Veredicto final: ${deterministicRecommendationLabel(adjusted.recommendation)}`,
  ];

  const movementPct = Number(adjusted?.guardrails?.signals?.lineMovementPct);
  const agreementPct = Number(adjusted?.guardrails?.signals?.marketAgreementPct);
  const booksCount = Number(adjusted?.guardrails?.signals?.booksCount);
  const hasSignalLine =
    Number.isFinite(movementPct) ||
    Number.isFinite(agreementPct) ||
    Number.isFinite(booksCount);
  if (hasSignalLine) {
    const parts = [];
    if (Number.isFinite(movementPct)) {
      parts.push(
        `line move ${movementPct >= 0 ? '+' : ''}${movementPct.toFixed(2)}%`
      );
    }
    if (Number.isFinite(agreementPct)) {
      parts.push(`consenso ${agreementPct.toFixed(1)}%`);
    }
    if (Number.isFinite(booksCount)) {
      parts.push(`books ${booksCount.toFixed(0)}`);
    }
    lines.push(`- Señales mercado: ${parts.join(' | ')}`);
  }
  if (adjusted?.guardrails?.changedRecommendation) {
    lines.push(
      `- Gate mercado: ${deterministicRecommendationLabel(
        adjusted.guardrails.baseRecommendation
      )} -> ${deterministicRecommendationLabel(adjusted.guardrails.finalRecommendation)}`
    );
    if (Array.isArray(adjusted?.guardrails?.notes) && adjusted.guardrails.notes.length) {
      lines.push(`- Motivo gate: ${adjusted.guardrails.notes.join(' ')}`);
    }
  }

  if (adjusted.recommendation === 'no_bet') {
    lines.push(`- Motivo: ${adjusted.noBetReason || 'sin edge suficiente a precio actual'}.`);
  } else if (Number.isFinite(Number(adjusted.suggestedStakeUnits))) {
    lines.push(`- Stake sugerido: ${formatUnits(adjusted.suggestedStakeUnits)}u (pre-calibración de perfil).`);
  }

  return `${text}\n\n${lines.join('\n')}`;
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

function toNumberFlexible(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  return parseDecimalLike(String(value));
}

function cleanNameChunk(value = '') {
  return String(value || '')
    .replace(/^[^A-Za-zÀ-ÿ0-9]+/, '')
    .replace(/[^A-Za-zÀ-ÿ0-9]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractFightFromText(text = '') {
  const raw = String(text || '').replace(/\n+/g, ' ');
  const match = raw.match(
    /([A-Za-zÀ-ÿ'`.\- ]{2,70})\s+(?:vs\.?|v\.?|versus)\s+([A-Za-zÀ-ÿ'`.\- ]{2,70})/i
  );
  if (!match) return null;
  const fighterA = cleanNameChunk(match[1]);
  const fighterB = cleanNameChunk(match[2]);
  if (!fighterA || !fighterB) return null;
  return { fighterA, fighterB };
}

function extractNameTokens(value = '') {
  return normalizeText(value)
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((token) => token && token.length > 1);
}

function extractLastName(value = '') {
  const tokens = extractNameTokens(value);
  if (!tokens.length) return '';
  return tokens[tokens.length - 1];
}

function levenshteinDistance(a = '', b = '') {
  const left = String(a || '');
  const right = String(b || '');
  if (!left) return right.length;
  if (!right) return left.length;
  if (left === right) return 0;

  const prev = new Array(right.length + 1);
  const curr = new Array(right.length + 1);

  for (let j = 0; j <= right.length; j += 1) {
    prev[j] = j;
  }

  for (let i = 1; i <= left.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= right.length; j += 1) {
      prev[j] = curr[j];
    }
  }

  return prev[right.length];
}

function fuzzyNameScore(left = '', right = '') {
  const a = normalizeText(left).replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const b = normalizeText(right).replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (
    (a.length >= 4 && b.length >= 4 && a.includes(b)) ||
    (a.length >= 4 && b.length >= 4 && b.includes(a))
  ) {
    return 0.92;
  }

  const aLast = extractLastName(a);
  const bLast = extractLastName(b);
  if (aLast && bLast) {
    if (aLast === bLast) return 0.86;
    const lastDistance = levenshteinDistance(aLast, bLast);
    if (lastDistance <= 1 && Math.max(aLast.length, bLast.length) >= 4) {
      return 0.8;
    }
  }

  const distance = levenshteinDistance(a, b);
  const ratio = distance / Math.max(a.length, b.length);
  if (ratio <= 0.18) return 0.78;
  if (ratio <= 0.28) return 0.65;
  return 0;
}

function fightSimilarityScore(queryFight = '', candidateFight = '') {
  const query = extractFightFromText(queryFight) || null;
  const candidate = extractFightFromText(candidateFight) || null;

  if (query && candidate) {
    const direct =
      (fuzzyNameScore(query.fighterA, candidate.fighterA) +
        fuzzyNameScore(query.fighterB, candidate.fighterB)) /
      2;
    const swapped =
      (fuzzyNameScore(query.fighterA, candidate.fighterB) +
        fuzzyNameScore(query.fighterB, candidate.fighterA)) /
      2;
    return Math.max(direct, swapped);
  }

  const q = normalizeText(queryFight).replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const c = normalizeText(candidateFight)
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!q || !c) return 0;
  if (q === c) return 1;
  if ((q.length >= 5 && c.includes(q)) || (c.length >= 5 && q.includes(c))) return 0.85;
  const distance = levenshteinDistance(q, c);
  const ratio = distance / Math.max(q.length, c.length);
  if (ratio <= 0.2) return 0.72;
  return 0;
}

function resolveFuzzyBetSelection({
  queryFight = '',
  queryEventName = '',
  queryPick = '',
  candidates = [],
  minScore = 0.72,
} = {}) {
  const rows = Array.isArray(candidates) ? candidates : [];
  const fightQuery = String(queryFight || '').trim();
  if (!fightQuery || !rows.length) {
    return null;
  }

  const eventNorm = normalizeText(queryEventName || '');
  const pickNorm = normalizeText(queryPick || '');
  const scored = [];

  for (const row of rows) {
    const rowFight = String(row?.fight || '').trim();
    const rowId = Number(row?.id);
    if (!rowFight || !Number.isInteger(rowId) || rowId <= 0) continue;

    let score = fightSimilarityScore(fightQuery, rowFight);
    if (eventNorm) {
      const rowEvent = normalizeText(row?.eventName || '');
      if (rowEvent && rowEvent.includes(eventNorm)) {
        score += 0.05;
      }
    }
    if (pickNorm) {
      const rowPick = normalizeText(row?.pick || '');
      if (rowPick && rowPick.includes(pickNorm)) {
        score += 0.03;
      }
    }

    scored.push({
      id: rowId,
      score,
      fight: rowFight,
      eventName: row?.eventName || null,
    });
  }

  scored.sort((a, b) => b.score - a.score);
  if (!scored.length) return null;

  const best = scored[0];
  if (best.score < minScore) {
    return null;
  }

  const second = scored[1];
  if (second && second.score >= minScore && Math.abs(best.score - second.score) < 0.08) {
    return {
      ambiguous: true,
      candidates: scored.slice(0, 3),
    };
  }

  return {
    ambiguous: false,
    betId: best.id,
    score: Number(best.score.toFixed(3)),
    fight: best.fight,
    eventName: best.eventName,
  };
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

function extractBetIdsFromMessage(message = '') {
  const raw = String(message || '');
  if (!raw.trim()) return [];

  const values = [];
  const patterns = [
    /\b(?:bet[\s_-]?id|id)\s*#?\s*(\d{1,8})\b/gi,
    /#(\d{1,8})\b/g,
  ];

  for (const pattern of patterns) {
    let match = null;
    while ((match = pattern.exec(raw)) !== null) {
      const parsed = Number(match[1]);
      if (Number.isInteger(parsed) && parsed > 0) {
        values.push(parsed);
      }
    }
  }

  const groupedListPattern =
    /\b(?:apuestas?|bets?)\b[^0-9#]{0,20}((?:#?\d{1,8}\s*(?:,|y|e)\s*)+#?\d{1,8})\b/gi;
  let groupedMatch = null;
  while ((groupedMatch = groupedListPattern.exec(raw)) !== null) {
    const chunk = groupedMatch[1] || '';
    const idsInChunk = chunk.match(/\d{1,8}/g) || [];
    for (const rawId of idsInChunk) {
      const parsed = Number(rawId);
      if (Number.isInteger(parsed) && parsed > 0) {
        values.push(parsed);
      }
    }
  }

  return Array.from(new Set(values));
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

function formatConfirmationReason(reason = '') {
  const value = String(reason || '').trim();
  if (value === 'bulk_archive') {
    return 'Archivado masivo detectado.';
  }
  if (value === 'bulk_state_change') {
    return 'Cambio de estado masivo detectado.';
  }
  if (value === 'state_change_without_explicit_bet_id') {
    return 'Cambio de estado sin bet_id explicito.';
  }
  if (value === 'archive_requires_explicit_confirmation') {
    return 'Archivado sin bet_id explicito.';
  }
  return 'Mutacion sensible detectada.';
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

function isLedgerMutationIntentMessage(message = '') {
  const text = normalizeText(message);
  if (!text) return false;
  return /\b(cerr\w*|liquid\w*|settl\w*|anot\w*|registr\w*|archiv\w*|borr\w*|elimin\w*|marc\w*|deshac\w*|undo|revert\w*)\b/.test(
    text
  );
}

function isBulkSettlementReviewRequest(message = '') {
  const text = normalizeText(message);
  if (!text) return false;
  const wantsReview =
    /\b(fijate|revis\w*|verific\w*|cheque\w*|confirm\w*|como salio|como salieron|como termino|como terminaron|resultado)\b/.test(
      text
    );
  const wantsSettle = /\b(cerr\w*|liquid\w*|settl\w*|marc\w*)\b/.test(text);
  const targetsMultiple = /\b(apuestas|pending|pendientes|todas|esas|estas)\b/.test(text);
  return wantsReview && wantsSettle && targetsMultiple;
}

function splitFightLabelForSettlement(label = '') {
  const value = String(label || '').trim();
  if (!value) return null;
  const parts = value.split(/\s+(?:vs\.?|versus|v)\s+/i).map((part) => part.trim());
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return {
    fighterA: parts[0],
    fighterB: parts[1],
  };
}

function collectUniqueFightersFromBets(bets = []) {
  const output = [];
  const seen = new Set();
  for (const bet of Array.isArray(bets) ? bets : []) {
    const parsed = splitFightLabelForSettlement(bet?.fight || '');
    if (!parsed) continue;
    for (const fighterName of [parsed.fighterA, parsed.fighterB]) {
      const key = normalizeText(fighterName);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      output.push(fighterName);
    }
  }
  return output.slice(0, 24);
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

function isValidTimeZone(timezone = '') {
  const candidate = String(timezone || '').trim();
  if (!candidate) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate }).format(new Date());
    return true;
  } catch {
    return false;
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
  const localNow = extractLocalDateTimeParts(new Date(Date.now()), timezone);
  const currentYear = Number(localNow.year) || new Date(Date.now()).getUTCFullYear();

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
  const nowLocal = extractLocalDateTimeParts(new Date(Date.now()), resolvedTimeZone);
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
  return /\b(ledger|bet[\s_-]?id|pending|won|lost|settl\w*|archiv\w*|borr\w*|elimin\w*|cerr\w*|anot\w*|registr\w*|liquid\w*|marc\w*)\b/.test(
    normalized
  );
}

function hasOperationalLedgerToolUsage(turnContext = null) {
  if (!turnContext || typeof turnContext !== 'object') return false;
  return Boolean(
    turnContext.hasOperationalLedgerToolCall ||
      turnContext.hasLedgerCreateReceipt ||
      turnContext.hasLedgerMutationReceipt
  );
}

function pruneExposureClaims(text = '') {
  const lines = String(text || '').split('\n');
  if (!lines.length) return String(text || '').trim();

  const exposurePatterns = [
    /\bpeleas restantes\b/i,
    /\bplan de exposicion\b/i,
    /\bmismo evento donde tenias\b/i,
    /\bpresupuesto objetivo\b/i,
    /\bcomprometido en esta recomendacion\b/i,
    /\bremanente estimado\b/i,
    /\bexposicion maxima\b/i,
  ];

  const filtered = [];
  for (const line of lines) {
    const shouldDrop = exposurePatterns.some((pattern) => pattern.test(line));
    if (!shouldDrop) {
      filtered.push(line);
    }
  }

  const compact = [];
  let previousBlank = false;
  for (const line of filtered) {
    const isBlank = line.trim().length === 0;
    if (isBlank && previousBlank) continue;
    compact.push(line);
    previousBlank = isBlank;
  }

  return compact.join('\n').trim();
}

function normalizeRiskProfile(rawValue = '') {
  const normalized = normalizeText(rawValue);
  if (!normalized) return null;
  if (/\b(conservador|conservadora|bajo|baja|prudente|low)\b/.test(normalized)) {
    return 'conservador';
  }
  if (/\b(moderado|moderada|medio|media|balanced)\b/.test(normalized)) {
    return 'moderado';
  }
  if (/\b(agresivo|agresiva|alto|alta|high)\b/.test(normalized)) {
    return 'agresivo';
  }
  return null;
}

function parseProfilePreferenceMessage(message = '') {
  const raw = String(message || '').trim();
  if (!raw) return null;
  const text = normalizeText(raw);

  const updates = {};
  const warnings = [];

  const bankrollMatch = raw.match(
    /\b(?:bankroll|banca|bank)\b[^0-9$]{0,20}\$?\s*([0-9][0-9\.,]*)/i
  );
  const unitMatch = raw.match(
    /\b(?:unidad(?:es)?|unit(?: size)?)\b[^0-9$]{0,20}\$?\s*([0-9][0-9\.,]*)/i
  );
  const riskMatch = raw.match(
    /\b(?:riesgo|risk(?: profile)?|perfil(?: de riesgo)?)\b[^a-zA-Z]{0,20}(conservador(?:a)?|moderad[oa]|agresiv[oa]|baj[oa]|medi[oa]|alt[oa])\b/i
  );
  const timezoneMatch = raw.match(
    /\b(?:timezone|tz|zona horaria)\b[^A-Za-z0-9/_+\-]{0,20}([A-Za-z][A-Za-z0-9_+\-]*(?:\/[A-Za-z0-9_+\-]+)+)\b/
  );
  const utilizationMatch = raw.match(
    /\b(?:utilizacion(?: objetivo)?(?: del evento)?|exposicion(?: objetivo)?(?: del evento)?|target(?: event)? utilization)\b[^0-9]{0,20}([0-9]+(?:[.,][0-9]+)?)\s*%?/i
  );

  if (bankrollMatch) {
    const parsed = parseDecimalLike(bankrollMatch[1]);
    if (Number.isFinite(parsed) && parsed > 0) {
      updates.bankroll = parsed;
    }
  }

  if (unitMatch) {
    const parsed = parseDecimalLike(unitMatch[1]);
    if (Number.isFinite(parsed) && parsed > 0) {
      updates.unitSize = parsed;
    }
  }

  if (riskMatch) {
    const normalizedRisk = normalizeRiskProfile(riskMatch[1]);
    if (normalizedRisk) {
      updates.riskProfile = normalizedRisk;
    }
  }

  if (timezoneMatch) {
    const timezone = String(timezoneMatch[1] || '').trim();
    if (isValidTimeZone(timezone)) {
      updates.timezone = timezone;
    } else {
      warnings.push(
        'No pude validar ese timezone. Usa formato IANA, por ejemplo: America/Argentina/Buenos_Aires.'
      );
    }
  }

  if (utilizationMatch) {
    const parsed = parseDecimalLike(utilizationMatch[1]);
    if (Number.isFinite(parsed) && parsed > 0 && parsed <= 100) {
      updates.targetEventUtilizationPct = parsed;
    } else {
      warnings.push('La utilizacion objetivo debe estar entre 0 y 100%.');
    }
  }

  const touchedAny =
    /\b(bankroll|banca|unidad|unit|riesgo|risk|perfil|timezone|tz|zona horaria|utilizacion|exposicion)\b/.test(
      text
    );
  if (!Object.keys(updates).length && !warnings.length && !touchedAny) {
    return null;
  }

  return {
    updates,
    warnings,
    touchedAny,
  };
}

function isProfileSummaryRequest(message = '') {
  const text = normalizeText(message);
  if (!text) return false;
  return /\b(mi config|mi configuracion|ver config|mostrar config|mostrame mi configuracion|mis ajustes|settings|perfil de usuario)\b/.test(
    text
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

function formatAmountWithCurrency(amount, currency = 'ARS') {
  const value = Number(amount);
  if (!Number.isFinite(value)) {
    return 'N/D';
  }
  const rounded = Math.round(value);
  const formatted = new Intl.NumberFormat('es-AR').format(rounded);
  const symbol = '$';
  return `${symbol}${formatted} ${String(currency || 'ARS').toUpperCase()}`;
}

function formatSignedCredits(value) {
  const amount = Number(value) || 0;
  const sign = amount >= 0 ? '+' : '-';
  return `${sign}${Math.abs(amount).toFixed(2)}`;
}

function formatIsoForUser(isoValue = '', timezone = DEFAULT_USER_TIMEZONE) {
  const parsed = new Date(String(isoValue || ''));
  if (!Number.isFinite(parsed.getTime())) return String(isoValue || 'N/D');
  try {
    return new Intl.DateTimeFormat('es-AR', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(parsed);
  } catch {
    return parsed.toISOString();
  }
}

function formatProfileSummary(profile = {}) {
  const safeProfile = profile || {};
  const timezone = safeProfile.timezone || DEFAULT_USER_TIMEZONE;
  const unitSize = toNumberOrNull(safeProfile.unitSize);
  const bankroll = toNumberOrNull(safeProfile.bankroll);
  const stakeConfig = getStakeCalibrationConfig(safeProfile);

  const lines = [
    '⚙️ Config actual',
    `- Bankroll: ${bankroll ? formatAmountWithCurrency(bankroll, stakeConfig.currency) : 'No definido'}`,
    `- Unidad: ${unitSize ? formatAmountWithCurrency(unitSize, stakeConfig.currency) : 'No definida'}`,
    `- Riesgo: ${stakeConfig.riskProfile}`,
    `- Timezone: ${timezone}`,
    `- Stake minimo: ${formatUnits(stakeConfig.minUnitsPerBet)}u / ${formatAmountWithCurrency(
      stakeConfig.minStakeAmount,
      stakeConfig.currency
    )}`,
    `- Utilizacion objetivo evento: ${formatUnits(stakeConfig.targetEventUtilizationPct)}%`,
    `- Exposicion maxima por pick: ${formatUnits(stakeConfig.maxPerPickExposurePct)}% del evento`,
  ];

  lines.push(
    '',
    'Si queres cambiar algo: `unidad 600`, `riesgo moderado`, `bankroll 120000`, `timezone America/Argentina/Buenos_Aires`.'
  );

  return lines.join('\n');
}

function resolveRiskBucket(rawRisk = '') {
  return normalizeRiskProfile(rawRisk) || 'moderado';
}

function getDefaultEventUtilizationPct(riskProfile = 'moderado') {
  if (riskProfile === 'conservador') return STAKE_EVENT_UTILIZATION_CONSERVADOR;
  if (riskProfile === 'agresivo') return STAKE_EVENT_UTILIZATION_AGRESIVO;
  return STAKE_EVENT_UTILIZATION_MODERADO;
}

function getMaxPerPickExposurePct(riskProfile = 'moderado') {
  if (riskProfile === 'conservador') return STAKE_MAX_PICK_EXPOSURE_CONSERVADOR;
  if (riskProfile === 'agresivo') return STAKE_MAX_PICK_EXPOSURE_AGRESIVO;
  return STAKE_MAX_PICK_EXPOSURE_MODERADO;
}

function getStakeCalibrationConfig(userProfile = {}) {
  const minStakeAmount = toNumberOrNull(userProfile?.minStakeAmount) ?? STAKE_MIN_AMOUNT_DEFAULT;
  const minUnitsPerBet = toNumberOrNull(userProfile?.minUnitsPerBet) ?? STAKE_MIN_UNITS_DEFAULT;
  const unitSize = toNumberOrNull(userProfile?.unitSize);
  const bankroll = toNumberOrNull(userProfile?.bankroll);
  const riskProfile = resolveRiskBucket(userProfile?.riskProfile);
  const currency = String(userProfile?.currency || 'ARS').toUpperCase();

  const configuredUtil = toNumberOrNull(userProfile?.targetEventUtilizationPct);
  const defaultUtil = getDefaultEventUtilizationPct(riskProfile);
  const targetEventUtilizationPct =
    configuredUtil && configuredUtil > 0 && configuredUtil <= 100
      ? configuredUtil
      : defaultUtil;

  const maxPerPickExposurePct = getMaxPerPickExposurePct(riskProfile);
  const eventBudget =
    Number.isFinite(bankroll) && bankroll > 0 && targetEventUtilizationPct > 0
      ? (bankroll * targetEventUtilizationPct) / 100
      : null;
  const maxPerPickAmount =
    Number.isFinite(eventBudget) && eventBudget > 0 && maxPerPickExposurePct > 0
      ? (eventBudget * maxPerPickExposurePct) / 100
      : null;
  const maxPerPickUnits =
    Number.isFinite(maxPerPickAmount) && Number.isFinite(unitSize) && unitSize > 0
      ? maxPerPickAmount / unitSize
      : null;

  let floorAmount = minStakeAmount;
  let floorUnits = minUnitsPerBet;
  if (unitSize && unitSize > 0) {
    floorAmount = Math.max(minStakeAmount, minUnitsPerBet * unitSize);
    floorUnits = Math.max(minUnitsPerBet, minStakeAmount / unitSize);
  }

  return {
    unitSize,
    bankroll,
    riskProfile,
    currency,
    minStakeAmount,
    minUnitsPerBet,
    floorAmount,
    floorUnits,
    targetEventUtilizationPct,
    maxPerPickExposurePct,
    eventBudget,
    maxPerPickAmount,
    maxPerPickUnits,
  };
}

function parseStakeNumbersFromLine(line = '', unitSize = null) {
  const text = String(line || '');
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

  return {
    unitsMatch,
    amountMatch,
    parsedUnits,
    parsedAmount,
    inferredUnits,
    inferredAmount,
  };
}

function extractStakeAmountsFromLines(lines = [], { unitSize = null } = {}) {
  if (!Array.isArray(lines) || !lines.length) return 0;
  let total = 0;
  for (const line of lines) {
    const text = String(line || '');
    if (!/stake/i.test(text)) continue;
    const parsed = parseStakeNumbersFromLine(text, unitSize);
    const amount = Number(parsed.inferredAmount);
    if (Number.isFinite(amount) && amount > 0) {
      total += amount;
    }
  }
  return total;
}

function buildStakingBudgetSummaryLines(config = {}, totalStakeAmount = 0) {
  if (!Number.isFinite(totalStakeAmount) || totalStakeAmount <= 0) {
    return [];
  }
  if (!Number.isFinite(config.eventBudget) || config.eventBudget <= 0) {
    return [];
  }

  const remaining = config.eventBudget - totalStakeAmount;
  const budgetLabel = formatAmountWithCurrency(config.eventBudget, config.currency);
  const committedLabel = formatAmountWithCurrency(totalStakeAmount, config.currency);
  const remainingLabel = formatAmountWithCurrency(Math.abs(remaining), config.currency);

  const lines = [
    `Plan de evento: presupuesto objetivo ${budgetLabel} (${formatUnits(
      config.targetEventUtilizationPct
    )}% del bankroll).`,
  ];
  if (remaining >= 0) {
    lines.push(
      `Comprometido en esta recomendacion: ${committedLabel} | Remanente estimado: ${remainingLabel}.`
    );
  } else {
    lines.push(
      `Comprometido en esta recomendacion: ${committedLabel} | Exceso sobre objetivo: ${remainingLabel}.`
    );
  }
  return lines;
}

function calibrateStakeLine(line = '', config = {}) {
  const text = String(line || '');
  if (!/stake/i.test(text)) {
    return {
      line: text,
      changed: false,
      adjustedByFloor: false,
      adjustedByCap: false,
      conflict: null,
    };
  }

  const { floorAmount, floorUnits, unitSize, maxPerPickAmount, maxPerPickUnits } = config;
  if (
    !Number.isFinite(floorAmount) &&
    !Number.isFinite(floorUnits) &&
    !Number.isFinite(maxPerPickAmount) &&
    !Number.isFinite(maxPerPickUnits)
  ) {
    return {
      line: text,
      changed: false,
      adjustedByFloor: false,
      adjustedByCap: false,
      conflict: null,
    };
  }

  const parsed = parseStakeNumbersFromLine(text, unitSize);
  const { unitsMatch, amountMatch, parsedUnits, parsedAmount } = parsed;
  let { inferredUnits, inferredAmount } = parsed;

  if (inferredUnits === null && inferredAmount === null) {
    return {
      line: text,
      changed: false,
      adjustedByFloor: false,
      adjustedByCap: false,
      conflict: null,
    };
  }

  const floorExceedsCapByAmount =
    Number.isFinite(floorAmount) &&
    Number.isFinite(maxPerPickAmount) &&
    floorAmount > maxPerPickAmount + 1e-9;
  const floorExceedsCapByUnits =
    Number.isFinite(floorUnits) &&
    Number.isFinite(maxPerPickUnits) &&
    floorUnits > maxPerPickUnits + 1e-9;
  if (floorExceedsCapByAmount || floorExceedsCapByUnits) {
    return {
      line: text,
      changed: false,
      adjustedByFloor: false,
      adjustedByCap: false,
      conflict: 'floor_exceeds_exposure_cap',
    };
  }

  let targetUnits = inferredUnits ?? floorUnits;
  let targetAmount = inferredAmount ?? floorAmount;
  let adjustedByFloor = false;
  let adjustedByCap = false;

  if (
    Number.isFinite(floorUnits) &&
    (!Number.isFinite(targetUnits) || targetUnits + 1e-9 < floorUnits)
  ) {
    targetUnits = floorUnits;
    adjustedByFloor = true;
  }
  if (
    Number.isFinite(floorAmount) &&
    (!Number.isFinite(targetAmount) || targetAmount + 1e-9 < floorAmount)
  ) {
    targetAmount = floorAmount;
    adjustedByFloor = true;
  }

  if (unitSize && Number.isFinite(targetUnits)) {
    const amountFromUnits = targetUnits * unitSize;
    if (!Number.isFinite(targetAmount) || targetAmount + 1e-9 < amountFromUnits) {
      targetAmount = amountFromUnits;
      adjustedByFloor = true;
    }
  }
  if (unitSize && Number.isFinite(targetAmount)) {
    const unitsFromAmount = targetAmount / unitSize;
    if (!Number.isFinite(targetUnits) || targetUnits + 1e-9 < unitsFromAmount) {
      targetUnits = unitsFromAmount;
      adjustedByFloor = true;
    }
  }

  if (
    Number.isFinite(maxPerPickAmount) &&
    Number.isFinite(targetAmount) &&
    targetAmount > maxPerPickAmount + 1e-9
  ) {
    targetAmount = maxPerPickAmount;
    adjustedByCap = true;
  }
  if (unitSize && Number.isFinite(targetAmount)) {
    targetUnits = targetAmount / unitSize;
  }
  if (
    Number.isFinite(maxPerPickUnits) &&
    Number.isFinite(targetUnits) &&
    targetUnits > maxPerPickUnits + 1e-9
  ) {
    targetUnits = maxPerPickUnits;
    adjustedByCap = true;
  }
  if (unitSize && Number.isFinite(targetUnits)) {
    targetAmount = targetUnits * unitSize;
  }

  const needsAdjustByUnits =
    (parsedUnits !== null && Number.isFinite(targetUnits) && Math.abs(parsedUnits - targetUnits) > 1e-9) ||
    (parsedUnits === null && Number.isFinite(targetUnits));
  const needsAdjustByAmount =
    (parsedAmount !== null &&
      Number.isFinite(targetAmount) &&
      Math.abs(parsedAmount - targetAmount) > 1e-9) ||
    (parsedAmount === null && Number.isFinite(targetAmount));
  const needsAdjust = needsAdjustByUnits || needsAdjustByAmount;

  if (!needsAdjust) {
    return {
      line: text,
      changed: false,
      adjustedByFloor: false,
      adjustedByCap: false,
      conflict: null,
    };
  }

  let updated = text;
  if (unitsMatch) {
    const formattedUnits = `${formatUnits(targetUnits)}u`;
    updated = updated.replace(unitsMatch[0], formattedUnits);
  } else if (Number.isFinite(targetUnits)) {
    updated = `${updated} (${formatUnits(targetUnits)}u)`;
  }

  if (amountMatch) {
    updated = updated.replace(amountMatch[0], formatAmountWithCurrency(targetAmount, config.currency));
  } else if (Number.isFinite(targetAmount)) {
    updated = `${updated} (=${formatAmountWithCurrency(targetAmount, config.currency)})`;
  }

  return {
    line: updated,
    changed: true,
    adjustedByFloor,
    adjustedByCap,
    conflict: null,
  };
}

function enforceStakeCalibration(reply = '', originalMessage = '', userProfile = {}, turnContext = null) {
  const text = String(reply || '').trim();
  if (!text) return text;

  const userMessage = String(originalMessage || '');
  const looksLikeDecisionTurn =
    hasBetDecisionSignals(userMessage) || hasOddsSignals(userMessage) || /\b(stake|cuota|pick)\b/i.test(userMessage);
  const isOperationalLedgerTurn =
    isLedgerOperationMessage(userMessage) || hasOperationalLedgerToolUsage(turnContext);
  if (!looksLikeDecisionTurn || isOperationalLedgerTurn) {
    return text;
  }

  const config = getStakeCalibrationConfig(userProfile || {});
  const lines = text.split('\n');
  let changed = false;
  let adjustedByFloor = false;
  let adjustedByCap = false;
  let hasExposureConflict = false;
  const updatedLines = lines.map((line) => {
    const next = calibrateStakeLine(line, config);
    if (next.changed) changed = true;
    if (next.adjustedByFloor) adjustedByFloor = true;
    if (next.adjustedByCap) adjustedByCap = true;
    if (next.conflict === 'floor_exceeds_exposure_cap') hasExposureConflict = true;
    return next.line;
  });

  if (hasExposureConflict) {
    const noBetLines = [
      text,
      '',
      '⛔ Control de staking: NO_BET sugerido.',
      '- Motivo: tu piso de stake supera la exposicion maxima por pick para tu presupuesto actual.',
    ];
    if (Number.isFinite(config.eventBudget) && config.eventBudget > 0) {
      noBetLines.push(
        `- Presupuesto objetivo evento: ${formatAmountWithCurrency(config.eventBudget, config.currency)} (${formatUnits(
          config.targetEventUtilizationPct
        )}% del bankroll).`
      );
    }
    if (Number.isFinite(config.maxPerPickAmount) && config.maxPerPickAmount > 0) {
      noBetLines.push(
        `- Maximo por pick (riesgo ${config.riskProfile}): ${formatAmountWithCurrency(
          config.maxPerPickAmount,
          config.currency
        )} (${formatUnits(config.maxPerPickExposurePct)}% del evento).`
      );
    }
    noBetLines.push(
      `- Piso configurado: ${formatUnits(config.floorUnits)}u / ${formatAmountWithCurrency(
        config.floorAmount,
        config.currency
      )}.`,
      '- Ajusta perfil (stake minimo, bankroll o utilizacion) y recalculo.'
    );
    return noBetLines.join('\n');
  }

  const resultLines = changed ? updatedLines : lines.slice();
  const totalStakeAmount = extractStakeAmountsFromLines(changed ? updatedLines : lines, {
    unitSize: config.unitSize,
  });

  if (changed) {
    let note = '';
    if (adjustedByFloor && adjustedByCap) {
      note = `Nota de staking: ajuste por piso configurado y techo de exposicion (${formatUnits(
        config.maxPerPickExposurePct
      )}% por pick).`;
    } else if (adjustedByFloor) {
      note = `Nota de staking: ajuste al piso configurado (${formatUnits(
        config.minUnitsPerBet
      )}u / ${formatAmountWithCurrency(config.minStakeAmount, config.currency)}).`;
    } else if (adjustedByCap) {
      note = `Nota de staking: limite por exposicion maxima por pick (${formatUnits(
        config.maxPerPickExposurePct
      )}% del presupuesto del evento).`;
    }
    if (note) {
      resultLines.push('', note);
    }
  }

  const budgetLines = buildStakingBudgetSummaryLines(config, totalStakeAmount);
  if (budgetLines.length) {
    resultLines.push('', ...budgetLines);
  }

  if (!changed && !budgetLines.length) {
    return text;
  }
  return resultLines.join('\n');
}

function enforceRationaleSection(reply = '', originalMessage = '', turnContext = null) {
  const text = String(reply || '').trim();
  const userMessage = String(originalMessage || '');
  const explicitRationaleRequest = /\b(fundament|explica|por que)\b/.test(
    normalizeText(userMessage)
  );
  const looksLikeDecisionTurn =
    hasBetDecisionSignals(userMessage) || hasOddsSignals(userMessage) || explicitRationaleRequest;
  const isOperationalLedgerTurn =
    isLedgerOperationMessage(userMessage) || hasOperationalLedgerToolUsage(turnContext);

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

function enforceDecisionQualityGate(reply = '', originalMessage = '', turnContext = null) {
  const text = String(reply || '').trim();
  if (!text) return text;
  if (/\bajuste deterministico\b/i.test(text)) return text;

  const userMessage = String(originalMessage || '');
  const isOperationalLedgerTurn =
    isLedgerOperationMessage(userMessage) || hasOperationalLedgerToolUsage(turnContext);
  if (isOperationalLedgerTurn) {
    return text;
  }

  const looksLikeDecisionTurn =
    hasBetDecisionSignals(userMessage) ||
    hasOddsSignals(userMessage) ||
    /\b(pick|stake|apuesta|recomendacion)\b/i.test(text);
  if (!looksLikeDecisionTurn || !isRecommendationReply(text)) {
    return text;
  }

  const userHasOdds = hasConcreteOddsContext(userMessage);
  const replyHasOdds = hasConcreteOddsContext(text);
  if (userHasOdds || replyHasOdds) {
    return text;
  }

  if (/\bcontrol de calidad\b/i.test(text) && /\bno-bet\b/i.test(text)) {
    return text;
  }

  return `${text}\n\n⚠️ Control de calidad: pick condicional (NO_BET por ahora).\n- Falta contexto de cuotas reales de tu bookie para validar edge y entry.\n- Para volverlo ejecutable: pasame screenshot/quotes completos (mercado + cuota actual).`;
}

function enforceLedgerExposureContext(
  reply = '',
  { turnContext = null, userStore = null, userId = null } = {}
) {
  const text = String(reply || '').trim();
  if (!text) return text;
  if (!turnContext?.hasLedgerCreateReceipt) return text;

  if (!userId || typeof userStore?.listUserBets !== 'function') {
    return pruneExposureClaims(text);
  }

  const pendingBets = userStore.listUserBets(userId, {
    status: 'pending',
    includeArchived: false,
    limit: 120,
  });
  const pendingCount = Array.isArray(pendingBets) ? pendingBets.length : 0;

  if (pendingCount <= 1) {
    return pruneExposureClaims(text);
  }
  return text;
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

function hasRecencyClaimContent(text = '') {
  const normalized = normalizeText(text);
  if (!normalized) return false;
  return /\b(racha|viene de|venia de|ultim[oa]s?\s+\d+|gano\s+\d+\s+de\s+(sus\s+)?ultim[oa]s?|perdio\s+\d+\s+de\s+(sus\s+)?ultim[oa]s?)\b/.test(
    normalized
  );
}

function extractMaxRecentClaimCount(text = '') {
  const normalized = normalizeText(text);
  if (!normalized) return null;

  let max = null;
  const patterns = [
    /\bultim[oa]s?\s+(\d{1,2})\b/g,
    /\b(\d{1,2})\s+de\s+(?:sus\s+)?ultim[oa]s?\b/g,
    /\bracha\s+de\s+(\d{1,2})\b/g,
  ];
  for (const pattern of patterns) {
    for (const match of normalized.matchAll(pattern)) {
      const value = Number(match[1]);
      if (!Number.isFinite(value) || value <= 0) continue;
      if (max === null || value > max) {
        max = value;
      }
    }
  }

  return max;
}

function hasUncertaintyDisclosure(text = '') {
  const normalized = normalizeText(text);
  if (!normalized) return false;
  return /\b(no puedo|no tengo|no logre|sin evidencia|incertidumbre|por confirmar|falta verificar|no sostengo)\b/.test(
    normalized
  );
}

function stripRecencyClaimLines(text = '') {
  const lines = String(text || '').split('\n');
  const kept = lines.filter((line) => !hasRecencyClaimContent(line));
  return {
    text: kept.join('\n').trim(),
    removedLines: Math.max(0, lines.length - kept.length),
  };
}

function hasRelativeTemporalWords(text = '') {
  const normalized = normalizeText(text);
  if (!normalized) return false;
  return /\b(hoy|manana|ayer|ahora|en vivo|proxim[oa])\b/.test(normalized);
}

function hasVerificationIntentLanguage(text = '') {
  const normalized = normalizeText(text);
  if (!normalized) return false;
  return /\b(verific|cheque|revis|corrobor|confirm|rectific|corregir)\b/.test(normalized);
}

function hasFactContradictionSignals(message = '') {
  const normalized = normalizeText(message);
  if (!normalized) return false;
  const correctionSignals =
    /\b(eso no|no es asi|incorrect|equivoc|error|te confund|falso|en realidad|te corrijo|corrijo|correccion|no viene de|no fueron|no son)\b/.test(
      normalized
    );
  if (!correctionSignals) return false;

  const factualSignals =
    /\b(racha|ultim|viene de|record|historial|fecha|evento|pelea|gano|perdio|victoria|derrota|forma)\b/.test(
      normalized
    );
  return factualSignals;
}

function formatTemporalAnchorLine(temporalContext = null) {
  const asOf = temporalContext?.nowLocal?.dateIso || new Date().toISOString().slice(0, 10);
  const prev = shiftIsoDate(asOf, -1) || 'N/D';
  const next = shiftIsoDate(asOf, 1) || 'N/D';
  const tz = temporalContext?.timezone || DEFAULT_USER_TIMEZONE;
  return `Referencia temporal: hoy=${asOf}, ayer=${prev}, manana=${next} (${tz}).`;
}

function enforceFactFreshnessGate(
  reply = '',
  { originalMessage = '', temporalContext = null, turnContext = null, citations = [] } = {}
) {
  const text = String(reply || '').trim();
  if (!text) return text;

  const userMessage = String(originalMessage || '');
  const isOperationalLedgerTurn =
    isLedgerOperationMessage(userMessage) || hasOperationalLedgerToolUsage(turnContext);
  if (isOperationalLedgerTurn) return text;
  if (!hasRecencyClaimContent(text)) return text;
  if (hasUncertaintyDisclosure(text)) return text;

  const claimCount = extractMaxRecentClaimCount(text);
  const historyRows = Number(turnContext?.historyRowCount) || 0;
  const hasEnoughRows = !claimCount || historyRows >= claimCount;

  const asOf = temporalContext?.nowLocal?.dateIso || new Date().toISOString().slice(0, 10);
  const latestFightDate = toIsoDateSafe(turnContext?.historyLatestFightDate || '');
  const ageDaysRaw = latestFightDate ? dateDiffInDays(asOf, latestFightDate) : null;
  const ageDays = Number.isFinite(ageDaysRaw) ? Math.max(0, ageDaysRaw) : null;
  const hasFreshHistoryEvidence =
    Boolean(latestFightDate) && Number.isFinite(ageDays) && ageDays <= FACT_FRESHNESS_MAX_AGE_DAYS;
  const hasFreshWebEvidence =
    Boolean(turnContext?.usedWebSearch) &&
    (Array.isArray(citations) ? citations.length > 0 : true);

  if ((hasFreshHistoryEvidence || hasFreshWebEvidence) && hasEnoughRows) {
    return text;
  }

  const stripped = stripRecencyClaimLines(text);
  const lines = [];
  if (stripped.text) {
    lines.push(stripped.text, '');
  }
  lines.push(
    '⚠️ Verificacion factual pendiente: no tengo evidencia temporal valida para sostener claims de racha/ultimos N en este turno.'
  );
  if (latestFightDate) {
    lines.push(
      Number.isFinite(ageDays)
        ? `- Ultimo registro historico detectado: ${latestFightDate} (${ageDays} dia(s) de antiguedad).`
        : `- Ultimo registro historico detectado: ${latestFightDate}.`
    );
  } else {
    lines.push('- No tengo fecha de historial verificable en este turno.');
  }
  if (claimCount && !hasEnoughRows) {
    lines.push(
      `- El claim requiere al menos ${claimCount} pelea(s) recientes y solo hay ${historyRows} fila(s) verificables.`
    );
  }
  lines.push(
    '- Si queres, lo verifico ahora y te devuelvo la version corregida con fecha absoluta.'
  );
  return lines.join('\n').trim();
}

function enforceContradictionHandler(
  reply = '',
  { originalMessage = '', temporalContext = null, turnContext = null } = {}
) {
  const text = String(reply || '').trim();
  if (!text) return text;
  if (!hasFactContradictionSignals(originalMessage)) return text;
  if (hasLedgerSignals(originalMessage)) return text;

  const isOperationalLedgerTurn =
    isLedgerOperationMessage(originalMessage) || hasOperationalLedgerToolUsage(turnContext);
  if (isOperationalLedgerTurn) return text;
  if (hasVerificationIntentLanguage(text)) return text;

  return [
    '⚠️ Recibido: detecto una posible contradiccion factica en ese dato.',
    'No voy a sostener el claim sin verificacion adicional.',
    formatTemporalAnchorLine(temporalContext),
    'Si queres, hago un chequeo puntual ahora y te paso la version corregida.',
  ].join('\n');
}

function enforceResponseConsistencyValidator(
  reply = '',
  { originalMessage = '', temporalContext = null, turnContext = null } = {}
) {
  const text = String(reply || '').trim();
  if (!text) return text;

  const isOperationalLedgerTurn =
    isLedgerOperationMessage(originalMessage) || hasOperationalLedgerToolUsage(turnContext);
  if (isOperationalLedgerTurn) return text;
  if (/referencia temporal/i.test(text)) return text;

  const needsTemporalAnchor =
    isCalendarQuestion(originalMessage) || hasRelativeTemporalWords(text);
  if (!needsTemporalAnchor) return text;
  if (containsAbsoluteDate(text)) return text;

  return `${text}\n\n${formatTemporalAnchorLine(temporalContext)}`;
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
    pickCommitteeEnabled: PICK_COMMITTEE_ENABLED,
    pickCommitteeModel: PICK_COMMITTEE_MODEL || null,
    pickCommitteeMinEdgePct: PICK_COMMITTEE_MIN_EDGE_PCT,
    pickCommitteeMinConfidence: PICK_COMMITTEE_MIN_CONFIDENCE,
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
    'Si el usuario pide "analizar pelea" o "sin cuotas", no pidas odds: entrega lectura tecnica, escenarios probables, riesgos y lean cualitativo.',
    'Cuando haya cuotas guardadas relevantes, usalas automaticamente sin pedirle al usuario que las reenvie.',
    'Si el usuario pregunta por su ledger/balance/apuestas previas, usa get_user_profile para responder con su historial y resumen.',
    'Para listar apuestas existentes y resolver referencias ambiguas, usa list_user_bets.',
    'Para cambiar estado de apuestas existentes (WON/LOST/PENDING) o borrar/archivar, usa mutate_user_bets, nunca record_user_bet.',
    'Si el usuario pide varias mutaciones de ledger juntas, usa mutate_user_bets con steps[] y transactionPolicy=all_or_nothing.',
    'record_user_bet solo se usa para ALTA de apuesta nueva y exige campos minimos completos: fight, pick, odds y stake.',
    'Si la referencia de pelea es ambigua (esa/anterior/recien), no ejecutes mutaciones: pedi desambiguacion con bet_id.',
    'Si el target de mutacion es inequivoco (bet_id explicito o selector unico), ejecuta directo sin pedir confirmacion extra.',
    'Si mutate_user_bets responde requiresConfirmation=true, pedile confirmacion explicita al usuario y luego ejecuta con confirm=true + confirmationToken.',
    'Nunca confirmes una mutacion de ledger sin mostrar receipt (bet_id y nuevo estado).',
    'Si el usuario pide corregir/revertir, usa undo_last_mutation para deshacer la ultima mutacion sensible.',
    'Usa la memoria conversacional para referencias como pelea 1, esa pelea, bankroll y apuestas previas.',
    'No muestres tablas crudas de muchas filas salvo pedido explicito; sintetiza hallazgos relevantes.',
    'Si actualizas o detectas datos de perfil del usuario, persiste con update_user_profile.',
    'Cuando sugieras stake, respeta min_stake_amount y min_units_per_bet del perfil; si el edge no justifica ese piso, propone NO_BET en lugar de stake simbolico.',
    'Si el usuario provee cuotas/odds de una sola pelea (texto o imagen), responde con formato estructurado: intro breve, separador, encabezado de pelea + cuotas recibidas, separador, "Lectura de la pelea" con bullets claros, separador, "Mi probabilidad estimada", separador, "EV (valor esperado)" con picks y EV, separador, "RECOMENDACIONES" (pick principal / valor / agresivo) con stake en unidades si hay unit_size, separador, "Que NO jugaria", separador, "Resumen rapido".',
    'Si el usuario provee cuotas de varias peleas, aplica el mismo formato por pelea (secciones repetidas) y al final agrega un "Resumen global" con los picks principales ordenados por solidez.',
    'Si recibis PRECOMPUTED_BET_SCORING, usalo como base primaria de edge/confianza/stake y solo ajusta por cuotas actuales del usuario.',
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
  const latestRowFightDate = rows.reduce((latest, row) => {
    const isoDate = parseHistoryDateCellToIso(Array.isArray(row) ? row[0] : '');
    if (!isoDate) return latest;
    if (!latest) return isoDate;
    return dateDiffInDays(isoDate, latest) > 0 ? isoDate : latest;
  }, null);
  const cacheLatestFightDate = toIsoDateSafe(cacheStatus?.latestFightDate || '');
  const latestFightDate = pickLatestIsoDate(latestRowFightDate, cacheLatestFightDate);
  const sheetAgeDays = Number.isFinite(Number(cacheStatus?.sheetAgeDays))
    ? Number(cacheStatus.sheetAgeDays)
    : null;

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
    latestFightDate,
    latestFightDateFromRows: latestRowFightDate,
    latestFightDateFromCache: cacheLatestFightDate,
    sheetAgeDays,
    potentialGap: cacheStatus?.potentialGap === true,
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

function hasImageInputItems(inputItems = []) {
  if (!Array.isArray(inputItems) || !inputItems.length) return false;
  return inputItems.some((item) => item?.type === 'input_image' || item?.type === 'input_file');
}

function missingRequiredRecordFields(record = {}) {
  const missing = [];
  if (!String(record?.fight || '').trim()) missing.push('fight');
  if (!String(record?.pick || '').trim()) missing.push('pick');
  if (toNumberFlexible(record?.odds) === null) missing.push('odds');
  if (toNumberFlexible(record?.stake) === null) missing.push('stake');
  return missing;
}

function mergeBetRecord(base = {}, patch = {}) {
  const next = { ...base };
  if (!next.eventName && patch.eventName) next.eventName = String(patch.eventName).trim();
  if (!next.fight && patch.fight) next.fight = String(patch.fight).trim();
  if (!next.pick && patch.pick) next.pick = String(patch.pick).trim();
  const existingOdds = toNumberFlexible(next.odds);
  const existingStake = toNumberFlexible(next.stake);
  const existingUnits = toNumberFlexible(next.units);
  next.odds = existingOdds === null ? toNumberFlexible(patch.odds) : existingOdds;
  next.stake = existingStake === null ? toNumberFlexible(patch.stake) : existingStake;
  next.units = existingUnits === null ? toNumberFlexible(patch.units) : existingUnits;
  return next;
}

async function extractBetRecordFromMedia({
  client,
  model = DECISION_MODEL || MODEL,
  originalMessage = '',
  inputItems = [],
} = {}) {
  if (!client || !hasImageInputItems(inputItems)) {
    return { ok: false, error: 'no_media' };
  }

  const mediaPayload = inputItems.filter(
    (item) => item?.type === 'input_image' || item?.type === 'input_file'
  );
  if (!mediaPayload.length) {
    return { ok: false, error: 'no_supported_media' };
  }

  const extractionInstructions = [
    'Extrae datos de un ticket/apuesta de MMA/UFC.',
    'Devuelve SOLO un JSON válido con claves: eventName, fight, pick, odds, stake, units.',
    'Si no se ve un campo con claridad, devuelve null en ese campo.',
    'No agregues texto fuera del JSON.',
  ].join(' ');

  const extractionPrompt = [
    '[USER_MESSAGE]',
    String(originalMessage || '').trim() || 'N/D',
    '',
    'Objetivo: completar los campos de registro de apuesta.',
  ].join('\n');

  const input = [
    {
      role: 'user',
      content: [
        { type: 'input_text', text: extractionPrompt },
        ...mediaPayload,
      ],
    },
  ];

  try {
    const response = await client.responses.create({
      model: model || MODEL,
      temperature: 0,
      instructions: extractionInstructions,
      input,
    });
    const text = extractResponseText(response);
    const parsed = extractFirstJsonObject(text) || {};
    const extracted = {
      eventName: parsed.eventName ? String(parsed.eventName).trim() : null,
      fight: parsed.fight ? String(parsed.fight).trim() : null,
      pick: parsed.pick ? String(parsed.pick).trim() : null,
      odds: toNumberFlexible(parsed.odds),
      stake: toNumberFlexible(parsed.stake),
      units: toNumberFlexible(parsed.units),
    };
    return {
      ok: true,
      extracted,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function extractMoneylineOddsFromMedia({
  client,
  model = DECISION_MODEL || MODEL,
  originalMessage = '',
  inputItems = [],
} = {}) {
  if (!client || !hasImageInputItems(inputItems)) {
    return { ok: false, error: 'no_media' };
  }

  const mediaPayload = inputItems.filter(
    (item) => item?.type === 'input_image' || item?.type === 'input_file'
  );
  if (!mediaPayload.length) {
    return { ok: false, error: 'no_supported_media' };
  }

  const extractionInstructions = [
    'Extrae cuotas de una captura de apuestas MMA/UFC.',
    'Devuelve SOLO JSON válido con estas claves:',
    'eventName, fight, fighterA, fighterB, moneylineA, moneylineB, bookmaker.',
    'moneylineA/moneylineB deben ser cuotas decimales (number) o null.',
    'Si no se puede leer con claridad, devuelve null.',
    'No agregues texto fuera del JSON.',
  ].join(' ');

  const extractionPrompt = [
    '[USER_MESSAGE]',
    String(originalMessage || '').trim() || 'N/D',
    '',
    'Objetivo: rescatar cuotas moneyline para ajuste deterministico.',
  ].join('\n');

  const input = [
    {
      role: 'user',
      content: [
        { type: 'input_text', text: extractionPrompt },
        ...mediaPayload,
      ],
    },
  ];

  try {
    const response = await client.responses.create({
      model: model || MODEL,
      temperature: 0,
      instructions: extractionInstructions,
      input,
    });
    const text = extractResponseText(response);
    const parsed = extractFirstJsonObject(text) || {};
    const extracted = {
      eventName: parsed.eventName ? String(parsed.eventName).trim() : null,
      fight: parsed.fight ? String(parsed.fight).trim() : null,
      fighterA: parsed.fighterA ? String(parsed.fighterA).trim() : null,
      fighterB: parsed.fighterB ? String(parsed.fighterB).trim() : null,
      moneylineA: toOddsNumber(parsed.moneylineA),
      moneylineB: toOddsNumber(parsed.moneylineB),
      bookmaker: parsed.bookmaker ? String(parsed.bookmaker).trim() : null,
    };
    return { ok: true, extracted };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function inferResultFightReference({
  originalMessage = '',
  resolution = null,
  pendingBets = [],
} = {}) {
  const fromResolution = resolution?.resolvedFight;
  if (fromResolution?.fighterA && fromResolution?.fighterB) {
    return {
      fighterA: fromResolution.fighterA,
      fighterB: fromResolution.fighterB,
      source: 'resolution',
    };
  }

  const fromMessage = extractFightFromText(originalMessage);
  if (fromMessage?.fighterA && fromMessage?.fighterB) {
    return {
      fighterA: fromMessage.fighterA,
      fighterB: fromMessage.fighterB,
      source: 'message',
    };
  }

  const liveHint = chooseLikelyActiveFightFromPendingBets(pendingBets);
  if (liveHint.type === 'single' && liveHint.top?.fight) {
    const parsed = extractFightFromText(liveHint.top.fight);
    if (parsed?.fighterA && parsed?.fighterB) {
      return {
        fighterA: parsed.fighterA,
        fighterB: parsed.fighterB,
        source: 'pending_bets_single',
      };
    }
  }

  return null;
}

function parseScoreNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function pickWinnerFromScores(scores = []) {
  const rows = Array.isArray(scores) ? scores : [];
  const withScore = rows
    .map((row) => ({
      name: String(row?.name || '').trim(),
      score: parseScoreNumber(row?.score),
    }))
    .filter((row) => row.name && row.score !== null);

  if (withScore.length < 2) {
    return {
      winner: null,
      isDraw: false,
      scoreLine: null,
    };
  }

  const sorted = withScore.slice().sort((a, b) => Number(b.score) - Number(a.score));
  const top = sorted[0];
  const runnerUp = sorted[1];
  const isDraw = Number(top.score) === Number(runnerUp.score);
  const scoreLine = withScore.map((row) => `${row.name} ${row.score}`).join(' - ');

  return {
    winner: isDraw ? null : top.name,
    isDraw,
    scoreLine,
  };
}

function findLatestHistoryResultForFight(rows = [], fightRef = null) {
  if (!fightRef?.fighterA || !fightRef?.fighterB) return null;
  const matches = (Array.isArray(rows) ? rows : []).filter((row) => {
    if (!Array.isArray(row)) return false;
    return rowContainsFighter(row, fightRef.fighterA) && rowContainsFighter(row, fightRef.fighterB);
  });
  if (!matches.length) return null;
  const row = matches[0];
  return {
    date: row[0] || null,
    event: row[1] || null,
    fighterA: row[2] || null,
    fighterB: row[3] || null,
    winner: row[5] || null,
    method: row[6] || null,
  };
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

function extractFirstJsonObject(text = '') {
  const raw = String(text || '').trim();
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch {
    // fall through
  }

  const start = raw.indexOf('{');
  if (start < 0) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let idx = start; idx < raw.length; idx += 1) {
    const ch = raw[idx];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === '{') {
      depth += 1;
      continue;
    }

    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        const candidate = raw.slice(start, idx + 1);
        try {
          return JSON.parse(candidate);
        } catch {
          return null;
        }
      }
    }
  }

  return null;
}

function clampNumber(value, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return min;
  return Math.min(max, Math.max(min, parsed));
}

function parseCommitteeProAnalysis(raw = {}) {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const pick = String(raw.pick || '').trim();
  const market = String(raw.market || '').trim();
  const entryRule = String(raw.entry_rule || '').trim();
  const verdict = String(raw.verdict || '').trim().toLowerCase();
  const confidence = clampNumber(raw.confidence, 0, 100);
  const edgePct = Number(raw.edge_pct);
  const thesis = Array.isArray(raw.thesis)
    ? raw.thesis.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 5)
    : [];
  const riskFlags = Array.isArray(raw.risk_flags)
    ? raw.risk_flags.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 5)
    : [];

  if (!pick && !market) {
    return null;
  }

  return {
    verdict: verdict === 'bet' ? 'bet' : 'no_bet',
    pick,
    market,
    entryRule,
    confidence,
    edgePct: Number.isFinite(edgePct) ? edgePct : 0,
    thesis,
    riskFlags,
  };
}

function parseCommitteeContraAnalysis(raw = {}) {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const verdict = String(raw.verdict || '').trim().toLowerCase();
  const block = raw.block === true || verdict === 'block';
  const confidencePenalty = clampNumber(raw.confidence_penalty, 0, PICK_COMMITTEE_MAX_PENALTY);
  const concerns = Array.isArray(raw.concerns)
    ? raw.concerns.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 6)
    : [];
  const requiredChecks = Array.isArray(raw.required_checks)
    ? raw.required_checks
        .map((item) => String(item || '').trim())
        .filter(Boolean)
        .slice(0, 6)
    : [];

  return {
    block,
    confidencePenalty,
    concerns,
    requiredChecks,
  };
}

function shouldRunPickCommittee({
  enabled = false,
  wantsBetDecision = false,
  originalMessage = '',
  reply = '',
}) {
  if (!enabled || !wantsBetDecision) {
    return false;
  }
  if (!isRecommendationReply(reply)) {
    return false;
  }
  if (isLedgerOperationMessage(originalMessage)) {
    return false;
  }
  return true;
}

function buildCommitteeOutcome({
  pro = null,
  contra = null,
  minEdgePct = PICK_COMMITTEE_MIN_EDGE_PCT,
  minConfidence = PICK_COMMITTEE_MIN_CONFIDENCE,
}) {
  if (!pro || !contra) {
    return null;
  }

  const adjustedConfidence = clampNumber(
    Number(pro.confidence) - Number(contra.confidencePenalty),
    0,
    100
  );
  const edgeOk = Number(pro.edgePct) >= Number(minEdgePct);
  const confidenceOk = adjustedConfidence >= Number(minConfidence);
  const blocked = contra.block === true;
  const proWantsBet = pro.verdict === 'bet';

  const approved = proWantsBet && edgeOk && confidenceOk && !blocked;
  const reasons = [];
  if (!proWantsBet) reasons.push('El analista pro no encontró edge suficiente para entrar.');
  if (!edgeOk)
    reasons.push(
      `Edge estimado ${Number.isFinite(Number(pro.edgePct)) ? Number(pro.edgePct).toFixed(1) : 'N/D'}% por debajo del mínimo (${Number(minEdgePct).toFixed(1)}%).`
    );
  if (!confidenceOk)
    reasons.push(
      `Confianza ajustada ${adjustedConfidence.toFixed(0)} por debajo del umbral (${Number(minConfidence).toFixed(0)}).`
    );
  if (blocked)
    reasons.push(
      contra.concerns?.[0] || 'El analista de riesgo marcó incertidumbre material.'
    );

  return {
    approved,
    adjustedConfidence,
    edgePct: Number.isFinite(Number(pro.edgePct)) ? Number(pro.edgePct) : 0,
    reasons,
    pro,
    contra,
  };
}

function renderCommitteeFooter(outcome = null) {
  if (!outcome) return '';

  if (!outcome.approved) {
    const lines = [
      '⛔ Control de riesgo: NO_BET',
      `- Edge estimado: ${outcome.edgePct.toFixed(1)}%`,
      `- Confianza ajustada: ${outcome.adjustedConfidence.toFixed(0)}`,
    ];
    for (const reason of outcome.reasons.slice(0, 3)) {
      lines.push(`- ${reason}`);
    }
    const requiredChecks = outcome.contra?.requiredChecks || [];
    if (requiredChecks.length) {
      lines.push('- Para re-evaluar, faltaría:', ...requiredChecks.slice(0, 3).map((item) => `  • ${item}`));
    }
    return lines.join('\n');
  }

  const lines = [
    '✅ Control de riesgo: Aprobado',
    `- Edge estimado: ${outcome.edgePct.toFixed(1)}%`,
    `- Confianza ajustada: ${outcome.adjustedConfidence.toFixed(0)}`,
  ];
  const concerns = outcome.contra?.concerns || [];
  if (concerns.length) {
    lines.push('- Riesgos a vigilar:', ...concerns.slice(0, 3).map((item) => `  • ${item}`));
  }

  return lines.join('\n');
}

function mergeCitations(base = [], extra = []) {
  const map = new Map();
  for (const item of [...(Array.isArray(base) ? base : []), ...(Array.isArray(extra) ? extra : [])]) {
    if (!item?.url) continue;
    const url = String(item.url).trim();
    if (!url) continue;
    map.set(url, {
      title: item.title || item.url,
      url,
    });
  }
  return Array.from(map.values());
}

async function fetchRecentFightNewsBrief({
  client,
  message = '',
  temporalContext = '',
  timezone = WEB_SEARCH_TIMEZONE,
  model = PICK_COMMITTEE_MODEL,
}) {
  const tools = [
    {
      type: 'web_search',
      search_context_size: 'high',
      user_location: {
        type: 'approximate',
        country: WEB_SEARCH_COUNTRY,
        ...(WEB_SEARCH_REGION ? { region: WEB_SEARCH_REGION } : {}),
        ...(WEB_SEARCH_CITY ? { city: WEB_SEARCH_CITY } : {}),
        ...(timezone ? { timezone } : {}),
      },
    },
  ];

  const instructions = [
    'Sos un scout de riesgo pre-fight en MMA.',
    'Buscá SOLO señales relevantes de los últimos 10 días para los peleadores involucrados.',
    'Priorizá: corte de peso, fallos de peso, lesiones, cambios de campamento, short notice, hospitalizaciones, problemas de viaje/visado.',
    'Devolvé un resumen corto en bullets.',
    'Si no hay señales fuertes, decilo explícitamente.',
    'No inventes ni extrapoles.',
  ].join(' ');

  const input = [
    '[REQUEST]',
    String(message || '').trim() || 'Analizar pelea UFC actual',
    '',
    '[TEMPORAL_CONTEXT]',
    String(temporalContext || '').trim() || 'N/D',
  ].join('\n');

  const response = await client.responses.create({
    model: model || MODEL,
    temperature: 0.1,
    instructions,
    input,
    tools,
    include: INCLUDE_FIELDS,
    tool_choice: 'auto',
  });

  return {
    brief: extractResponseText(response),
    citations: extractCitationsFromResponse(response),
    usedWebSearch: hasWebSearchCall(response),
  };
}

async function runCommitteeAgent({
  client,
  model = PICK_COMMITTEE_MODEL,
  role = 'pro',
  userMessage = '',
  baseReply = '',
  temporalContext = '',
  newsBrief = '',
}) {
  const isPro = role === 'pro';
  const instructions = isPro
    ? [
        'Sos Analyst A (pro-pick) para MMA betting.',
        'Tomá la tesis más fuerte posible PERO sin inventar datos.',
        'Devolvé SOLO un JSON válido con esta forma exacta:',
        '{"verdict":"bet|no_bet","pick":"string","market":"string","edge_pct":number,"confidence":number,"entry_rule":"string","thesis":["string"],"risk_flags":["string"]}',
        'Si no hay edge suficiente, verdict debe ser "no_bet".',
      ].join(' ')
    : [
        'Sos Analyst B (risk/challenge) para MMA betting.',
        'Intentá romper la tesis de Analyst A y encontrar riesgos materiales.',
        'Devolvé SOLO un JSON válido con esta forma exacta:',
        '{"verdict":"block|allow","block":boolean,"confidence_penalty":number,"concerns":["string"],"required_checks":["string"]}',
        'Usá block=true cuando la incertidumbre sea alta o la señal sea débil.',
      ].join(' ');

  const input = [
    '[USER_MESSAGE]',
    String(userMessage || '').trim() || 'N/D',
    '',
    '[BASE_ANALYSIS]',
    String(baseReply || '').trim() || 'N/D',
    '',
    '[RECENT_NEWS_BRIEF]',
    String(newsBrief || '').trim() || 'Sin novedades relevantes',
    '',
    '[TEMPORAL_CONTEXT]',
    String(temporalContext || '').trim() || 'N/D',
  ].join('\n');

  const response = await client.responses.create({
    model: model || MODEL,
    temperature: 0.2,
    instructions,
    input,
  });

  const text = extractResponseText(response);
  const parsed = extractFirstJsonObject(text);

  return isPro ? parseCommitteeProAnalysis(parsed) : parseCommitteeContraAnalysis(parsed);
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
    const wantsCredits = hasCreditSignals(originalMessage);
    const wantsOdds = hasOddsRequestSignals(originalMessage);
    const wantsBetDecision = hasBetDecisionSignals(originalMessage);
    const wantsLatestNews = hasLatestNewsSignals(originalMessage);
    const wantsEventProjections = hasEventProjectionSignals(originalMessage);
    const wantsLiveEventStatus = hasLiveEventStatusSignals(originalMessage);
    const wantsFightResultLookup = hasFightResultLookupSignals(originalMessage);
    const newsAlertsIntent = parseNewsAlertsIntent(originalMessage);
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

    if (newsAlertsIntent && userStore?.getUserIntelPrefs) {
      if (!userId) {
        return {
          reply:
            'No pude resolver el usuario para esta accion. Reintenta desde tu chat personal para configurar alertas.',
          metadata: {
            resolvedFight: runtimeState.resolvedFight,
            eventCard: runtimeState.eventCard,
          },
        };
      }

      const currentPrefs = userStore.getUserIntelPrefs(userId) || {
        newsAlertsEnabled: true,
        alertMinImpact: 'high',
      };
      let nextPrefs = currentPrefs;
      let headline = '🔔 Estado de alertas de noticias.';

      if (newsAlertsIntent.type === 'toggle' && userStore?.updateUserIntelPrefs) {
        const nextEnabled = !Boolean(currentPrefs.newsAlertsEnabled);
        nextPrefs =
          userStore.updateUserIntelPrefs(userId, {
            newsAlertsEnabled: nextEnabled,
          }) || { ...currentPrefs, newsAlertsEnabled: nextEnabled };
        headline = nextEnabled
          ? '✅ Alertas de noticias activadas.'
          : '✅ Alertas de noticias desactivadas.';
      } else if (newsAlertsIntent.type === 'set' && userStore?.updateUserIntelPrefs) {
        const desired = Boolean(newsAlertsIntent.enabled);
        nextPrefs =
          userStore.updateUserIntelPrefs(userId, {
            newsAlertsEnabled: desired,
          }) || { ...currentPrefs, newsAlertsEnabled: desired };
        headline = desired
          ? '✅ Alertas de noticias activadas.'
          : '✅ Alertas de noticias desactivadas.';
      }

      const eventState = userStore?.getEventWatchState?.('next_event');
      const lines = [
        headline,
        `- Estado: ${nextPrefs.newsAlertsEnabled ? 'ACTIVAS' : 'DESACTIVADAS'}`,
        `- Umbral de impacto: ${formatImpactBadge(nextPrefs.alertMinImpact)} (${String(
          nextPrefs.alertMinImpact || 'high'
        ).toUpperCase()})`,
      ];

      if (eventState?.eventName) {
        lines.push(
          `- Evento monitoreado: ${eventState.eventName} (${formatEventDateLabel(
            eventState.eventDateUtc,
            temporalContext.timezone
          )})`
        );
      }
      if (nextPrefs?.updatedAt) {
        lines.push(
          `- Actualizado: ${formatIsoForUser(nextPrefs.updatedAt, temporalContext.timezone)}`
        );
      }

      lines.push(
        '',
        'Comandos utiles: `activar alertas noticias`, `desactivar alertas noticias`, `estado alertas noticias`.'
      );

      return {
        reply: lines.join('\n'),
        metadata: {
          resolvedFight: runtimeState.resolvedFight,
          eventCard: runtimeState.eventCard,
        },
      };
    }

    if (wantsLiveEventStatus) {
      const userTimezone = userProfile?.timezone || temporalContext.timezone || DEFAULT_USER_TIMEZONE;
      const localNow = extractLocalDateTimeParts(new Date(), userTimezone);
      const nowMs = Date.now();
      const nextEventState = userStore?.getEventWatchState?.('next_event') || null;

      const loadOddsLiveRows = () => {
        const upcomingRows = userStore?.listUpcomingOddsEvents
          ? userStore.listUpcomingOddsEvents({
              fromIso: new Date(nowMs - 10 * 3600000).toISOString(),
              limit: 120,
            })
          : [];
        const recentRows = userStore?.listRecentOddsEvents
          ? userStore.listRecentOddsEvents({
              fromIso: new Date(nowMs - 20 * 3600000).toISOString(),
              toIso: new Date(nowMs + 10 * 3600000).toISOString(),
              limit: 180,
              includeCompleted: true,
            })
          : [];
        return mergeOddsEventRows(upcomingRows, recentRows);
      };

      let oddsWindowEvents = loadOddsLiveRows();
      let liveOddsHints = buildLiveOddsFightHints(oddsWindowEvents, nowMs);
      let liveOddsContext = buildLiveOddsEventContext(oddsWindowEvents, nowMs, {
        referenceDateIso: localNow.dateIso,
        timezone: userTimezone,
      });
      if (
        (!liveOddsContext || Number(liveOddsContext?.confidenceScore || 0) < 45) &&
        typeof userStore?.refreshLiveScores === 'function'
      ) {
        try {
          await userStore.refreshLiveScores({ force: true, daysFrom: 3 });
          oddsWindowEvents = loadOddsLiveRows();
          liveOddsHints = buildLiveOddsFightHints(oddsWindowEvents, nowMs);
          liveOddsContext = buildLiveOddsEventContext(oddsWindowEvents, nowMs, {
            referenceDateIso: localNow.dateIso,
            timezone: userTimezone,
          });
        } catch (error) {
          console.error('⚠️ live event score refresh failed:', error);
        }
      }
      const liveEventStateFromOdds = buildEventStateFromOddsRows({
        oddsRows: oddsWindowEvents,
        eventContext: liveOddsContext,
      });

      let liveWebContext = null;
      if (typeof userStore?.resolveLiveEventContext === 'function') {
        const referenceDates = [new Date(nowMs), new Date(nowMs - 4 * 3600000)];
        for (const referenceDate of referenceDates) {
          try {
            const context = await userStore.resolveLiveEventContext({
              referenceDate,
              originalMessage,
            });
            if (context?.eventName) {
              liveWebContext = context;
              break;
            }
          } catch (error) {
            console.error('⚠️ live event web context failed:', error);
          }
        }
      }

      const webEventName = String(liveWebContext?.eventName || '').trim();
      const webEventDate = toIsoDateSafe(liveWebContext?.date || '');
      const oddsEventName = String(liveOddsContext?.eventName || '').trim();
      const oddsEventDate = toIsoDateSafe(liveOddsContext?.eventDate || '');
      const todayIso = resolveReferenceDateIso({
        referenceDateIso: localNow.dateIso,
        nowMs,
        timezone: userTimezone,
      });
      const webDistanceDays = webEventDate
        ? Math.abs(dateDiffInDays(webEventDate, todayIso))
        : Number.POSITIVE_INFINITY;
      const oddsDistanceDays = oddsEventDate
        ? Math.abs(dateDiffInDays(oddsEventDate, todayIso))
        : Number.POSITIVE_INFINITY;
      const webVsOddsDateGapDays =
        webEventDate && oddsEventDate
          ? Math.abs(dateDiffInDays(webEventDate, oddsEventDate))
          : 0;
      const oddsConfidence = Number(liveOddsContext?.confidenceScore || 0);

      const preferOddsContext =
        Boolean(oddsEventName) &&
        (!webEventName ||
          ((webVsOddsDateGapDays >= 2 || webDistanceDays > 1) &&
            oddsDistanceDays <= 1 &&
            oddsConfidence >= 58) ||
          (oddsConfidence >= 80 && oddsDistanceDays <= 1));

      const resolvedEventName = preferOddsContext
        ? oddsEventName
        : webEventName || oddsEventName;
      const resolvedEventDate = preferOddsContext
        ? oddsEventDate || webEventDate
        : webEventDate || oddsEventDate;

      if (resolvedEventName) {
        if (typeof userStore?.upsertEventWatchState === 'function') {
          try {
            const mainCard =
              Array.isArray(liveEventStateFromOdds?.mainCard) && liveEventStateFromOdds.mainCard.length
                ? liveEventStateFromOdds.mainCard
                : Array.isArray(liveWebContext?.fights)
                ? liveWebContext.fights
                    .filter((fight) => fight?.fighterA && fight?.fighterB)
                    .slice(0, 8)
                    .map((fight, index) => ({
                      fightId: `fight_${index + 1}`,
                      fighterA: String(fight.fighterA || '').trim(),
                      fighterB: String(fight.fighterB || '').trim(),
                      isCompleted: false,
                      hasScores: false,
                    }))
                : [];
            const resolvedEventId =
              String(liveEventStateFromOdds?.eventId || '').trim() ||
              String(liveOddsContext?.eventId || '').trim() ||
              String(liveWebContext?.eventId || '').trim() ||
              buildSyntheticEventId(resolvedEventName, resolvedEventDate || null);
            userStore.upsertEventWatchState(
              {
                eventId: resolvedEventId,
                eventName: resolvedEventName,
                eventDateUtc: resolvedEventDate || null,
                eventStatus: 'live',
                sourcePrimary: preferOddsContext ? 'odds_scores_live' : liveWebContext?.source || null,
                sourceSecondary: preferOddsContext ? liveWebContext?.source || null : null,
                mainCard,
                monitoredFighters: collectMonitoredFightersFromMainCard(mainCard),
                lastReconciledAt: new Date().toISOString(),
              },
              'current_event'
            );
          } catch (error) {
            console.error('⚠️ live event upsert current_event failed:', error);
          }
        }

        const lines = [
          '🔴 Estado UFC en vivo (validacion actual)',
          `Evento detectado: ${resolvedEventName}`,
          `Referencia temporal usada: ${localNow.dateIso} ${localNow.hour}:${localNow.minute} (${userTimezone})`,
        ];
        if (resolvedEventDate) {
          lines.push(
            `Fecha estimada del evento: ${formatEventDateLabel(resolvedEventDate, userTimezone)}`
          );
        }

        const webFights = Array.isArray(liveWebContext?.fights)
          ? liveWebContext.fights
              .filter((fight) => fight?.fighterA && fight?.fighterB)
              .slice(0, 4)
              .map((fight) => `${fight.fighterA} vs ${fight.fighterB}`)
          : [];
        const fightHints = preferOddsContext
          ? Array.isArray(liveOddsContext?.fights) && liveOddsContext.fights.length
            ? liveOddsContext.fights
            : liveOddsHints
          : webFights.length
          ? webFights
          : Array.isArray(liveOddsContext?.fights) && liveOddsContext.fights.length
          ? liveOddsContext.fights
          : liveOddsHints;
        if (fightHints.length) {
          lines.push('', 'Cruces detectados alrededor de ahora:');
          for (const [index, fightText] of fightHints.entries()) {
            lines.push(`${index + 1}. ${fightText}`);
          }
        }
        if (preferOddsContext && webEventName && webEventName !== oddsEventName) {
          lines.push(
            '',
            'Nota de reconciliacion: priorice odds/scores en tiempo real por discrepancia con la respuesta web.'
          );
        }

        lines.push(
          '',
          preferOddsContext && liveOddsContext?.eventName
            ? 'Fuente primaria: indice interno de odds/scores.'
            : liveWebContext?.source
            ? `Fuente primaria: ${liveWebContext.source}.`
            : liveOddsContext?.eventName
            ? 'Fuente primaria: indice interno de odds/scores.'
            : 'Fuente primaria: reconciliacion interna (cache + tiempo).'
        );

        return {
          reply: lines.join('\n'),
          metadata: {
            resolvedFight: runtimeState.resolvedFight,
            eventCard: runtimeState.eventCard,
          },
        };
      }

      if (liveOddsHints.length) {
        return {
          reply: [
            '🔴 Detecté actividad de peleas UFC/MMA alrededor de ahora, pero no pude confirmar con certeza el nombre oficial del evento en este turno.',
            `Referencia temporal usada: ${localNow.dateIso} ${localNow.hour}:${localNow.minute} (${userTimezone})`,
            '',
            'Cruces detectados:',
            ...liveOddsHints.map((fight, index) => `${index + 1}. ${fight}`),
            '',
            'Si queres, lo reintento con una consulta web puntual para validar el nombre oficial del evento.',
          ].join('\n'),
          metadata: {
            resolvedFight: runtimeState.resolvedFight,
            eventCard: runtimeState.eventCard,
          },
        };
      }

      const nextEventLabel =
        nextEventState?.eventName && nextEventState?.eventDateUtc
          ? `${nextEventState.eventName} (${formatEventDateLabel(nextEventState.eventDateUtc, userTimezone)})`
          : nextEventState?.eventName || null;

      const lines = [
        '🔴 Estado UFC en vivo (validacion actual)',
        'No pude confirmar un evento UFC en vivo con evidencia suficiente en este turno.',
        `Referencia temporal usada: ${localNow.dateIso} ${localNow.hour}:${localNow.minute} (${userTimezone})`,
      ];
      if (nextEventLabel) {
        lines.push(`Proximo evento en agenda (no necesariamente en vivo): ${nextEventLabel}`);
      }
      lines.push(
        '',
        'Si queres, lo reintento con una consulta web puntual para validar el evento live oficial.'
      );
      return {
        reply: lines.join('\n'),
        metadata: {
          resolvedFight: runtimeState.resolvedFight,
          eventCard: runtimeState.eventCard,
        },
      };
    }

    if ((wantsLatestNews || wantsEventProjections) && userStore?.getEventWatchState) {
      const nowMs = Date.now();
      const loadOddsLiveRows = () => {
        const upcomingRows = userStore?.listUpcomingOddsEvents
          ? userStore.listUpcomingOddsEvents({
              fromIso: new Date(nowMs - 10 * 3600000).toISOString(),
              limit: 120,
            })
          : [];
        const recentRows = userStore?.listRecentOddsEvents
          ? userStore.listRecentOddsEvents({
              fromIso: new Date(nowMs - 20 * 3600000).toISOString(),
              toIso: new Date(nowMs + 10 * 3600000).toISOString(),
              limit: 180,
              includeCompleted: true,
            })
          : [];
        return mergeOddsEventRows(upcomingRows, recentRows);
      };

      const currentEventState = userStore.getEventWatchState('current_event');
      const nextEventState = userStore.getEventWatchState('next_event');
      const referenceDateIso = temporalContext?.nowLocal?.dateIso || null;
      const referenceTimezone = temporalContext?.timezone || DEFAULT_USER_TIMEZONE;
      const preferCurrentEvent = isEventStateNearToday(currentEventState, nowMs, 1, {
        referenceDateIso,
        timezone: referenceTimezone,
      });
      let eventState = preferCurrentEvent ? currentEventState : nextEventState;
      const fallbackEventState = eventState || null;
      const todayIso = resolveReferenceDateIso({
        referenceDateIso,
        nowMs,
        timezone: referenceTimezone,
      });
      const fallbackEventDate = toIsoDateSafe(fallbackEventState?.eventDateUtc || '');
      const fallbackDistanceDays = fallbackEventDate
        ? Math.abs(dateDiffInDays(fallbackEventDate, todayIso))
        : Number.POSITIVE_INFINITY;
      let oddsLiveRows = loadOddsLiveRows();
      let liveOddsContext = buildLiveOddsEventContext(oddsLiveRows, nowMs, {
        referenceDateIso,
        timezone: referenceTimezone,
      });
      if (
        (!liveOddsContext || Number(liveOddsContext?.confidenceScore || 0) < 45) &&
        typeof userStore?.refreshLiveScores === 'function'
      ) {
        try {
          await userStore.refreshLiveScores({ force: true, daysFrom: 3 });
          oddsLiveRows = loadOddsLiveRows();
          liveOddsContext = buildLiveOddsEventContext(oddsLiveRows, nowMs, {
            referenceDateIso,
            timezone: referenceTimezone,
          });
        } catch (error) {
          console.error('⚠️ intel event refreshLiveScores failed:', error);
        }
      }
      const liveEventState = buildEventStateFromOddsRows({
        oddsRows: oddsLiveRows,
        eventContext: liveOddsContext,
      });
      let reconciledWithLive = false;
      let reconciledWithWeb = false;
      let mergedLiveSignals = false;

      const shouldUseOddsEvent = shouldPreferOddsEventForIntel({
        fallbackEventState: eventState,
        liveEventState,
        liveOddsContext,
        nowMs,
        referenceDateIso,
        timezone: referenceTimezone,
      });
      if (shouldUseOddsEvent) {
        eventState = liveEventState;
        reconciledWithLive = true;
      }

      let liveWebContext = null;
      let liveWebEventState = null;
      const shouldTryWebLiveContext =
        typeof userStore?.resolveLiveEventContext === 'function' &&
        (!eventState?.eventName || fallbackDistanceDays > 1 || !liveEventState?.eventName);
      if (shouldTryWebLiveContext) {
        const referenceDates = [new Date(nowMs), new Date(nowMs - 4 * 3600000)];
        for (const referenceDate of referenceDates) {
          try {
            const context = await userStore.resolveLiveEventContext({
              referenceDate,
              originalMessage,
            });
            if (context?.eventName) {
              liveWebContext = context;
              break;
            }
          } catch (error) {
            console.error('⚠️ intel event resolveLiveEventContext failed:', error);
          }
        }
        liveWebEventState = buildEventStateFromWebContext({
          webContext: liveWebContext,
          fallbackEventState: eventState,
        });
        if (
          shouldPreferWebEventForIntel({
            fallbackEventState: eventState,
            webEventState: liveWebEventState,
            nowMs,
            referenceDateIso,
            timezone: referenceTimezone,
          })
        ) {
          eventState = liveWebEventState;
          reconciledWithWeb = true;
        }
      }

      if (liveEventState && eventsLikelySame(eventState, liveEventState)) {
        eventState = mergeEventStateWithLiveSignals({
          baseEventState: eventState,
          liveEventState,
        });
        if (!reconciledWithLive) {
          mergedLiveSignals = true;
        }
      }

      if (!eventState?.eventId || !eventState?.eventName) {
        return {
          reply:
            'Todavia no tengo sincronizado el proximo evento UFC. Dame unos minutos y volve a intentar.',
          metadata: {
            resolvedFight: runtimeState.resolvedFight,
            eventCard: runtimeState.eventCard,
          },
        };
      }

      const userTimezone = userProfile?.timezone || temporalContext.timezone || DEFAULT_USER_TIMEZONE;
      const eventLabel = `${eventState.eventName} (${formatEventDateLabel(
        eventState.eventDateUtc,
        userTimezone
      )})`;
      const liveSignalsDetected = reconciledWithLive || reconciledWithWeb || mergedLiveSignals;
      const reconciliationNotes = [];
      if (reconciledWithLive) {
        reconciliationNotes.push('Nota: evento objetivo reconciliado con odds/scores en tiempo real.');
      }
      if (reconciledWithWeb) {
        const source = String(liveWebContext?.source || '').trim();
        reconciliationNotes.push(
          source
            ? `Nota: evento objetivo reconciliado con contexto web live (${source}).`
            : 'Nota: evento objetivo reconciliado con contexto web live.'
        );
      }
      if (mergedLiveSignals && !reconciledWithLive) {
        reconciliationNotes.push('Nota: estado de peleas reconciliado con scores live en backend.');
      }
      const selectedEventDate = toIsoDateSafe(eventState?.eventDateUtc || '');
      const selectedEventDistanceDays = selectedEventDate
        ? Math.abs(dateDiffInDays(selectedEventDate, todayIso))
        : Number.POSITIVE_INFINITY;
      if (!liveSignalsDetected && selectedEventDistanceDays > 1) {
        reconciliationNotes.push(
          'Aviso: sin señal live validada en este turno; mostrando el proximo evento en agenda.'
        );
      }

      if (typeof userStore?.upsertEventWatchState === 'function' && liveSignalsDetected) {
        try {
          const normalizedMainCard = Array.isArray(eventState?.mainCard)
            ? eventState.mainCard
                .filter((fight) => fight?.fighterA && fight?.fighterB)
                .slice(0, 12)
                .map((fight, index) => ({
                  fightId: String(fight?.fightId || '').trim() || `fight_${index + 1}`,
                  fighterA: String(fight.fighterA || '').trim(),
                  fighterB: String(fight.fighterB || '').trim(),
                  isCompleted: fight?.isCompleted === true,
                  hasScores: Boolean(fight?.hasScores),
                }))
            : [];
          userStore.upsertEventWatchState(
            {
              eventId:
                String(eventState?.eventId || '').trim() ||
                buildSyntheticEventId(eventState?.eventName || '', eventState?.eventDateUtc || null),
              eventName: String(eventState?.eventName || '').trim(),
              eventDateUtc: selectedEventDate || null,
              eventStatus: 'live',
              sourcePrimary: eventState?.sourcePrimary || null,
              sourceSecondary: null,
              mainCard: normalizedMainCard,
              monitoredFighters: collectMonitoredFightersFromMainCard(normalizedMainCard),
              lastReconciledAt: new Date().toISOString(),
            },
            'current_event'
          );
        } catch (error) {
          console.error('⚠️ projections upsert current_event failed:', error);
        }
      }

      if (wantsLatestNews) {
        if (!userStore?.listLatestRelevantNews) {
          return {
            reply: 'El modulo de novedades no esta disponible en este entorno.',
            metadata: {
              resolvedFight: runtimeState.resolvedFight,
              eventCard: runtimeState.eventCard,
            },
          };
        }

        const items = userStore.listLatestRelevantNews({
          eventId: eventState.eventId,
          limit: EVENT_INTEL_NEWS_USER_LIMIT,
          minImpact: EVENT_INTEL_NEWS_DEFAULT_MIN_IMPACT,
        });

        if (!items.length) {
          const lastUpdate = eventState?.updatedAt
            ? formatIsoForUser(eventState.updatedAt, userTimezone)
            : 'N/D';
          return {
            reply: [
              '📰 Ultimas novedades',
              `Evento: ${eventLabel}`,
              'No encontré noticias relevantes nuevas (impacto medio/alto) por ahora.',
              `Ultima reconciliacion: ${lastUpdate}`,
            ].join('\n'),
            metadata: {
              resolvedFight: runtimeState.resolvedFight,
              eventCard: runtimeState.eventCard,
            },
          };
        }

        const lines = ['📰 Ultimas novedades', `Evento: ${eventLabel}`, ''];
        if (reconciliationNotes.length) {
          lines.push(...reconciliationNotes, '');
        }
        for (const [index, item] of items.entries()) {
          const stamp = formatIsoForUser(item.publishedAt || item.fetchedAt, userTimezone);
          const fighter = item.fighterName ? `${item.fighterName}: ` : '';
          lines.push(
            `${index + 1}. ${formatImpactBadge(item.impactLevel)} ${fighter}${truncateText(
              item.title || 'Sin titulo',
              170
            )}`
          );
          lines.push(`   ${item.sourceDomain || 'fuente no identificada'} | ${stamp}`);
          if (item.url) {
            lines.push(`   ${item.url}`);
          }
        }
        lines.push('', 'Si queres, tambien te muestro `proyecciones para el evento`.');

        return {
          reply: lines.join('\n'),
          metadata: {
            resolvedFight: runtimeState.resolvedFight,
            eventCard: runtimeState.eventCard,
          },
        };
      }

      const allFights = Array.isArray(eventState.mainCard)
        ? eventState.mainCard.filter((fight) => fight?.fighterA && fight?.fighterB)
        : [];
      const completedCount = allFights.filter((fight) => fight?.isCompleted === true).length;
      const pendingFights = allFights.filter((fight) => fight?.isCompleted !== true);
      const fights = pendingFights.length ? pendingFights : allFights;
      if (!fights.length) {
        return {
          reply:
            'Todavia no tengo main card confirmada para el proximo evento. Cuando se sincronice, te muestro las proyecciones pelea por pelea.',
          metadata: {
            resolvedFight: runtimeState.resolvedFight,
            eventCard: runtimeState.eventCard,
          },
        };
      }

      const items = userStore?.listLatestRelevantNews
        ? userStore.listLatestRelevantNews({
            eventId: eventState.eventId,
            limit: EVENT_INTEL_PROJECTION_NEWS_LIMIT,
            minImpact: 'low',
          })
        : [];
      const storedProjections = userStore?.listLatestProjectionSnapshotsForEvent
        ? userStore.listLatestProjectionSnapshotsForEvent({
            eventId: eventState.eventId,
            limit: Math.max(20, fights.length * 2),
            latestPerFight: true,
          })
        : [];
      const storedBetScoring = userStore?.listLatestBetScoringForEvent
        ? userStore.listLatestBetScoringForEvent({
            eventId: eventState.eventId,
            limit: Math.max(60, fights.length * 4),
            latestPerFightMarket: true,
          })
        : [];
      const hasStoredProjections = Array.isArray(storedProjections) && storedProjections.length > 0;
      const hasStoredBetScoring = Array.isArray(storedBetScoring) && storedBetScoring.length > 0;

      const lines = [
        '📊 Proyecciones para el evento',
        `Evento: ${eventLabel}`,
        hasStoredProjections && hasStoredBetScoring
          ? 'Base: proyecciones + scoring precomputado por mercado en backend.'
          : hasStoredProjections
          ? 'Base: proyecciones precomputadas (noticias + consenso de cuotas) en backend.'
          : 'Base: señales de noticias + monitoreo de disponibilidad (sin cuotas live).',
        '',
      ];
      if (reconciliationNotes.length) {
        lines.push(...reconciliationNotes);
      }
      if (completedCount > 0 && pendingFights.length) {
        lines.push(
          `Estado live: ${completedCount}/${allFights.length} peleas cerradas; mostrando solo las restantes.`,
          ''
        );
      } else if (completedCount > 0 && completedCount === allFights.length) {
        lines.push(
          `Estado live: cartelera cerrada (${completedCount}/${allFights.length} peleas finalizadas).`,
          ''
        );
      } else if (liveSignalsDetected) {
        lines.push('Estado live: cartelera en curso.', '');
      }

      for (const [index, fight] of fights.entries()) {
        const storedProjection = storedProjections.find((row) =>
          projectionSnapshotMatchesFight(row, fight)
        );
        const projection = storedProjection
          ? {
              projectedWinner: storedProjection.predictedWinner || null,
              confidence: Math.round(Number(storedProjection.confidencePct || 0)),
              scenario: describeProjectedMethod(storedProjection.predictedMethod),
              evidence: [],
              keyFactors: Array.isArray(storedProjection.keyFactors)
                ? storedProjection.keyFactors.slice(0, 3)
                : [],
              changeSummary: storedProjection.changeSummary || null,
            }
          : buildFightProjection({
              fight,
              newsItems: items,
            });
        const oddsRows = userStore?.listLatestOddsMarketsForFight
          ? userStore.listLatestOddsMarketsForFight({
              fighterA: fight.fighterA,
              fighterB: fight.fighterB,
              marketKey: 'h2h',
              limit: 40,
              maxAgeHours: 72,
            })
          : [];
        const oddsConsensus = buildOddsConsensusForFight({
          rows: oddsRows,
          fighterA: fight.fighterA,
          fighterB: fight.fighterB,
        });
        const fightBetScoringRows = (Array.isArray(storedBetScoring) ? storedBetScoring : [])
          .filter((row) => projectionSnapshotMatchesFight(row, fight))
          .sort(compareBetScoringRows);
        const primaryBetScoring = fightBetScoringRows[0] || null;
        const alternativeBetScoring = fightBetScoringRows
          .filter((row) => String(row?.recommendation || '').trim().toLowerCase() !== 'no_bet')
          .slice(1, 2);
        const fightLabel = `${fight.fighterA} vs ${fight.fighterB}`;

        lines.push(`${index + 1}. ${fightLabel}`);
        lines.push(
          `   Proyeccion: ${
            projection.projectedWinner
              ? `ventaja para ${projection.projectedWinner}`
              : 'pelea cerrada, sin edge claro'
          }.`
        );
        lines.push(`   Confianza: ${projection.confidence}%`);
        lines.push(`   Escenario: ${projection.scenario}`);
        if (projection.changeSummary) {
          lines.push(`   Cambio reciente: ${projection.changeSummary}`);
        }
        if (primaryBetScoring) {
          lines.push(`   Recomendacion backend: ${renderBetScoringLine(primaryBetScoring)}`);
          if (alternativeBetScoring.length) {
            lines.push(`   Alternativa: ${renderBetScoringLine(alternativeBetScoring[0])}`);
          }
        }
        if (oddsConsensus) {
          lines.push(
            `   Consenso bookies (${oddsConsensus.bookmakersCount}): ${fight.fighterA} @${oddsConsensus.avgPriceA.toFixed(
              2
            )} vs ${fight.fighterB} @${oddsConsensus.avgPriceB.toFixed(2)}`
          );
          if (oddsConsensus.impliedA && oddsConsensus.impliedB) {
            lines.push(
              `   Prob. implícita mercado: ${fight.fighterA} ${oddsConsensus.impliedA.toFixed(
                1
              )}% | ${fight.fighterB} ${oddsConsensus.impliedB.toFixed(1)}%`
            );
          }
        }

        const hasRelevantNewsEvidence = Array.isArray(projection.evidence)
          ? projection.evidence.some((item) => impactRank(item?.impactLevel) >= 2)
          : false;
        const shouldShowSignals =
          projection.changeSummary ||
          (Array.isArray(projection.keyFactors) && projection.keyFactors.length > 0) ||
          hasRelevantNewsEvidence;

        if (
          shouldShowSignals &&
          Array.isArray(projection.keyFactors) &&
          projection.keyFactors.length
        ) {
          for (const factor of projection.keyFactors) {
            lines.push(`   Señal relevante: ${truncateText(String(factor || ''), 140)}`);
          }
        } else if (shouldShowSignals) {
          for (const item of projection.evidence) {
            lines.push(
              `   Señal relevante: ${formatImpactBadge(item.impactLevel)} ${truncateText(
                item.title || '',
                140
              )}`
            );
          }
        }
        lines.push('');
      }

      const topOpportunities = listTopEventBetOpportunities({
        rows: storedBetScoring,
        fights,
        limit: 5,
      });
      if (topOpportunities.length) {
        lines.push('🔥 Oportunidades precomputadas (top del evento)');
        for (const [index, item] of topOpportunities.entries()) {
          lines.push(`${index + 1}. ${item.fightLabel}`);
          lines.push(`   ${renderBetScoringLine(item)}`);
        }
        lines.push('');
      }

      lines.push(
        'Este bloque se va actualizando automaticamente durante la semana y puede cambiar si aparece info nueva.'
      );

      return {
        reply: lines.join('\n').trim(),
        metadata: {
          resolvedFight: runtimeState.resolvedFight,
          eventCard: runtimeState.eventCard,
        },
      };
    }

    if (wantsCredits && userId && userStore?.getCreditState) {
      const creditState = userStore.getCreditState(userId, CREDIT_FREE_WEEKLY) || {
        availableCredits: 0,
        freeCredits: 0,
        paidCredits: 0,
        weekId: null,
      };

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

      const recentTx = userStore.listCreditTransactions
        ? userStore.listCreditTransactions(userId, { limit: 6 })
        : [];

      const topupUrl = resolveTopupUrl(userId);
      const tz = temporalContext?.timezone || userProfile?.timezone || DEFAULT_USER_TIMEZONE;

      const lines = [
        '💳 Estado de creditos',
        `- Disponibles: ${(Number(creditState.availableCredits) || 0).toFixed(2)}`,
        `- Free: ${(Number(creditState.freeCredits) || 0).toFixed(2)}`,
        `- Paid: ${(Number(creditState.paidCredits) || 0).toFixed(2)}`,
      ];

      if (creditState.weekId) {
        lines.push(`- Semana free activa: ${creditState.weekId}`);
      }

      lines.push(
        `- Consumo multimedia: ${Number(usageCounters.imagesToday) || 0} imagen(es) hoy | ${(
          (Number(usageCounters.audioSecondsWeek) || 0) / 60
        ).toFixed(1)} min audio esta semana`
      );

      if (recentTx.length) {
        lines.push('', 'Ultimos movimientos:');
        for (const tx of recentTx.slice(0, 5)) {
          const when = formatIsoForUser(tx.createdAt, tz);
          const reason = tx.reason ? ` (${tx.reason})` : '';
          lines.push(
            `- ${when}: ${formatSignedCredits(tx.amount)} [${String(
              tx.type || 'tx'
            ).toUpperCase()}]${reason}`
          );
        }
      }

      if (topupUrl) {
        lines.push('', `Recarga: ${topupUrl}`);
      }

      return {
        reply: lines.join('\n'),
        metadata: {
          resolvedFight: runtimeState.resolvedFight,
          eventCard: runtimeState.eventCard,
        },
      };
    }

    if (isProfileSummaryRequest(originalMessage) && userId) {
      const latestProfile =
        userStore?.getUserProfile?.(userId) ||
        userProfile ||
        conversationStore?.getSession?.(chatId)?.userProfile ||
        {};
      return {
        reply: formatProfileSummary(latestProfile),
        metadata: {
          resolvedFight: runtimeState.resolvedFight,
          eventCard: runtimeState.eventCard,
        },
      };
    }

    const stakePreference = parseStakePreferenceMessage(originalMessage);
    const profilePreference = parseProfilePreferenceMessage(originalMessage);
    if ((stakePreference || profilePreference) && userId && userStore?.updateUserProfile) {
      const updates = {};
      if (stakePreference?.minStakeAmount !== null && stakePreference?.minStakeAmount !== undefined) {
        updates.minStakeAmount = stakePreference.minStakeAmount;
      }
      if (stakePreference?.minUnitsPerBet !== null && stakePreference?.minUnitsPerBet !== undefined) {
        updates.minUnitsPerBet = stakePreference.minUnitsPerBet;
      }
      if (profilePreference?.updates && Object.keys(profilePreference.updates).length) {
        Object.assign(updates, profilePreference.updates);
      }

      if (Object.keys(updates).length) {
        const nextProfile = userStore.updateUserProfile(userId, updates) || {};
        if (conversationStore?.patch) {
          conversationStore.patch(chatId, { userProfile: nextProfile });
        }
        const onlyStakeUpdate =
          Object.keys(updates).every((key) => ['minStakeAmount', 'minUnitsPerBet'].includes(key)) &&
          Object.keys(updates).length > 0;

        const currency = nextProfile.currency || 'ARS';
        const lines = [onlyStakeUpdate ? '✅ Perfil de staking actualizado.' : '✅ Config actualizada.'];
        if (onlyStakeUpdate) {
          lines.push(
            `- Piso por apuesta: ${formatUnits(
              toNumberOrNull(nextProfile.minUnitsPerBet) ?? STAKE_MIN_UNITS_DEFAULT
            )}u / ${formatAmountWithCurrency(
              toNumberOrNull(nextProfile.minStakeAmount) ?? STAKE_MIN_AMOUNT_DEFAULT,
              currency
            )}`,
            'En las proximas recomendaciones voy a respetar ese minimo.'
          );
        } else {
          if (updates.bankroll !== undefined) {
            lines.push(`- Bankroll: ${formatAmountWithCurrency(nextProfile.bankroll, currency)}`);
          }
          if (updates.unitSize !== undefined) {
            lines.push(`- Unidad: ${formatAmountWithCurrency(nextProfile.unitSize, currency)}`);
          }
          if (updates.riskProfile !== undefined) {
            lines.push(`- Riesgo: ${nextProfile.riskProfile || 'No definido'}`);
          }
          if (updates.timezone !== undefined) {
            lines.push(`- Timezone: ${nextProfile.timezone || DEFAULT_USER_TIMEZONE}`);
          }
          if (updates.minStakeAmount !== undefined || updates.minUnitsPerBet !== undefined) {
            lines.push(
              `- Stake minimo: ${formatUnits(
                toNumberOrNull(nextProfile.minUnitsPerBet) ?? STAKE_MIN_UNITS_DEFAULT
              )}u / ${formatAmountWithCurrency(
                toNumberOrNull(nextProfile.minStakeAmount) ?? STAKE_MIN_AMOUNT_DEFAULT,
                currency
              )}`
            );
          }
          if (updates.targetEventUtilizationPct !== undefined) {
            lines.push(
              `- Utilizacion objetivo evento: ${formatUnits(
                toNumberOrNull(nextProfile.targetEventUtilizationPct) || 0
              )}%`
            );
          }
        }

        const warnings = profilePreference?.warnings || [];
        if (warnings.length) {
          lines.push('', ...warnings.map((warning) => `⚠️ ${warning}`));
        }

        return {
          reply: lines.join('\n'),
          metadata: {
            resolvedFight: runtimeState.resolvedFight,
            eventCard: runtimeState.eventCard,
          },
        };
      }

      if (profilePreference?.warnings?.length) {
        const lines = ['No pude aplicar cambios en Config por estos motivos:'];
        for (const warning of profilePreference.warnings) {
          lines.push(`- ${warning}`);
        }
        lines.push(
          '',
          'Ejemplos validos: `unidad 600`, `riesgo moderado`, `bankroll 120000`, `timezone America/Argentina/Buenos_Aires`.'
        );
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
    const extractMutationDescriptors = (payload = {}) => {
      if (!payload || typeof payload !== 'object') return [];
      if (Array.isArray(payload.steps) && payload.steps.length) {
        return payload.steps
          .map((step) => {
            if (!step || typeof step !== 'object') return null;
            return {
              operation: String(step.operation || '').trim().toLowerCase(),
              result: normalizeBetResult(step.result),
            };
          })
          .filter((entry) => entry?.operation);
      }
      const operation = String(payload.operation || '')
        .trim()
        .toLowerCase();
      if (!operation) return [];
      return [
        {
          operation,
          result: normalizeBetResult(payload.result),
        },
      ];
    };

    const formatMutationPayloadLabel = (payload = {}) => {
      const descriptors = extractMutationDescriptors(payload);
      const uniqueOperations = Array.from(
        new Set(descriptors.map((item) => item.operation).filter(Boolean))
      );
      if (uniqueOperations.length === 1) {
        return formatMutationActionLabel(uniqueOperations[0]);
      }
      if (uniqueOperations.length > 1) {
        return 'COMPOSITE';
      }
      return formatMutationActionLabel(String(payload.operation || '').trim().toLowerCase());
    };

    const applyMutationPayload = (payload = {}, { confirmationToken = '', confirmationSource = '' } = {}) => {
      const applyMetadata = {
        ...(payload?.metadata || {}),
        ...(confirmationToken ? { confirmationToken } : {}),
        ...(confirmationSource ? { confirmationSource } : {}),
      };
      const applyPayload = {
        ...(payload || {}),
        confirm: true,
        metadata: applyMetadata,
      };
      const hasCompositeSteps =
        Array.isArray(applyPayload.steps) && applyPayload.steps.length > 0;

      if (hasCompositeSteps) {
        if (typeof userStore?.applyCompositeBetMutations === 'function') {
          return userStore.applyCompositeBetMutations(userId, applyPayload);
        }
        return {
          ok: false,
          error: 'composite_apply_requires_atomic_store_support',
          message:
            'El userStore actual no soporta applyCompositeBetMutations; se bloquea para no romper all_or_nothing.',
        };
      }

      if (typeof userStore?.applyBetMutation !== 'function') {
        return {
          ok: false,
          error: 'userStore no soporta applyBetMutation.',
        };
      }

      return userStore.applyBetMutation(userId, applyPayload);
    };

    if (userId && (userStore?.applyBetMutation || userStore?.applyCompositeBetMutations)) {
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

            const descriptors = extractMutationDescriptors(entry.payload);
            let hasSpecificHint = false;

            if (confirmationIntent.wantsArchive) {
              hasSpecificHint = true;
              if (descriptors.some((item) => item.operation === 'archive')) {
                return true;
              }
            }

            if (confirmationIntent.wantsSetPending) {
              hasSpecificHint = true;
              if (descriptors.some((item) => item.operation === 'set_pending')) {
                return true;
              }
            }

            if (confirmationIntent.wantsSettle || confirmationIntent.settleResult) {
              hasSpecificHint = true;
              const hasMatchingSettle = descriptors.some((item) => {
                if (item.operation !== 'settle') return false;
                if (!confirmationIntent.settleResult) return true;
                return item.result === confirmationIntent.settleResult;
              });
              if (hasMatchingSettle) return true;
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
          const applied = applyMutationPayload(entry.payload, {
            confirmationToken: entry.token,
            confirmationSource: 'user_confirm_message',
          });
          outcomes.push({
            token: entry.token,
            operationLabel: formatMutationPayloadLabel(entry.payload),
            applied,
          });
        }

        const success = outcomes.filter((item) => item.applied?.ok);
        const failed = outcomes.filter((item) => !item.applied?.ok);
        const lines = [];

        if (success.length) {
          lines.push(`✅ Confirmación aplicada: ${success.length} mutación(es).`);
          for (const item of success) {
            const count = Number(item.applied?.affectedCount) || 0;
            lines.push(`- ${item.operationLabel} (${item.token}): ${count} apuesta(s) afectada(s).`);
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
              `- ${item.operationLabel} (${item.token}): ${
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

    if (
      userId &&
      wantsFightResultLookup &&
      isLedgerMutationIntentMessage(originalMessage) &&
      isBulkSettlementReviewRequest(originalMessage) &&
      userStore?.listUserBets
    ) {
      const pendingBets = userStore.listUserBets(userId, {
        status: 'pending',
        includeArchived: false,
        limit: 120,
      });
      if (!Array.isArray(pendingBets) || !pendingBets.length) {
        return {
          reply: 'No tenes apuestas pendientes para cerrar en este momento.',
          metadata: {
            resolvedFight: runtimeState.resolvedFight,
            eventCard: runtimeState.eventCard,
          },
        };
      }

      if (typeof userStore?.applyCompositeBetMutations !== 'function') {
        return {
          reply:
            'No puedo preparar un cierre masivo seguro en este entorno porque falta soporte transaccional compuesto.',
          metadata: {
            resolvedFight: runtimeState.resolvedFight,
            eventCard: runtimeState.eventCard,
          },
        };
      }

      if (typeof fightsScalper?.getFighterHistory !== 'function') {
        return {
          reply:
            'No tengo disponible el modulo de verificacion de resultados en este entorno. Pasame bet_id + resultado y lo cierro manualmente.',
          metadata: {
            resolvedFight: runtimeState.resolvedFight,
            eventCard: runtimeState.eventCard,
          },
        };
      }

      const fighterPool = collectUniqueFightersFromBets(pendingBets);
      let historyRows = [];
      try {
        const history = await fightsScalper.getFighterHistory({
          message: fighterPool.join(' vs '),
          fighters: fighterPool,
          strict: false,
        });
        historyRows = Array.isArray(history?.rows) ? history.rows : [];
      } catch (error) {
        console.error('⚠️ bulk settle history lookup failed:', error);
      }

      const settlements = [];
      const unresolved = [];
      for (const bet of pendingBets) {
        const settlement = resolveAutoSettlementCandidate(
          {
            id: bet?.id,
            fight: bet?.fight,
            pick: bet?.pick,
          },
          historyRows
        );

        if (!settlement || settlement.confidence !== 'high') {
          unresolved.push({
            bet,
            reason: 'without_verified_result',
          });
          continue;
        }

        const matchedDate = toIsoDateSafe(settlement?.matchedRow?.date || '');
        const betRecordedDate = toIsoDateSafe(
          bet?.recordedAt || bet?.createdAt || bet?.updatedAt || ''
        );
        if (matchedDate && betRecordedDate) {
          const deltaVsRecorded = dateDiffInDays(matchedDate, betRecordedDate);
          if (Number.isFinite(deltaVsRecorded) && deltaVsRecorded < -3) {
            unresolved.push({
              bet,
              reason: 'matched_result_precedes_bet',
            });
            continue;
          }
        }

        settlements.push({
          bet,
          settlement,
        });
      }

      if (!settlements.length) {
        return {
          reply: [
            'No pude verificar con confianza el resultado de tus apuestas pendientes en este turno.',
            'No voy a cerrarlas como ganadas sin evidencia por pelea.',
            'Si queres, pasame winner/method por bet_id y las cierro al toque.',
          ].join('\n'),
          metadata: {
            resolvedFight: runtimeState.resolvedFight,
            eventCard: runtimeState.eventCard,
          },
        };
      }

      const maxSteps = 12;
      const selectedSettlements = settlements.slice(0, maxSteps);
      const omittedByLimit = Math.max(0, settlements.length - selectedSettlements.length);
      const compositePayload = {
        transactionPolicy: 'all_or_nothing',
        steps: selectedSettlements.map(({ bet, settlement }) => ({
          operation: 'settle',
          result: settlement.result,
          betIds: [Number(bet.id)],
          reason: 'verified_pending_result',
        })),
        metadata: {
          source: 'bulk_verified_settlement',
          reason: 'verified_pending_results',
          chatId,
          originalMessage: truncateText(originalMessage, 300),
        },
      };

      if (typeof userStore?.previewCompositeBetMutations === 'function') {
        const preview = userStore.previewCompositeBetMutations(userId, compositePayload);
        if (!preview?.ok) {
          return {
            reply: `No pude preparar el cierre verificado: ${preview?.error || 'preview_failed'}.`,
            metadata: {
              resolvedFight: runtimeState.resolvedFight,
              eventCard: runtimeState.eventCard,
            },
          };
        }
      }

      const mutationScope = mutationScopeKey({ chatId, userId });
      const confirmationToken = savePendingMutation(mutationScope, {
        payload: compositePayload,
      });
      const winCount = selectedSettlements.filter(
        (entry) => String(entry?.settlement?.result || '') === 'win'
      ).length;
      const lossCount = selectedSettlements.filter(
        (entry) => String(entry?.settlement?.result || '') === 'loss'
      ).length;

      const lines = [
        'Revision completa: no voy a cerrar todo como ganado sin validar pelea por pelea.',
        `- Verificadas para cierre: ${selectedSettlements.length} (WIN ${winCount} / LOSS ${lossCount}).`,
      ];
      if (omittedByLimit > 0) {
        lines.push(`- Omitidas por limite operativo (${maxSteps}): ${omittedByLimit}.`);
      }
      if (unresolved.length) {
        lines.push(`- Sin evidencia suficiente en este turno: ${unresolved.length}.`);
      }

      lines.push('', 'Propuesta de cierre verificado:');
      for (const entry of selectedSettlements.slice(0, 8)) {
        const bet = entry.bet || {};
        const settlement = entry.settlement || {};
        const sourceWinner = settlement?.matchedRow?.winner || 'N/D';
        const sourceMethod = settlement?.matchedRow?.method || 'metodo N/D';
        const sourceDate = settlement?.matchedRow?.date || 'fecha N/D';
        lines.push(
          `- bet_id ${bet.id}: ${String(settlement.result || '').toUpperCase()} | ${bet.fight || 'Pelea N/D'} | ${bet.pick || 'Pick N/D'} | fuente ${sourceDate} (${sourceWinner}, ${sourceMethod})`
        );
      }
      if (selectedSettlements.length > 8) {
        lines.push(`- ... y ${selectedSettlements.length - 8} apuesta(s) mas.`);
      }
      if (unresolved.length) {
        lines.push('', 'Pendientes sin verificacion automatica (siguen OPEN):');
        for (const item of unresolved.slice(0, 6)) {
          const bet = item?.bet || {};
          lines.push(`- bet_id ${bet.id || 'N/D'}: ${bet.fight || 'Pelea N/D'} | ${bet.pick || 'Pick N/D'}`);
        }
        if (unresolved.length > 6) {
          lines.push(`- ... y ${unresolved.length - 6} apuesta(s) mas sin verificar.`);
        }
      }

      lines.push(
        '',
        `Si queres ejecutarlo, confirma con: "confirmo ${confirmationToken}"`,
        'Se aplicara en modo all_or_nothing solo sobre las apuestas verificadas.'
      );

      return {
        reply: lines.join('\n'),
        metadata: {
          resolvedFight: runtimeState.resolvedFight,
          eventCard: runtimeState.eventCard,
        },
      };
    }

    if (wantsFightResultLookup && !isLedgerMutationIntentMessage(originalMessage)) {
      const pendingBetsForReference =
        userId && userStore?.listUserBets
          ? userStore.listUserBets(userId, {
              status: 'pending',
              includeArchived: false,
              limit: 60,
            })
          : [];
      const fightRef = inferResultFightReference({
        originalMessage,
        resolution,
        pendingBets: pendingBetsForReference,
      });

      if (typeof userStore?.refreshLiveScores === 'function') {
        try {
          await userStore.refreshLiveScores({
            force: true,
            daysFrom: 3,
          });
        } catch (error) {
          console.error('⚠️ refreshLiveScores failed:', error);
        }
      }

      const now = Date.now();
      const recentEvents =
        typeof userStore?.listRecentOddsEvents === 'function'
          ? userStore.listRecentOddsEvents({
              fromIso: new Date(now - 10 * 24 * 3600000).toISOString(),
              toIso: new Date(now + 2 * 24 * 3600000).toISOString(),
              limit: 160,
            })
          : [];

      let bestEvent = null;
      let bestScore = 0;
      if (fightRef?.fighterA && fightRef?.fighterB) {
        const refFight = `${fightRef.fighterA} vs ${fightRef.fighterB}`;
        for (const event of recentEvents) {
          const eventFight = `${event?.homeTeam || ''} vs ${event?.awayTeam || ''}`.trim();
          if (!eventFight || eventFight === 'vs') continue;
          const score = fightSimilarityScore(refFight, eventFight);
          if (score > bestScore) {
            bestScore = score;
            bestEvent = event;
          }
        }
      } else if (recentEvents.length === 1) {
        bestEvent = recentEvents[0];
        bestScore = 1;
      }

      if (bestEvent && bestScore >= 0.66) {
        const winnerInfo = pickWinnerFromScores(bestEvent.scores || []);
        const lines = ['📡 Resultado de pelea (fuente live prioritaria)'];
        if (bestEvent.eventName) {
          lines.push(`Evento: ${bestEvent.eventName}`);
        }
        lines.push(
          `Pelea: ${bestEvent.homeTeam || 'N/D'} vs ${bestEvent.awayTeam || 'N/D'}`
        );
        if (bestEvent.commenceTime) {
          lines.push(
            `Fecha estimada: ${formatEventDateLabel(
              bestEvent.commenceTime,
              temporalContext.timezone
            )}`
          );
        }

        if (bestEvent.completed) {
          if (winnerInfo.winner) {
            lines.push(`Resultado: ganó ${winnerInfo.winner}.`);
          } else if (winnerInfo.isDraw) {
            lines.push('Resultado: empate/draw.');
          } else {
            lines.push('Resultado: finalizada, pero sin ganador legible en feed de scores.');
          }
        } else {
          lines.push('Estado: todavía no figura finalizada en el feed live.');
        }

        if (winnerInfo.scoreLine) {
          lines.push(`Score reportado: ${winnerInfo.scoreLine}`);
        }
        if (bestEvent.lastScoresSyncAt) {
          lines.push(
            `Última sync scores: ${formatIsoForUser(
              bestEvent.lastScoresSyncAt,
              temporalContext.timezone
            )}`
          );
        }

        return {
          reply: lines.join('\n'),
          metadata: {
            resolvedFight: runtimeState.resolvedFight,
            eventCard: runtimeState.eventCard,
          },
        };
      }

      if (
        fightRef?.fighterA &&
        fightRef?.fighterB &&
        typeof fightsScalper?.getFighterHistory === 'function'
      ) {
        try {
          const history = await fightsScalper.getFighterHistory({
            message: `${fightRef.fighterA} vs ${fightRef.fighterB}`,
            fighters: [fightRef.fighterA, fightRef.fighterB],
            strict: false,
          });
          const latest = findLatestHistoryResultForFight(history?.rows || [], fightRef);
          if (latest?.winner) {
            const lines = [
              '📚 Resultado encontrado en historial local (fallback).',
              `Pelea: ${latest.fighterA || fightRef.fighterA} vs ${latest.fighterB || fightRef.fighterB}`,
              `Ganador: ${latest.winner}`,
            ];
            if (latest.method) lines.push(`Método: ${latest.method}`);
            if (latest.date) lines.push(`Fecha: ${latest.date}`);
            return {
              reply: lines.join('\n'),
              metadata: {
                resolvedFight: runtimeState.resolvedFight,
                eventCard: runtimeState.eventCard,
              },
            };
          }
        } catch (error) {
          console.error('⚠️ local history result lookup failed:', error);
        }
      }

      const lines = [
        'No encontré un resultado live confirmado para esa pelea ahora mismo.',
      ];
      if (fightRef?.fighterA && fightRef?.fighterB) {
        lines.push(`Referencia usada: ${fightRef.fighterA} vs ${fightRef.fighterB}.`);
      }
      lines.push(
        'Si querés, pasame el winner exacto y te ayudo a cerrar el ledger al toque.'
      );
      return {
        reply: lines.join('\n'),
        metadata: {
          resolvedFight: runtimeState.resolvedFight,
          eventCard: runtimeState.eventCard,
        },
      };
    }

    const turnToolEffects = {
      hasOperationalLedgerToolCall: false,
      hasLedgerCreateReceipt: false,
      hasLedgerMutationReceipt: false,
      historyRowCount: 0,
      historyLatestFightDate: null,
      usedWebSearch: false,
      citationsCount: 0,
    };

    const runMutateUserBets = async (rawArgs = {}, { fromLegacyRecordTool = false } = {}) => {
      turnToolEffects.hasOperationalLedgerToolCall = true;
      if (!userId) {
        return { ok: false, error: 'userId no disponible para mutaciones de apuestas.' };
      }
      const hasPreviewSupport = Boolean(
        userStore?.previewBetMutation || userStore?.previewCompositeBetMutations
      );
      const hasApplySupport = Boolean(
        userStore?.applyBetMutation || userStore?.applyCompositeBetMutations
      );
      if (!hasPreviewSupport || !hasApplySupport) {
        return {
          ok: false,
          error: 'userStore no soporta preview/apply para mutaciones de apuestas.',
        };
      }

      const confirm = rawArgs.confirm === true;
      const confirmationToken = String(rawArgs.confirmationToken || '').trim();
      const transactionPolicy = String(rawArgs.transactionPolicy || 'all_or_nothing')
        .trim()
        .toLowerCase();
      const normalizeMutationResponse = (applied = {}, fallbackOperation = null) => {
        const hasStepResults =
          Array.isArray(applied.stepResults) && applied.stepResults.length > 0;
        const operation = hasStepResults
          ? 'composite'
          : applied.operation || fallbackOperation || null;
        const receipts = Array.isArray(applied.receipts) ? applied.receipts : [];

        return {
          operation,
          transactionPolicy: hasStepResults
            ? applied.transactionPolicy || transactionPolicy || null
            : null,
          affectedCount: Number(applied.affectedCount) || receipts.length,
          stepResults: hasStepResults ? applied.stepResults : undefined,
          receipts,
        };
      };

      const rawSteps = Array.isArray(rawArgs.steps)
        ? rawArgs.steps
            .map((step) => (step && typeof step === 'object' ? step : null))
            .filter(Boolean)
        : [];
      const inferredFightFromContext = resolvedFightLabel(
        runtimeState.resolvedFight || resolution?.resolvedFight || null
      );
      const fightNotStartedSignals = /\b(no empezo|no empezó|todavia no empezo|todavía no empezó|aun no empezo|aún no empezó)\b/i;
      const ambiguousReference = hasAmbiguousFightReference(originalMessage);
      const buildMutationPayload = (stepArgs = {}, { stepIndex = null, allowInferredIds = true } = {}) => {
        const operation = String(stepArgs.operation || '')
          .trim()
          .toLowerCase();
        const normalizedResult = normalizeBetResult(stepArgs.result);
        const explicitBetIds = parseBetIds(stepArgs.betIds);
        const inferredBetIds =
          allowInferredIds && explicitBetIds.length === 0
            ? extractBetIdsFromMessage(originalMessage)
            : [];
        const betIds = explicitBetIds.length ? explicitBetIds : inferredBetIds;
        const explicitEventName = stepArgs.eventName ? String(stepArgs.eventName).trim() : '';
        const explicitFight = stepArgs.fight ? String(stepArgs.fight).trim() : '';
        const explicitPick = stepArgs.pick ? String(stepArgs.pick).trim() : '';
        const payload = {
          operation,
          result: normalizedResult || undefined,
          betIds: betIds.length ? betIds : undefined,
          eventName: explicitEventName || undefined,
          fight: explicitFight || undefined,
          pick: explicitPick || undefined,
          limit: Number.isFinite(Number(stepArgs.limit)) ? Number(stepArgs.limit) : undefined,
          metadata: {
            source: fromLegacyRecordTool ? 'legacy_record_user_bet' : 'mutate_user_bets',
            reason: stepArgs.reason ? String(stepArgs.reason).trim() : null,
            isDestructive: operation === 'archive' || operation === 'settle',
            chatId,
            originalMessage: truncateText(originalMessage, 300),
            selector: {
              usedExplicitBetIds: explicitBetIds.length > 0,
              usedBetIdsFromMessage: explicitBetIds.length === 0 && inferredBetIds.length > 0,
              usedExplicitFight: Boolean(explicitFight),
              usedExplicitEventName: Boolean(explicitEventName),
              usedExplicitPick: Boolean(explicitPick),
            },
            ...(Number.isInteger(stepIndex) ? { compositeStepIndex: stepIndex } : {}),
          },
        };

        return {
          payload,
          operation,
          normalizedResult,
          explicitBetIds,
          betIds,
          explicitEventName,
          explicitFight,
          explicitPick,
        };
      };
      const validateMutationSelection = (details, { stepIndex = null } = {}) => {
        const {
          operation,
          normalizedResult,
          explicitBetIds,
          betIds,
          explicitEventName,
          explicitFight,
          explicitPick,
        } = details || {};
        const stepContext = Number.isInteger(stepIndex)
          ? { stepIndex, failedStepIndex: stepIndex }
          : {};

        if (!['settle', 'set_pending', 'archive'].includes(operation)) {
          return {
            ok: false,
            error: 'invalid_operation',
            ...stepContext,
          };
        }

        if (operation === 'settle' && !normalizedResult) {
          return {
            ok: false,
            error: 'settle_requires_result',
            ...stepContext,
          };
        }

        if (operation === 'settle' && fightNotStartedSignals.test(originalMessage)) {
          return {
            ok: false,
            error: 'fight_not_finished_guard',
            message:
              'No se puede cerrar WON/LOST una pelea marcada como no iniciada. Confirmá el resultado al finalizar.',
            ...stepContext,
          };
        }

        if (
          (operation === 'settle' || operation === 'set_pending') &&
          ambiguousReference &&
          !explicitBetIds.length &&
          !explicitFight &&
          !explicitEventName &&
          !explicitPick
        ) {
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
              'La referencia de pelea es ambigua (ej: "anterior/esa"). Pasame el bet_id exacto o confirmá la pelea exacta antes de mutar el ledger.',
            ...stepContext,
          };
        }

        const hasStrongSelector =
          betIds.length > 0 ||
          Boolean(explicitEventName) ||
          Boolean(explicitFight) ||
          Boolean(explicitPick);
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
            ...stepContext,
          };
        }

        if (
          (operation === 'settle' || operation === 'archive' || operation === 'set_pending') &&
          !explicitBetIds.length &&
          !betIds.length &&
          !explicitFight &&
          inferredFightFromContext
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
            error: 'context_fight_requires_explicit_selector',
            requiresDisambiguation: true,
            candidates,
            message:
              'Para evitar cerrar la pelea equivocada, necesito selector explícito del usuario (bet_id o pelea exacta) y no solo contexto previo.',
            ...stepContext,
          };
        }

        return { ok: true };
      };

      if (rawSteps.length) {
        if (typeof userStore?.applyCompositeBetMutations !== 'function') {
          return {
            ok: false,
            error: 'composite_apply_requires_atomic_store_support',
            message:
              'El userStore actual no soporta applyCompositeBetMutations; se bloquea para no romper all_or_nothing.',
          };
        }
        if (transactionPolicy !== 'all_or_nothing') {
          return {
            ok: false,
            error: 'invalid_transaction_policy',
            message: 'Por ahora solo está soportado transactionPolicy=all_or_nothing.',
          };
        }
        if (rawSteps.length > 12) {
          return {
            ok: false,
            error: 'too_many_steps',
            maxSteps: 12,
          };
        }

        const steps = [];
        for (const [index, rawStep] of rawSteps.entries()) {
          const details = buildMutationPayload(rawStep, {
            stepIndex: index,
            allowInferredIds: false,
          });
          const validation = validateMutationSelection(details, { stepIndex: index });
          if (!validation?.ok) {
            return validation;
          }
          steps.push({
            ...details.payload,
            metadata: {
              ...(details.payload.metadata || {}),
              transactionPolicy,
            },
          });
        }

        const compositePayload = {
          transactionPolicy,
          steps,
          metadata: {
            source: fromLegacyRecordTool ? 'legacy_record_user_bet' : 'mutate_user_bets',
            reason: rawArgs.reason ? String(rawArgs.reason).trim() : null,
            isDestructive: steps.some(
              (step) => step.operation === 'archive' || step.operation === 'settle'
            ),
            chatId,
            originalMessage: truncateText(originalMessage, 300),
            composite: true,
          },
        };
        const previewCompositeMutation = () => {
          if (typeof userStore?.previewCompositeBetMutations === 'function') {
            return userStore.previewCompositeBetMutations(userId, compositePayload);
          }
          if (typeof userStore?.previewBetMutation !== 'function') {
            return {
              ok: false,
              error: 'userStore no soporta previewBetMutation para fallback de lote.',
            };
          }

          const stepResults = [];
          let requiresConfirmation = false;
          for (const [index, stepPayload] of compositePayload.steps.entries()) {
            const previewStep = userStore.previewBetMutation(userId, stepPayload);
            if (!previewStep?.ok) {
              stepResults.push({
                index,
                ok: false,
                operation: String(stepPayload.operation || ''),
                result: normalizeBetResult(stepPayload.result),
                error: previewStep?.error || 'step_preview_failed',
              });
              return {
                ok: false,
                error: 'composite_preview_failed',
                failedStepIndex: index,
                stepResults,
                transactionPolicy,
              };
            }

            const result = {
              index,
              ok: true,
              operation: previewStep.operation,
              result: previewStep.result || null,
              requiresConfirmation: Boolean(previewStep.requiresConfirmation),
              confirmationReason: previewStep.confirmationReason || null,
              candidateCount: previewStep.candidates?.length || 0,
              candidates: previewStep.candidates || [],
            };
            stepResults.push(result);
            requiresConfirmation = requiresConfirmation || result.requiresConfirmation;
          }

          return {
            ok: true,
            transactionPolicy,
            requiresConfirmation,
            stepResults,
          };
        };

        if (confirm) {
          let pending = null;
          if (confirmationToken) {
            pending = consumePendingMutation(mutationScope, confirmationToken);
          } else {
            const pendingByScope = getPendingMutationsForScope(mutationScope);
            const matching = pendingByScope.filter((entry) => {
              const entrySteps = Array.isArray(entry.payload?.steps) ? entry.payload.steps : [];
              return (
                entrySteps.length === compositePayload.steps.length &&
                String(entry.payload?.transactionPolicy || 'all_or_nothing') === transactionPolicy
              );
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
                operation: formatMutationPayloadLabel(entry.payload),
              })),
            };
          }

          const applied = applyMutationPayload(pending.payload, {
            confirmationToken: confirmationToken || pending.token,
            confirmationSource: 'tool_confirm_flag',
          });
          if (!applied?.ok) {
            return applied;
          }
          turnToolEffects.hasLedgerMutationReceipt = true;
          const receipt = normalizeMutationResponse(applied, 'composite');

          return {
            ok: true,
            mutationReceipt: receipt,
            ledgerSummary: applied.ledgerSummary || null,
          };
        }

        const preview = previewCompositeMutation();
        if (!preview?.ok) {
          return preview;
        }

        if (preview.requiresConfirmation) {
          const token = savePendingMutation(mutationScope, { payload: compositePayload });
          const firstReason = (preview.stepResults || []).find(
            (item) => item?.requiresConfirmation && item?.confirmationReason
          );
          const reasonMessage = firstReason
            ? formatConfirmationReason(firstReason.confirmationReason)
            : 'Mutación compuesta sensible detectada.';
          return {
            ok: false,
            requiresConfirmation: true,
            confirmationToken: token,
            preview: {
              operation: 'composite',
              transactionPolicy,
              stepResults: preview.stepResults || [],
            },
            message: `${reasonMessage} Pedi confirmacion explicita del usuario y luego reintenta con confirm=true + confirmationToken.`,
          };
        }

        const applied = applyMutationPayload(compositePayload, {
          confirmationSource: 'tool_auto_apply',
        });
        if (!applied?.ok) {
          return applied;
        }
        turnToolEffects.hasLedgerMutationReceipt = true;
        const receipt = normalizeMutationResponse(applied, 'composite');

        return {
          ok: true,
          mutationReceipt: receipt,
          ledgerSummary: applied.ledgerSummary || null,
        };
      }

      const singleMutation = buildMutationPayload(rawArgs, {
        allowInferredIds: true,
      });
      const {
        operation,
        normalizedResult,
        explicitBetIds,
        betIds,
        explicitEventName,
        explicitFight,
        explicitPick,
      } = singleMutation;
      const canUseFuzzyFightRecovery = Boolean(explicitFight);
      let payload = singleMutation.payload;

      const validation = validateMutationSelection(singleMutation);
      if (!validation?.ok) {
        return validation;
      }

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
              operation: formatMutationPayloadLabel(entry.payload),
            })),
          };
        }

        const applied = applyMutationPayload(pending.payload, {
          confirmationToken: confirmationToken || pending.token,
          confirmationSource: 'tool_confirm_flag',
        });
        if (!applied?.ok) {
          return applied;
        }
        turnToolEffects.hasLedgerMutationReceipt = true;
        const receipt = normalizeMutationResponse(applied, operation);

        return {
          ok: true,
          mutationReceipt: receipt,
          ledgerSummary: applied.ledgerSummary || null,
        };
      }

      let preview = userStore.previewBetMutation(userId, payload);
      if (
        !preview?.ok &&
        preview?.error === 'no_matching_bets' &&
        !betIds.length &&
        canUseFuzzyFightRecovery &&
        payload.fight &&
        typeof userStore?.listUserBets === 'function' &&
        (operation === 'settle' || operation === 'archive' || operation === 'set_pending')
      ) {
        const fuzzyPool = userStore.listUserBets(userId, {
          status: operation === 'settle' ? 'pending' : null,
          includeArchived: false,
          limit: 80,
          eventName: payload.eventName || null,
          pick: payload.pick || null,
        });
        const fuzzySelection = resolveFuzzyBetSelection({
          queryFight: payload.fight,
          queryEventName: payload.eventName || '',
          queryPick: payload.pick || '',
          candidates: fuzzyPool,
        });

        if (fuzzySelection?.ambiguous) {
          return {
            ok: false,
            error: 'ambiguous_fuzzy_match',
            requiresDisambiguation: true,
            candidates: fuzzySelection.candidates || [],
            message:
              'Encontré más de una apuesta parecida para esa pelea. Pasame el bet_id exacto y lo cierro sin riesgo.',
          };
        }

        if (fuzzySelection?.betId) {
          payload = {
            ...payload,
            betIds: [fuzzySelection.betId],
            metadata: {
              ...(payload.metadata || {}),
              fuzzyMatch: {
                requestedFight: payload.fight,
                matchedFight: fuzzySelection.fight,
                matchScore: fuzzySelection.score,
              },
            },
          };
          preview = userStore.previewBetMutation(userId, payload);
        }
      }

      if (!preview?.ok) {
        return preview;
      }

      if (preview.requiresConfirmation) {
        const token = savePendingMutation(mutationScope, { payload });
        const reasonMessage = formatConfirmationReason(preview.confirmationReason);
        return {
          ok: false,
          requiresConfirmation: true,
          confirmationToken: token,
          preview: {
            operation: preview.operation,
            result: preview.result || null,
            candidateCount: preview.candidates?.length || 0,
            candidates: preview.candidates || [],
            confirmationReason: preview.confirmationReason || null,
          },
          message: `${reasonMessage} Pedi confirmacion explicita del usuario y luego reintenta con confirm=true + confirmationToken.`,
        };
      }

      const applied = applyMutationPayload(payload, {
        confirmationSource: 'tool_auto_apply',
      });
      if (!applied?.ok) {
        return applied;
      }
      turnToolEffects.hasLedgerMutationReceipt = true;
      const receipt = normalizeMutationResponse(applied, operation);

      return {
        ok: true,
        mutationReceipt: receipt,
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
          const historyToolResult = buildHistoryToolResult(result, cacheStatus);
          turnToolEffects.historyRowCount = Number(historyToolResult.rowCount) || 0;
          turnToolEffects.historyLatestFightDate =
            historyToolResult.latestFightDate || null;

          return historyToolResult;
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
          turnToolEffects.hasOperationalLedgerToolCall = true;
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

          let record = {
            eventName: args.eventName ? String(args.eventName).trim() : null,
            fight: args.fight ? String(args.fight).trim() : null,
            pick: args.pick ? String(args.pick).trim() : null,
            odds: toNumberFlexible(args.odds),
            stake: toNumberFlexible(args.stake),
            units: toNumberFlexible(args.units),
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

          let mediaExtraction = null;
          const missingBefore = missingRequiredRecordFields(record);
          if (missingBefore.length && hasImageInputItems(context.inputItems)) {
            mediaExtraction = await extractBetRecordFromMedia({
              client,
              model: DECISION_MODEL || MODEL,
              originalMessage,
              inputItems: context.inputItems,
            });
            if (mediaExtraction?.ok && mediaExtraction.extracted) {
              record = mergeBetRecord(record, mediaExtraction.extracted);
            }
          }

          const missingRequired = missingRequiredRecordFields(record);
          if (missingRequired.length) {
            return {
              ok: false,
              error: 'missing_required_fields_for_record_user_bet',
              missingFields: missingRequired,
              message:
                'Para registrar una apuesta nueva necesito: pelea, pick, cuota y stake (monto).',
              extractedFromMedia: Boolean(mediaExtraction?.ok),
            };
          }

          const stored = userStore.addBetRecord(userId, record);
          turnToolEffects.hasLedgerCreateReceipt = true;
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
          turnToolEffects.hasOperationalLedgerToolCall = true;
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
          turnToolEffects.hasOperationalLedgerToolCall = true;
          if (!userId) {
            return { ok: false, error: 'userId no disponible para undo.' };
          }
          if (!userStore?.undoLastBetMutation) {
            return {
              ok: false,
              error: 'userStore no soporta undoLastBetMutation.',
            };
          }
          const undone = userStore.undoLastBetMutation(userId, {
            windowMinutes: Number.isFinite(Number(args.windowMinutes))
              ? Number(args.windowMinutes)
              : undefined,
          });
          if (undone?.ok) {
            turnToolEffects.hasLedgerMutationReceipt = true;
          }
          return undone;
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

      let precomputedEventProjections = [];
      let precomputedFightProjection = null;
      let precomputedEventBetScoring = [];
      let precomputedFightBetScoring = [];
      const decisionEventState = wantsBetDecision
        ? userStore?.getEventWatchState?.('next_event')
        : null;
      if (
        wantsBetDecision &&
        typeof userStore?.listLatestProjectionSnapshotsForEvent === 'function'
      ) {
        if (decisionEventState?.eventId) {
          precomputedEventProjections =
            userStore.listLatestProjectionSnapshotsForEvent({
              eventId: decisionEventState.eventId,
              limit: 20,
              latestPerFight: true,
            }) || [];
          if (resolution?.resolvedFight) {
            precomputedFightProjection =
              precomputedEventProjections.find((snapshot) =>
                projectionSnapshotMatchesFight(snapshot, resolution.resolvedFight)
              ) || null;
          }
        }
      }

      if (
        wantsBetDecision &&
        decisionEventState?.eventId &&
        typeof userStore?.listLatestBetScoringForEvent === 'function'
      ) {
        precomputedEventBetScoring =
          userStore.listLatestBetScoringForEvent({
            eventId: decisionEventState.eventId,
            limit: 80,
            latestPerFightMarket: true,
          }) || [];

        if (resolution?.resolvedFight) {
          precomputedFightBetScoring = precomputedEventBetScoring.filter((snapshot) =>
            projectionSnapshotMatchesFight(snapshot, resolution.resolvedFight)
          );
        }
      }

      let cachedFightOddsConsensus = null;
      if (
        wantsBetDecision &&
        resolution?.resolvedFight?.fighterA &&
        resolution?.resolvedFight?.fighterB &&
        typeof userStore?.listLatestOddsMarketsForFight === 'function'
      ) {
        const oddsRows = userStore.listLatestOddsMarketsForFight({
          fighterA: resolution.resolvedFight.fighterA,
          fighterB: resolution.resolvedFight.fighterB,
          marketKey: 'h2h',
          limit: 60,
          maxAgeHours: 96,
        });
        const consensus = buildOddsConsensusForFight({
          rows: oddsRows,
          fighterA: resolution.resolvedFight.fighterA,
          fighterB: resolution.resolvedFight.fighterB,
        });
        if (consensus) {
          cachedFightOddsConsensus = {
            fight: `${resolution.resolvedFight.fighterA} vs ${resolution.resolvedFight.fighterB}`,
            bookmakersCount: consensus.bookmakersCount,
            avgPriceA: Number(consensus.avgPriceA.toFixed(3)),
            avgPriceB: Number(consensus.avgPriceB.toFixed(3)),
            impliedA: consensus.impliedA ? Number(consensus.impliedA.toFixed(2)) : null,
            impliedB: consensus.impliedB ? Number(consensus.impliedB.toFixed(2)) : null,
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

      if (wantsBetDecision && precomputedFightProjection) {
        extraSections.push(
          '[PRECOMPUTED_PROJECTION]',
          JSON.stringify(precomputedFightProjection, null, 2)
        );
      } else if (wantsBetDecision && precomputedEventProjections.length) {
        extraSections.push(
          '[PRECOMPUTED_EVENT_PROJECTIONS]',
          JSON.stringify(precomputedEventProjections.slice(0, 8), null, 2)
        );
      }

      if (wantsBetDecision && cachedFightOddsConsensus) {
        extraSections.push(
          '[CACHED_ODDS_CONSENSUS]',
          JSON.stringify(cachedFightOddsConsensus, null, 2)
        );
      }

      if (wantsBetDecision && precomputedFightBetScoring.length) {
        extraSections.push(
          '[PRECOMPUTED_BET_SCORING]',
          JSON.stringify(precomputedFightBetScoring, null, 2)
        );
      } else if (wantsBetDecision && precomputedEventBetScoring.length) {
        extraSections.push(
          '[PRECOMPUTED_EVENT_BET_SCORING]',
          JSON.stringify(precomputedEventBetScoring.slice(0, 18), null, 2)
        );
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
      turnToolEffects.usedWebSearch = Boolean(result?.usedWebSearch);
      turnToolEffects.citationsCount = Array.isArray(result?.citations)
        ? result.citations.length
        : 0;

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

      let workingReply = reply;
      let committeeBlocked = false;
      let citations = Array.isArray(result.citations) ? result.citations : [];

      let latestOddsSnapshot = oddsSnapshot;
      if (
        wantsBetDecision &&
        userId &&
        typeof userStore?.getLatestOddsSnapshot === 'function'
      ) {
        const refreshed = userStore.getLatestOddsSnapshot(userId, {
          fighterA: resolution?.resolvedFight?.fighterA || null,
          fighterB: resolution?.resolvedFight?.fighterB || null,
        });
        if (refreshed) {
          latestOddsSnapshot = refreshed;
        }
      }
      let mediaOddsExtraction = null;
      if (wantsBetDecision && hasMedia && !hasConcreteOddsContext(originalMessage)) {
        mediaOddsExtraction = await extractMoneylineOddsFromMedia({
          client,
          model: modelToUse || MODEL,
          originalMessage,
          inputItems: mediaItems,
        });
      }

      if (
        shouldRunPickCommittee({
          enabled: PICK_COMMITTEE_ENABLED,
          wantsBetDecision,
          originalMessage,
          reply: workingReply,
        })
      ) {
        try {
          const news = await fetchRecentFightNewsBrief({
            client,
            message: originalMessage,
            temporalContext: temporalContext.sectionText,
            timezone: temporalContext.timezone,
            model: PICK_COMMITTEE_MODEL,
          });
          citations = mergeCitations(citations, news.citations);

          const pro = await runCommitteeAgent({
            client,
            model: PICK_COMMITTEE_MODEL,
            role: 'pro',
            userMessage: originalMessage,
            baseReply: workingReply,
            temporalContext: temporalContext.sectionText,
            newsBrief: news.brief,
          });

          const contra = await runCommitteeAgent({
            client,
            model: PICK_COMMITTEE_MODEL,
            role: 'contra',
            userMessage: originalMessage,
            baseReply: workingReply,
            temporalContext: temporalContext.sectionText,
            newsBrief: news.brief,
          });

          const outcome = buildCommitteeOutcome({
            pro,
            contra,
            minEdgePct: PICK_COMMITTEE_MIN_EDGE_PCT,
            minConfidence: PICK_COMMITTEE_MIN_CONFIDENCE,
          });

          const committeeFooter = renderCommitteeFooter(outcome);
          if (committeeFooter) {
            if (outcome?.approved === false) {
              committeeBlocked = true;
              workingReply = [
                'No la tomaría como apuesta ejecutable ahora mismo.',
                '',
                committeeFooter,
                '',
                'Si querés, te la reformulo como entrada condicional (qué tendría que pasar para entrar).',
              ].join('\n');
            } else {
              workingReply = `${workingReply}\n\n${committeeFooter}`;
            }
          }
        } catch (committeeError) {
          console.error('⚠️ Pick committee fallback (se mantiene analisis base):', committeeError);
        }
      }

      const citationFooter = shouldShowCitations(originalMessage)
        ? formatCitationsFooter(citations)
        : '';
      const replyWithDeterministicAdjustment = committeeBlocked
        ? workingReply
        : enforceDeterministicOddsAdjustment({
            reply: workingReply,
            originalMessage,
            wantsBetDecision,
            resolvedFight: resolution?.resolvedFight || runtimeState?.resolvedFight || null,
            precomputedFightBetScoring,
            oddsSnapshot: latestOddsSnapshot,
            mediaOddsExtraction,
          });
      const replyWithRationale = committeeBlocked
        ? replyWithDeterministicAdjustment
        : enforceRationaleSection(
            replyWithDeterministicAdjustment,
            originalMessage,
            turnToolEffects
          );
      const replyWithStakeCalibration = committeeBlocked
        ? replyWithRationale
        : enforceStakeCalibration(
            replyWithRationale,
            originalMessage,
            userProfile || {},
            turnToolEffects
          );
      const replyWithDecisionGate = committeeBlocked
        ? replyWithStakeCalibration
        : enforceDecisionQualityGate(
            replyWithStakeCalibration,
            originalMessage,
            turnToolEffects
          );
      const replyWithExposureGuard = enforceLedgerExposureContext(replyWithDecisionGate, {
        turnContext: turnToolEffects,
        userStore,
        userId,
      });
      const replyWithTemporalGuard = enforceCalendarNoEventContext(
        replyWithExposureGuard,
        originalMessage,
        temporalContext
      );
      const replyWithFactFreshness = enforceFactFreshnessGate(replyWithTemporalGuard, {
        originalMessage,
        temporalContext,
        turnContext: turnToolEffects,
        citations,
      });
      const replyWithContradiction = enforceContradictionHandler(replyWithFactFreshness, {
        originalMessage,
        temporalContext,
        turnContext: turnToolEffects,
      });
      const finalReply = enforceResponseConsistencyValidator(replyWithContradiction, {
        originalMessage,
        temporalContext,
        turnContext: turnToolEffects,
      });

      return {
        reply: `${finalReply}${citationFooter}`,
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
