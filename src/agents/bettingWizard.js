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

function logConfiguration() {
  console.log('⚙️ Betting Wizard config', {
    model: MODEL,
    temperature: TEMPERATURE,
    knowledgeFile: RESOLVED_KNOWLEDGE_PATH,
    knowledgeExists: fs.existsSync(RESOLVED_KNOWLEDGE_PATH),
    hasOpenAIKey: Boolean(OPENAI_API_KEY),
    maxRecentTurns: MAX_RECENT_TURNS,
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

function buildSystemPrompt(knowledgeSnippet = '') {
  const rules = [
    'Sos un analista de UFC conversacional, claro y directo.',
    'Prioriza responder lo que el usuario pidió en este turno.',
    'Usa [WEB_CONTEXT], [HISTORICAL_CONTEXT] y [CONVERSATION_CONTEXT] si existen.',
    'No pidas historial ni nombres de peleadores si ya están en el contexto.',
    'Si faltan cuotas, igual da pick preliminar y explicación técnica.',
    'No pidas bankroll salvo que el usuario te pida estrategia de staking.',
    'No devuelvas tablas crudas del historial salvo pedido explícito del usuario.',
    'Si el contexto es incierto, decilo en una línea y luego da la mejor lectura posible.',
  ].join(' ');

  if (!knowledgeSnippet) {
    return rules;
  }

  return `${rules}\n\n[PLAYBOOK_SNIPPET]\n${knowledgeSnippet}`;
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

function summarizeFighterRows(rows = [], fighter = '') {
  const fighterRows = rows.filter((row) => rowContainsFighter(row, fighter));
  if (!fighterRows.length) {
    return `- ${fighter}: sin filas históricas relevantes en cache local.`;
  }

  const wins = fighterRows.filter((row) => isWinForFighter(row, fighter)).length;
  const losses = fighterRows.length - wins;
  const finishes = fighterRows.filter((row) => isFinish(row[6] || '')).length;
  const recent = fighterRows.slice(0, 3).map((row) => {
    const date = String(row[0] || 'fecha n/d').trim();
    const opponent = inferOpponent(row, fighter);
    const result = isWinForFighter(row, fighter) ? 'W' : 'L';
    const method = String(row[6] || 'método n/d').trim();
    return `${date}: ${result} vs ${opponent} (${method})`;
  });

  return [
    `- ${fighter}: ${fighterRows.length} pelea(s) encontradas, récord reciente ${wins}-${losses}, finalizaciones ${finishes}.`,
    `  últimas: ${recent.join(' | ')}`,
  ].join('\n');
}

function buildHistoryContext(result, cacheStatus) {
  const totalRows = cacheStatus?.rowCount ?? 0;

  if (!result?.fighters?.length) {
    return totalRows
      ? `No se detectaron peleadores explícitos en el turno. Cache local disponible (${totalRows} filas).`
      : 'No se detectaron peleadores explícitos en el turno.';
  }

  const uniqueFighters = Array.from(new Set(result.fighters)).slice(0, 4);
  if (!result.rows?.length) {
    return [
      `Peleadores detectados: ${uniqueFighters.join(' vs ')}.`,
      `No hay filas históricas coincidentes en cache local (cache total: ${totalRows}).`,
    ].join('\n');
  }

  const summaries = uniqueFighters.map((fighter) =>
    summarizeFighterRows(result.rows, fighter)
  );

  return [
    `Peleadores detectados: ${uniqueFighters.join(' vs ')}.`,
    `Filas históricas candidatas: ${result.rows.length}.`,
    ...summaries,
  ].join('\n');
}

function buildUserPayload({
  originalMessage,
  resolvedMessage,
  resolution,
  webContext,
  historyContext,
}) {
  const sections = [
    '[USER_MESSAGE]',
    originalMessage,
  ];

  if (resolution?.resolvedFight) {
    sections.push(
      '',
      '[CONVERSATION_CONTEXT]',
      `La referencia de pelea resuelta para este turno es: ${resolution.resolvedFight.fighterA} vs ${resolution.resolvedFight.fighterB}.`
    );
  }

  if (webContext?.contextText) {
    sections.push('', '[WEB_CONTEXT]', webContext.contextText);
  }

  if (historyContext) {
    sections.push('', '[HISTORICAL_CONTEXT]', historyContext);
  }

  if (resolvedMessage && resolvedMessage !== originalMessage) {
    sections.push('', '[RESOLVED_MESSAGE_FOR_REASONING]', resolvedMessage);
  }

  return sections.join('\n');
}

async function buildContext({
  message,
  fightsScalper,
  webIntel,
  resolution,
  conversationStore,
  chatId,
}) {
  let webContext = null;

  if (webIntel?.buildWebContextForMessage) {
    try {
      webContext = await webIntel.buildWebContextForMessage(message);
    } catch (error) {
      console.error('❌ Failed to build web context:', error);
    }
  }

  const preferredFighters = [];
  if (resolution?.resolvedFight) {
    preferredFighters.push(
      resolution.resolvedFight.fighterA,
      resolution.resolvedFight.fighterB
    );
  }

  const historySeedMessage =
    webContext?.fights?.length
      ? `${message}\n${webContext.fights
          .map((fight) => `${fight.fighterA} vs ${fight.fighterB}`)
          .join('\n')}`
      : message;

  const historyResult = fightsScalper?.getFighterHistory
    ? await fightsScalper.getFighterHistory({
        message: historySeedMessage,
        fighters: preferredFighters.length ? preferredFighters : undefined,
        strict: preferredFighters.length > 0,
      })
    : { fighters: [], rows: [] };

  const cacheStatus = fightsScalper?.getFightHistoryCacheStatus
    ? fightsScalper.getFightHistoryCacheStatus()
    : null;
  const historyContext = buildHistoryContext(historyResult, cacheStatus);

  if (conversationStore?.setLastCard && webContext?.fights?.length) {
    conversationStore.setLastCard(chatId, {
      eventName: webContext.eventName,
      date: webContext.date,
      fights: webContext.fights,
    });
  }

  if (conversationStore?.setLastResolvedFight && resolution?.resolvedFight) {
    conversationStore.setLastResolvedFight(chatId, resolution.resolvedFight);
  }

  return {
    webContext,
    historyResult,
    historyContext,
  };
}

function mapTurnsToMessages(turns = []) {
  return turns
    .filter((turn) => turn?.role && turn?.content)
    .map((turn) => ({
      role: turn.role,
      content: turn.content,
    }));
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
        resolvedMessage: message,
        resolvedFight: null,
      };
    const resolvedMessage = context.resolvedMessage || resolution.resolvedMessage || message;

    try {
      console.log(`🧠 Betting Wizard recibió (${chatId}): ${originalMessage}`);

      const { webContext, historyResult, historyContext } = await buildContext({
        message: resolvedMessage,
        fightsScalper,
        webIntel,
        resolution,
        conversationStore,
        chatId,
      });

      const recentTurns = conversationStore?.getRecentTurns
        ? conversationStore.getRecentTurns(chatId, MAX_RECENT_TURNS)
        : [];
      const systemPrompt = buildSystemPrompt(loadKnowledgeSnippet());
      const userPayload = buildUserPayload({
        originalMessage,
        resolvedMessage,
        resolution,
        webContext,
        historyContext,
      });

      const messages = [
        { role: 'system', content: systemPrompt },
        ...mapTurnsToMessages(recentTurns),
        { role: 'user', content: userPayload },
      ];

      console.log('📊 Historical context rows sent to model:', historyResult?.rows?.length || 0);
      if (webContext?.eventName) {
        console.log('🌐 Web context event detected:', webContext.eventName);
      }

      const response = await client.chat.completions.create({
        model: MODEL,
        temperature: TEMPERATURE,
        messages,
      });

      const reply = response.choices?.[0]?.message?.content?.trim();
      if (!reply) {
        return {
          reply: '⚠️ No pude generar una respuesta en este turno.',
          metadata: {
            webContext,
            resolvedFight: resolution?.resolvedFight || null,
          },
        };
      }

      return {
        reply,
        metadata: {
          webContext,
          resolvedFight: resolution?.resolvedFight || null,
        },
      };
    } catch (error) {
      console.error('💥 Error en Betting Wizard:', error);
      return {
        reply: '⚠️ Betting Wizard no está disponible ahora.',
        metadata: {
          resolvedFight: resolution?.resolvedFight || null,
        },
      };
    }
  }

  return { handleMessage };
}

export default { createBettingWizard };
