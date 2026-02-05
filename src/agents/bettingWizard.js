import fs from 'node:fs';
import path from 'node:path';
import OpenAI from 'openai';
import '../core/env.js';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.BETTING_MODEL || 'gpt-4o-mini';
const TEMPERATURE = Number(process.env.BETTING_TEMPERATURE ?? '0.35');
const KNOWLEDGE_FILE =
  process.env.KNOWLEDGE_FILE || './Knowledge/ufc_bets_playbook.md';
const RESOLVED_KNOWLEDGE_PATH = path.resolve(process.cwd(), KNOWLEDGE_FILE);
const KNOWLEDGE_MAX_CHARS = Number(process.env.KNOWLEDGE_MAX_CHARS ?? '9000');
const MAX_RECENT_TURNS = Number(process.env.BETTING_MAX_RECENT_TURNS ?? '8');
const MAX_TOOL_ROUNDS = Number(process.env.BETTING_MAX_TOOL_ROUNDS ?? '4');
const MAX_HISTORY_PREVIEW_ROWS = Number(process.env.BETTING_HISTORY_PREVIEW_ROWS ?? '12');

const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'resolve_event_card',
      description:
        'Busca en web el evento UFC mas relevante para la consulta y devuelve cartelera estimada + titulares recientes.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Consulta del usuario (fecha, evento o pregunta en lenguaje natural).',
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
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
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_user_profile',
      description:
        'Lee el perfil de usuario guardado en memoria conversacional (bankroll, unidad, perfil de riesgo, notas, apuestas previas).',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
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
    },
  },
  {
    type: 'function',
    function: {
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
    },
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

function isCalendarQuestion(message = '') {
  const text = normalise(message);
  const hasEventWords =
    /\b(ufc|evento|cartelera|main card|main event|quien pelea|quienes pelean)\b/.test(
      text
    );
  const hasDateOrTimeWords =
    /\b(proximo|proxima|next|upcoming|que viene|siguiente)\b/.test(text) ||
    /\b(20\d{2}-\d{1,2}-\d{1,2}|\d{1,2}[\/-]\d{1,2}|\d{1,2}\s+de\s+[a-z]+)\b/.test(
      text
    );
  return hasEventWords && hasDateOrTimeWords;
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

function mapTurnsToMessages(turns = []) {
  return turns
    .filter((turn) => turn?.role && turn?.content)
    .map((turn) => ({
      role: turn.role,
      content: turn.content,
    }));
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
    'Si la pregunta es de calendario/evento/cartelera (fecha o proximo evento), SIEMPRE usa resolve_event_card antes de responder.',
    'Si piden analisis de una pelea concreta, usa get_fighter_history para sustentar pick tecnico con historial local.',
    'No inventes eventos ni fechas. Si herramientas no devuelven datos, dilo explicitamente y sugiere reintento.',
    'No pidas historial de peleadores al usuario si la herramienta puede obtenerlo.',
    'Solo pide cuotas si el usuario quiere EV/staking fino; sin cuotas igual da lectura tecnica preliminar y pick condicional.',
    'Usa la memoria conversacional para referencias como "pelea 1", "esa pelea", bankroll y apuestas previas.',
    'Evita respuestas roboticas: prioriza contexto del chat actual, luego memoria, luego herramientas.',
    'No muestres tablas crudas de muchas filas salvo pedido explicito; sintetiza hallazgos relevantes.',
    'Si actualizas o detectas datos de perfil del usuario, persiste con update_user_profile.',
  ].join(' ');

  if (!knowledgeSnippet) {
    return rules;
  }

  return `${rules}\n\n[PLAYBOOK_SNIPPET]\n${knowledgeSnippet}`;
}

function buildUserPayload({
  originalMessage,
  resolvedMessage,
  resolution,
  sessionMemory,
}) {
  const sections = ['[USER_MESSAGE]', originalMessage];

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

async function runModelWithTools({
  client,
  messages,
  executeTool,
}) {
  for (let round = 1; round <= MAX_TOOL_ROUNDS; round += 1) {
    const completion = await client.chat.completions.create({
      model: MODEL,
      temperature: TEMPERATURE,
      messages,
      tools: TOOL_DEFINITIONS,
      tool_choice: 'auto',
    });

    const message = completion.choices?.[0]?.message;
    if (!message) {
      return '';
    }

    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    messages.push({
      role: 'assistant',
      content: message.content ?? '',
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    });

    if (!toolCalls.length) {
      return String(message.content || '').trim();
    }

    for (const toolCall of toolCalls) {
      const name = toolCall.function?.name || 'unknown_tool';
      console.log(`🛠️ Betting Wizard tool call: ${name}`);

      let toolResult;
      try {
        toolResult = await executeTool(toolCall);
      } catch (error) {
        toolResult = {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }

      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: JSON.stringify(toolResult),
      });
    }
  }

  return '';
}

function buildEventCardMetadata(webContext = null) {
  if (!webContext?.fights?.length) {
    return null;
  }

  return {
    eventName: webContext.eventName || null,
    date: webContext.date || null,
    fights: webContext.fights,
  };
}

export function createBettingWizard({
  fightsScalper,
  webIntel,
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
      webContext: null,
    };

    const executeTool = async (toolCall) => {
      const name = toolCall.function?.name || '';
      const args = parseToolArgs(toolCall.function?.arguments || '{}');

      switch (name) {
        case 'resolve_event_card': {
          if (!webIntel?.buildWebContextForMessage) {
            return {
              ok: false,
              error: 'webIntelTool no esta disponible.',
            };
          }

          const userGroundedQuery = String(resolvedMessage || originalMessage || '').trim();
          const modelSuggestedQuery = String(args.query || '').trim();
          const hasExplicitDate =
            /\b(20\d{2}-\d{1,2}-\d{1,2}|\d{1,2}[\/-]\d{1,2}|\d{1,2}\s+de\s+[a-z]+)\b/i.test(
              userGroundedQuery
            );
          const query = hasExplicitDate
            ? userGroundedQuery
            : modelSuggestedQuery || userGroundedQuery;

          if (!query) {
            return {
              ok: false,
              error: 'query vacia para resolve_event_card.',
            };
          }

          const webContext = await webIntel.buildWebContextForMessage(query, {
            force: true,
          });

          if (!webContext) {
            return {
              ok: false,
              error: 'No se encontro contexto web confiable para esa consulta.',
            };
          }

          const fights = (webContext.fights || []).map((fight, index) => ({
            ...fight,
            cardIndex: index + 1,
          }));

          runtimeState.webContext = {
            ...webContext,
            fights,
          };

          if (fights.length && conversationStore?.setLastCard) {
            conversationStore.setLastCard(chatId, {
              eventName: webContext.eventName,
              date: webContext.date,
              fights,
            });
            runtimeState.resolvedFight = fights[0];
          }

          return {
            ok: true,
            queryUsed: query,
            eventName: webContext.eventName || null,
            date: webContext.date || null,
            confidence: webContext.confidence || 'low',
            fights,
            headlines: (webContext.headlines || []).slice(0, 6),
            contextText: webContext.contextText,
          };
        }

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
      const userPayload = buildUserPayload({
        originalMessage,
        resolvedMessage,
        resolution,
        sessionMemory,
      });

      const messages = [
        { role: 'system', content: systemPrompt },
        ...mapTurnsToMessages(recentTurns),
        { role: 'user', content: userPayload },
      ];

      const reply = await runModelWithTools({
        client,
        messages,
        executeTool,
      });

      if (isCalendarQuestion(originalMessage) && !runtimeState.webContext) {
        return {
          reply:
            'No pude validar en vivo la cartelera/calendario ahora mismo. Si queres, pedime el evento con fecha exacta y lo reintento.',
          metadata: {
            resolvedFight: runtimeState.resolvedFight,
            eventCard: null,
          },
        };
      }

      if (!reply) {
        return {
          reply:
            'No pude terminar el analisis en este turno. Si queres, reformulalo en una frase y lo reintento.',
          metadata: {
            resolvedFight: runtimeState.resolvedFight,
            eventCard: buildEventCardMetadata(runtimeState.webContext),
          },
        };
      }

      return {
        reply,
        metadata: {
          resolvedFight: runtimeState.resolvedFight,
          eventCard: buildEventCardMetadata(runtimeState.webContext),
        },
      };
    } catch (error) {
      console.error('💥 Error en Betting Wizard:', error);
      return {
        reply: '⚠️ Betting Wizard no esta disponible ahora.',
        metadata: {
          resolvedFight: runtimeState.resolvedFight,
          eventCard: buildEventCardMetadata(runtimeState.webContext),
        },
      };
    }
  }

  return { handleMessage };
}

export default { createBettingWizard };
