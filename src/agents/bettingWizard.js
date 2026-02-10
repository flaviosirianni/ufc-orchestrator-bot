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
const WEB_SEARCH_TIMEZONE = process.env.WEB_SEARCH_TIMEZONE || null;
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
      'Guarda una apuesta previa del usuario para memoria de seguimiento (no ejecuta apuestas).',
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
    /\b(proximo|proxima|next|upcoming|que viene|siguiente|hoy|manana|mañana)\b/.test(text) ||
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

function buildPaywallMessage({ availableCredits, neededCredits }) {
  const lines = [];
  lines.push('⚠️ Te quedaste sin créditos suficientes para este análisis.');
  lines.push(`Créditos disponibles: ${availableCredits.toFixed(2)}`);
  lines.push(`Créditos necesarios: ${neededCredits.toFixed(2)}`);
  if (CREDIT_TOPUP_URL) {
    lines.push('', `Recargá créditos acá: ${CREDIT_TOPUP_URL}`);
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
    'Usa la memoria conversacional para referencias como pelea 1, esa pelea, bankroll y apuestas previas.',
    'No muestres tablas crudas de muchas filas salvo pedido explicito; sintetiza hallazgos relevantes.',
    'Si actualizas o detectas datos de perfil del usuario, persiste con update_user_profile.',
    'Si el usuario provee cuotas/odds de una sola pelea (texto o imagen), responde con formato estructurado: intro breve, separador, encabezado de pelea + cuotas recibidas, separador, "Lectura de la pelea" con bullets claros, separador, "Mi probabilidad estimada", separador, "EV (valor esperado)" con picks y EV, separador, "RECOMENDACIONES" (pick principal / valor / agresivo) con stake en unidades si hay unit_size, separador, "Que NO jugaria", separador, "Resumen rapido".',
    'Si el usuario provee cuotas de varias peleas, aplica el mismo formato por pelea (secciones repetidas) y al final agrega un "Resumen global" con los picks principales ordenados por solidez.',
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

function buildResponsesTools() {
  const tools = [
    {
      type: 'web_search',
      search_context_size: WEB_SEARCH_CONTEXT_SIZE,
      user_location: {
        type: 'approximate',
        country: WEB_SEARCH_COUNTRY,
        ...(WEB_SEARCH_REGION ? { region: WEB_SEARCH_REGION } : {}),
        ...(WEB_SEARCH_CITY ? { city: WEB_SEARCH_CITY } : {}),
        ...(WEB_SEARCH_TIMEZONE ? { timezone: WEB_SEARCH_TIMEZONE } : {}),
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

  async function handleMessage(message, context = {}) {
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

    if (userId && userStore) {
      if (userStore.getUserProfile) {
        const profile = userStore.getUserProfile(userId);
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

          const record = {
            eventName: args.eventName ? String(args.eventName).trim() : null,
            fight: args.fight ? String(args.fight).trim() : null,
            pick: args.pick ? String(args.pick).trim() : null,
            odds: toNumberOrNull(args.odds),
            stake: toNumberOrNull(args.stake),
            units: toNumberOrNull(args.units),
            result: args.result ? String(args.result).trim() : null,
            notes: args.notes ? truncateText(String(args.notes), 240) : null,
          };

          const stored = userStore.addBetRecord(userId, record);
          return {
            ok: true,
            record: stored,
          };
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
        recentTurns,
        hasMedia,
        extraSections,
      });

      const tools = buildResponsesTools();

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

      return {
        reply: `${reply}${citationFooter}`,
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
