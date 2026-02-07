import fs from 'node:fs';
import path from 'node:path';
import OpenAI from 'openai';
import '../core/env.js';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.BETTING_MODEL || 'gpt-4.1-mini';
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

const INCLUDE_FIELDS = ['web_search_call.action.sources'];

const FUNCTION_TOOLS = [
  {
    type: 'function',
    name: 'get_fighter_history',
    description:
      'Obtiene historial local de peleas desde cache sincronizado del Google Sheet (Fight History).',
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
    temperature: TEMPERATURE,
    knowledgeFile: RESOLVED_KNOWLEDGE_PATH,
    knowledgeExists: fs.existsSync(RESOLVED_KNOWLEDGE_PATH),
    hasOpenAIKey: Boolean(OPENAI_API_KEY),
    maxRecentTurns: MAX_RECENT_TURNS,
    maxToolRounds: MAX_TOOL_ROUNDS,
    usesResponsesAPI: true,
    webSearchContextSize: WEB_SEARCH_CONTEXT_SIZE,
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

  return lines.join('\n');
}

function buildSystemPrompt(knowledgeSnippet = '') {
  const today = new Date().toISOString().slice(0, 10);
  const rules = [
    'Sos un analista UFC conversacional en espanol, natural y concreto.',
    `Fecha de referencia actual: ${today}.`,
    'Objetivo principal: dar respuestas coherentes entre turnos y aprovechar herramientas antes de pedir datos al usuario.',
    'Para preguntas de calendario/evento/cartelera (por fecha o proximo evento), SIEMPRE usa web_search antes de responder.',
    'Si hay conflicto entre fuentes, prioriza ufc.com, luego espn.com, luego otras.',
    'No inventes eventos ni fechas. Si no logras confirmar con web_search, dilo explicitamente.',
    'Cuando listes una cartelera, cita fuentes y llama set_event_card para guardar evento+peleas en memoria.',
    'Si piden analisis de una pelea concreta, usa get_fighter_history para sustentar pick tecnico con historial local.',
    'No pidas historial de peleadores al usuario si la herramienta puede obtenerlo.',
    'Solo pide cuotas si el usuario quiere EV/staking fino; sin cuotas igual da lectura tecnica preliminar y pick condicional.',
    'Usa la memoria conversacional para referencias como pelea 1, esa pelea, bankroll y apuestas previas.',
    'No muestres tablas crudas de muchas filas salvo pedido explicito; sintetiza hallazgos relevantes.',
    'Si actualizas o detectas datos de perfil del usuario, persiste con update_user_profile.',
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
      note: 'sin filas historicas relevantes en cache local',
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
    cacheRowCount: cacheStatus?.rowCount ?? null,
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
}) {
  let response = await client.responses.create({
    model: MODEL,
    temperature: TEMPERATURE,
    instructions,
    input,
    tools,
    include: INCLUDE_FIELDS,
    tool_choice: 'auto',
  });

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
      model: MODEL,
      temperature: TEMPERATURE,
      instructions,
      previous_response_id: response.id,
      input: outputs,
      tools,
      include: INCLUDE_FIELDS,
      tool_choice: 'auto',
    });

    usedWebSearch = usedWebSearch || hasWebSearchCall(response);
    for (const citation of extractCitationsFromResponse(response)) {
      citationMap.set(citation.url, citation);
    }
  }

  return {
    reply: extractResponseText(response),
    usedWebSearch,
    citations: Array.from(citationMap.values()),
  };
}

export function createBettingWizard({
  fightsScalper,
  conversationStore,
  client: providedClient,
} = {}) {
  ensureConfigured(providedClient);
  const client = getOpenAIClient(providedClient);
  logConfiguration();

  async function handleMessage(message, context = {}) {
    const chatId = String(context.chatId ?? 'default');
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
          const profile = conversationStore?.getUserProfile
            ? conversationStore.getUserProfile(chatId)
            : {};
          const recentBets = conversationStore?.getBetHistory
            ? conversationStore.getBetHistory(chatId, 8)
            : [];

          return {
            ok: true,
            userProfile: profile,
            recentBets,
          };
        }

        case 'update_user_profile': {
          if (!conversationStore?.updateUserProfile) {
            return {
              ok: false,
              error: 'conversationStore no soporta updateUserProfile.',
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

          const profile = conversationStore.updateUserProfile(chatId, updates);
          return {
            ok: true,
            userProfile: profile,
          };
        }

        case 'record_user_bet': {
          if (!conversationStore?.addBetRecord) {
            return {
              ok: false,
              error: 'conversationStore no soporta addBetRecord.',
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

          const stored = conversationStore.addBetRecord(chatId, record);
          return {
            ok: true,
            record: stored,
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

      const userPayload = buildUserPayload({
        originalMessage,
        resolvedMessage,
        resolution,
        sessionMemory,
        recentTurns,
        hasMedia,
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
      });

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
