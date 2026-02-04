import fs from 'node:fs';
import path from 'node:path';
import OpenAI from 'openai';
import '../core/env.js';

/**
 * ENV & CONFIG
 */
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ASSISTANT_ID = process.env.ASSISTANT_ID;
const KNOWLEDGE_FILE =
  process.env.KNOWLEDGE_FILE || './Knowledge/ufc_bets_playbook.md';
const RESOLVED_KNOWLEDGE_PATH = path.resolve(process.cwd(), KNOWLEDGE_FILE);
const VERIFY_ASSISTANT_ON_BOOT =
  process.env.VERIFY_ASSISTANT_ON_BOOT !== 'false';

// Polling config (overridable via env)
const RUN_POLL_INTERVAL_MS = Number(
  process.env.RUN_POLL_INTERVAL_MS ?? '1500'
);
const RUN_MAX_POLLS = Number(process.env.RUN_MAX_POLLS ?? '60');
const MAX_HISTORY_CONTEXT_ROWS = Number(
  process.env.MAX_HISTORY_CONTEXT_ROWS ?? '18'
);

const client = new OpenAI({ apiKey: OPENAI_API_KEY });

/**
 * Simple in-memory cache so we don't re-upload the same knowledge file
 */
const knowledgeCache = {
  fileId: null,
  lastUploadedMtime: null,
  lastPath: null,
};

function logConfiguration() {
  console.log('⚙️ Betting Wizard config', {
    assistantId: ASSISTANT_ID,
    knowledgeFile: RESOLVED_KNOWLEDGE_PATH,
    knowledgeExists: fs.existsSync(RESOLVED_KNOWLEDGE_PATH),
    hasOpenAIKey: Boolean(OPENAI_API_KEY),
    runPollIntervalMs: RUN_POLL_INTERVAL_MS,
    runMaxPolls: RUN_MAX_POLLS,
  });
}

/**
 * Ensure mandatory configuration is present before we even create the wizard.
 */
function ensureConfigured() {
  if (!OPENAI_API_KEY) {
    throw new Error(
      'OPENAI_API_KEY is not configured. Set it in your environment or .env file.'
    );
  }

  if (!ASSISTANT_ID) {
    console.warn(
      '⚠️ ASSISTANT_ID is not configured. Betting Wizard will not respond.'
    );
  }
}

/**
 * Optionally validate that the Assistant ID is real and reachable.
 */
async function validateAssistantConfiguration() {
  if (!ASSISTANT_ID) return;

  try {
    const assistant = await client.beta.assistants.retrieve(ASSISTANT_ID);
    console.log('🆗 Assistant verificado:', {
      id: assistant.id,
      model: assistant.model,
      tools: assistant.tools?.map((t) => t.type) ?? [],
    });
  } catch (error) {
    console.error('❌ Unable to verify Assistant configuration:', error);
  }
}

/**
 * Upload (or re-use) the local knowledge file.
 * Returns the fileId or null if not available.
 */
async function syncKnowledgeFile() {
  try {
    if (!fs.existsSync(RESOLVED_KNOWLEDGE_PATH)) {
      console.warn(`⚠️ Knowledge file not found: ${RESOLVED_KNOWLEDGE_PATH}`);
      return null;
    }

    const stats = fs.statSync(RESOLVED_KNOWLEDGE_PATH);

    // Use cache if file hasn't changed
    if (
      knowledgeCache.fileId &&
      knowledgeCache.lastUploadedMtime === stats.mtimeMs &&
      knowledgeCache.lastPath === RESOLVED_KNOWLEDGE_PATH
    ) {
      return knowledgeCache.fileId;
    }

    const file = await client.files.create({
      file: fs.createReadStream(RESOLVED_KNOWLEDGE_PATH),
      purpose: 'assistants',
    });

    knowledgeCache.fileId = file.id;
    knowledgeCache.lastUploadedMtime = stats.mtimeMs;
    knowledgeCache.lastPath = RESOLVED_KNOWLEDGE_PATH;

    console.log(`📚 Knowledge file uploaded: ${file.id}`);
    return file.id;
  } catch (err) {
    console.error('❌ Failed to sync knowledge file:', err);
    return null;
  }
}

/**
 * Polls the run until it reaches a terminal state.
 * Uses the **correct** signature for the current OpenAI Node SDK:
 *   client.beta.threads.runs.retrieve(runId, { thread_id })
 */
async function waitForRunCompletion(threadId, runId) {
  if (!threadId || !runId) {
    throw new Error(
      `waitForRunCompletion called with invalid IDs (threadId=${threadId}, runId=${runId})`
    );
  }

  let polls = 0;
  let runStatus = null;

  while (true) {
    runStatus = await client.beta.threads.runs.retrieve(runId, {
      thread_id: threadId,
    });

    const status = runStatus.status;
    console.log(`⏱️ Run status: ${status} (poll #${polls + 1})`);

    // Terminal states
    if (
      status === 'completed' ||
      status === 'failed' ||
      status === 'cancelled' ||
      status === 'expired'
    ) {
      return runStatus;
    }

    // We don't implement tools/submitToolOutputs in this agent.
    // If this ever happens, at least we log it loudly.
    if (status === 'requires_action') {
      console.warn(
        '⚠️ Run entered requires_action, but Betting Wizard does not implement tool handling yet.'
      );
      return runStatus;
    }

    polls += 1;
    if (polls >= RUN_MAX_POLLS) {
      console.warn(
        `⚠️ Aborting polling after ${polls} polls; last status=${status}`
      );
      return runStatus;
    }

    await new Promise((r) => setTimeout(r, RUN_POLL_INTERVAL_MS));
  }
}

/**
 * Extract the assistant's reply text from thread messages.
 * We prefer the latest assistant message (optionally filtered by runId).
 */
async function getAssistantReply(threadId, runId) {
  const messages = await client.beta.threads.messages.list(threadId);

  if (!messages?.data?.length) {
    return null;
  }

  // Filter messages that belong to this run (if available) and role=assistant
  const assistantMessages = messages.data.filter((msg) => {
    if (msg.role !== 'assistant') return false;
    if (!runId) return true;
    return msg.run_id === runId;
  });

  if (!assistantMessages.length) {
    return null;
  }

  // In many cases they are already ordered, but just in case:
  assistantMessages.sort((a, b) => b.created_at - a.created_at);

  const msg = assistantMessages[0];

  const firstContent = msg.content?.[0];
  if (firstContent?.type === 'text') {
    return firstContent.text?.value ?? null;
  }

  // Fallback: try to stringify or join any text parts
  const textParts = msg.content
    ?.filter((c) => c.type === 'text')
    .map((c) => c.text?.value)
    .filter(Boolean);

  if (textParts?.length) {
    return textParts.join('\n\n');
  }

  // As a last resort, we just dump the raw content
  return JSON.stringify(msg.content, null, 2);
}

function buildAdditionalInstructions(fileId) {
  const parts = [
    'IMPORTANTE: Ya tienes datos historicos de peleadores disponibles desde el sistema.',
    'NO pidas al usuario estadisticas historicas ni historial de peleadores.',
    'Si [WEB_CONTEXT] incluye una cartelera principal, usala directamente sin pedir nombres de peleadores.',
    'Si faltan datos de mercado en tiempo real, solo pide cuotas/lineas actuales (por ejemplo Bet365).',
    'Si no hay suficiente informacion, responde con supuestos explicitos y una estrategia conservadora.',
  ];

  if (fileId) {
    parts.push(`Usa tambien el playbook local cargado con file_id=${fileId}.`);
  } else {
    parts.push('No hay playbook local cargado en esta ejecucion.');
  }

  return parts.join(' ');
}

function buildHistoryContextText(result, cacheStatus) {
  if (!result?.fighters?.length) {
    if (cacheStatus?.rowCount) {
      return `No se detectaron nombres de peleadores en el mensaje. El cache local de Fight History tiene ${cacheStatus.rowCount} filas (ultimo sync: ${cacheStatus.lastSyncAt || 'desconocido'}).`;
    }
    return 'No se detectaron nombres de peleadores en el mensaje.';
  }

  if (!result.rows?.length) {
    return `Se detectaron peleadores (${result.fighters.join(' vs ')}) pero no hubo filas historicas coincidentes en la base local.`;
  }

  const previewRows = result.rows.slice(0, MAX_HISTORY_CONTEXT_ROWS);
  const lines = previewRows.map((row) => `- ${row.join(' | ')}`);
  const moreCount = result.rows.length - previewRows.length;

  return [
    `Peleadores detectados: ${result.fighters.join(' vs ')}`,
    `Filas historicas encontradas: ${result.rows.length}`,
    ...lines,
    moreCount > 0 ? `- ... ${moreCount} filas adicionales omitidas` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

async function buildEnrichedPrompt(message, fightsScalper, webIntel) {
  if (!fightsScalper?.getFighterHistory) {
    return { enrichedMessage: message, historyRows: 0, webContext: null };
  }

  try {
    let webContext = null;
    if (webIntel?.buildWebContextForMessage) {
      try {
        webContext = await webIntel.buildWebContextForMessage(message);
      } catch (error) {
        console.error('❌ Failed to fetch web context:', error);
      }
    }

    const historySeedMessage =
      webContext?.fights?.length
        ? `${message}\n${webContext.fights
            .map((fight) => `${fight.fighterA} vs ${fight.fighterB}`)
            .join('\n')}`
        : message;

    const historyResult = await fightsScalper.getFighterHistory({
      message: historySeedMessage,
    });
    const cacheStatus = fightsScalper.getFightHistoryCacheStatus?.() ?? null;
    const context = buildHistoryContextText(historyResult, cacheStatus);
    const webContextText = webContext?.contextText
      ? `\n\n[WEB_CONTEXT]\n${webContext.contextText}`
      : '';

    return {
      enrichedMessage: `${message}${webContextText}\n\n[HISTORICAL_CONTEXT]\n${context}`,
      historyRows: historyResult?.rows?.length || 0,
      webContext,
    };
  } catch (error) {
    console.error('❌ Failed to build historical context for Betting Wizard:', error);
    return { enrichedMessage: message, historyRows: 0, webContext: null };
  }
}

/**
 * Factory to create the Betting Wizard agent.
 */
export function createBettingWizard({ fightsScalper, webIntel } = {}) {
  ensureConfigured();
  logConfiguration();

  if (VERIFY_ASSISTANT_ON_BOOT) {
    validateAssistantConfiguration().catch((e) =>
      console.error('❌ Assistant verification failed during init:', e)
    );
  }

  /**
   * Main handler that the router calls.
   */
  async function handleMessage(message) {
    if (!ASSISTANT_ID) {
      return '⚠️ Betting Wizard no está configurado correctamente. Falta ASSISTANT_ID.';
    }

    let threadId = null;
    let runId = null;

    try {
      console.log(`🧠 Betting Wizard (Assistant) recibió: ${message}`);
      console.log('🔗 Assistant ID:', ASSISTANT_ID);
      console.log('🔍 SDK sanity check:', Object.keys(client.beta));

      // Optional knowledge file sync
      const fileId = await syncKnowledgeFile();
      const additionalInstructions = buildAdditionalInstructions(fileId);
      const { enrichedMessage, historyRows, webContext } = await buildEnrichedPrompt(
        message,
        fightsScalper,
        webIntel
      );
      console.log('📊 Historical context rows sent to assistant:', historyRows);
      if (webContext?.eventName) {
        console.log('🌐 Web context event detected:', webContext.eventName);
      }

      // 1) Create thread
      const thread = await client.beta.threads.create({
        // You can add metadata here if you want:
        // metadata: { source: 'telegram', ts: Date.now().toString() },
      });
      threadId = thread.id;
      console.log('🧵 Thread creado:', threadId);

      // 2) Add user message
      await client.beta.threads.messages.create(threadId, {
        role: 'user',
        content: enrichedMessage,
      });

      // 3) Create run
      const run = await client.beta.threads.runs.create(threadId, {
        assistant_id: ASSISTANT_ID,
        additional_instructions: additionalInstructions,
        // If in the future you add retrieval/file tools:
        // tool_resources: {
        //   file_search: { file_ids: [fileId] }
        // }
      });

      runId = run.id;
      console.log('🏃 Run iniciado:', runId);

      // 4) Poll until completed / failed / etc. (fixed retrieve signature)
      const finalRun = await waitForRunCompletion(threadId, runId);

      if (!finalRun) {
        console.error('❌ Polling returned null run.');
        return '⚠️ El Betting Wizard tuvo un problema interno.';
      }

      if (finalRun.status === 'failed') {
        console.error('💥 Assistant run failed:', finalRun.last_error);
        return '⚠️ El Betting Wizard tuvo un problema interno.';
      }

      if (
        finalRun.status === 'requires_action' ||
        finalRun.status === 'cancelled' ||
        finalRun.status === 'expired'
      ) {
        console.error('💥 Run ended in non-success state:', {
          status: finalRun.status,
          last_error: finalRun.last_error,
        });
        return '⚠️ El Betting Wizard no pudo completar la respuesta.';
      }

      // 5) Fetch the assistant reply from messages
      const assistantReply = await getAssistantReply(threadId, runId);
      const reply = assistantReply || 'Sin respuesta del Betting Wizard.';

      console.log('✅ Assistant respondió:', reply);
      return reply;
    } catch (err) {
      console.error('💥 Error en Betting Wizard Assistant:', err);
      console.error('🧾 Contexto IDs:', { threadId, runId });
      return '⚠️ Betting Wizard no está disponible ahora.';
    }
  }

  return { handleMessage };
}

export default { createBettingWizard };
