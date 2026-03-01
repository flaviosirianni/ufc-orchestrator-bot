import OpenAI from 'openai';
import fs from 'node:fs/promises';
import path from 'node:path';
import '../core/env.js';
import { readRange, writeRange } from '../tools/sheetOpsTool.js';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.HISTORY_SCRAPER_MODEL || 'gpt-4.1';
const MAX_TOOL_ROUNDS = Number(process.env.HISTORY_SCRAPER_MAX_ROUNDS ?? '10');
const MAX_EVENTS = Number(process.env.HISTORY_SCRAPER_MAX_EVENTS ?? '8');
const SHEET_ID = process.env.SHEET_ID;
const RANGE = process.env.FIGHT_HISTORY_RANGE || 'Fight History!A:Z';
const DRY_RUN = process.env.HISTORY_SCRAPER_DRY_RUN === 'true';
const LOG_PATH =
  process.env.HISTORY_SCRAPER_LOG_PATH ||
  path.resolve(process.cwd(), 'data', 'history_scraper.log.jsonl');
const COMPLETED_EVENTS_URL =
  process.env.HISTORY_SCRAPER_COMPLETED_EVENTS_URL ||
  'https://www.ufcstats.com/statistics/events/completed?page=all';
const REQUEST_TIMEOUT_MS = Math.max(
  1000,
  Number(process.env.HISTORY_SCRAPER_FETCH_TIMEOUT_MS ?? '12000')
);
const OPENAI_TIMEOUT_MS = Math.max(
  10000,
  Number(process.env.HISTORY_SCRAPER_OPENAI_TIMEOUT_MS ?? '90000')
);
const OPENAI_MAX_RETRIES = Math.max(
  0,
  Number(process.env.HISTORY_SCRAPER_OPENAI_MAX_RETRIES ?? '1')
);
const SCRAPER_DEADLINE_MS = Math.max(
  60000,
  Number(process.env.HISTORY_SCRAPER_DEADLINE_MS ?? '480000')
);

const WEB_SEARCH_DOMAINS = (process.env.HISTORY_SCRAPER_DOMAINS ||
  'ufc.com,espn.com,en.wikipedia.org,es.wikipedia.org,tapology.com,sherdog.com')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

const MONTHS_EN_TO_NUM = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
};

function ensureConfigured() {
  if (!OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not configured.');
  }
  if (!SHEET_ID) {
    throw new Error('SHEET_ID is not configured.');
  }
}

function toIso(date) {
  if (!date) return null;
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseDateCell(raw = '') {
  const value = String(raw || '').trim();
  if (!value) return null;

  const isoMatch = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    const date = new Date(Date.UTC(Number(isoMatch[1]), Number(isoMatch[2]) - 1, Number(isoMatch[3])));
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const slashMatch = value.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})$/);
  if (slashMatch) {
    const day = Number(slashMatch[1]);
    const month = Number(slashMatch[2]);
    const year = Number(slashMatch[3].length === 2 ? `20${slashMatch[3]}` : slashMatch[3]);
    const isLikelyDayFirst = day > 12 || month <= 12;
    const date = isLikelyDayFirst
      ? new Date(Date.UTC(year, month - 1, day))
      : new Date(Date.UTC(year, day - 1, month));
    return Number.isNaN(date.getTime()) ? null : date;
  }

  return null;
}

function parseEnglishDateCell(raw = '') {
  const value = String(raw || '').trim();
  if (!value) return null;
  const match = value.match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/);
  if (!match) return null;
  const month = MONTHS_EN_TO_NUM[String(match[1] || '').toLowerCase()];
  if (!month) return null;
  const day = Number(match[2]);
  const year = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseIsoOrKnownDate(raw = '') {
  return parseDateCell(raw) || parseEnglishDateCell(raw);
}

function extractLatestLoadedFight(rows = []) {
  let latestDate = null;
  let latestRow = null;
  for (const row of rows.slice(1)) {
    const cellDate = parseIsoOrKnownDate(row?.[0]);
    if (!cellDate) continue;
    if (!latestDate || cellDate > latestDate) {
      latestDate = cellDate;
      latestRow = row;
    }
  }

  return {
    lastDate: latestDate ? toIso(latestDate) : null,
    lastEvent: latestRow?.[1] || null,
    lastRow: latestRow || null,
    rowCount: rows.length,
  };
}

function normalizeRow(row = []) {
  const cells = Array.isArray(row) ? row : [];
  const output = [];
  for (let i = 0; i < 9; i += 1) {
    output.push(cells[i] ?? '');
  }

  output[0] = String(output[0] || '').trim();
  output[1] = String(output[1] || '').trim();
  output[2] = String(output[2] || '').trim();
  output[3] = String(output[3] || '').trim();
  output[4] = String(output[4] || '').trim();
  output[5] = String(output[5] || '').trim();
  output[6] = String(output[6] || '').trim();
  output[7] = Number.isFinite(Number(output[7])) ? Number(output[7]) : output[7];
  output[8] = String(output[8] || '').trim();

  return output;
}

function normalizeKey(value = '') {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function deriveEventInfo(payload, rows = []) {
  const eventName = String(payload.eventName || rows?.[0]?.[1] || '').trim();
  const eventDate = String(payload.eventDate || rows?.[0]?.[0] || '').trim();
  return {
    eventName,
    eventDate,
  };
}

function buildEventKey({ eventName, eventDate }) {
  const nameKey = normalizeKey(eventName);
  const dateKey = normalizeKey(eventDate);
  if (nameKey && dateKey) {
    return `${dateKey}::${nameKey}`;
  }
  if (nameKey) {
    return `name::${nameKey}`;
  }
  if (dateKey) {
    return `date::${dateKey}`;
  }
  return null;
}

function buildInstructions() {
  return [
    'Tu tarea es actuar como un asistente experto en recopilar informacion completa y precisa sobre eventos de UFC del pasado.',
    'Debes buscar resultados de eventos completos, incluyendo todas las peleas de cada cartelera: main card, prelims y early prelims.',
    'Formato requerido por pelea (orden exacto): ["Fecha","Nombre del Evento","Fighter 1","Fighter 2","Weight Class","Winner","Method","Round","Time"].',
    'No omitas combates: incluye todos los enfrentamientos oficiales del evento.',
    'La informacion debe ser fidedigna, proveniente de fuentes confiables (Tapology, Sherdog, Wikipedia, ESPN, etc.).',
    'El formato debe ser limpio, homogeneo y consistente con los ejemplos anteriores.',
    'No incluyas comentarios ni explicaciones junto a los datos; solo registros en el formato indicado.',
    'Notas finales: luego de completar cada evento, revisa pelea por pelea que no falte ninguna y que todos los campos esten completos.',
    'Cada respuesta debe constar de eventos completos (todos los combates de uno o mas eventos), no peleas sueltas.',
    'Mision principal: primero usa get_last_loaded_fight para saber la ultima pelea cargada en Google Sheets.',
    'Con esa fecha, busca todos los eventos que ocurran despues de esa fecha y hasta el presente.',
    'Procesa los eventos en orden cronologico, del mas antiguo al mas reciente.',
    'Cuando tengas el evento completo, llama append_fight_rows con todas las peleas en el formato indicado.',
    'Despues continua con el siguiente evento hasta llegar al presente o al maximo de eventos permitido.',
    'Interaccion con Google Sheets: usa get_last_loaded_fight para leer el ultimo registro y append_fight_rows para escribir nuevas filas en la hoja.',
    'No hagas preguntas al operador; ejecuta el batch hasta completar o no encontrar eventos nuevos.',
    'Si no hay eventos con resultados completos nuevos, termina el batch con un mensaje corto de cierre.',
    'Si recibes una seccion llamada EVENTOS_CONFIRMADOS_PENDIENTES, debes intentar cargar esos eventos uno por uno antes de concluir que esta actualizado.',
    'No declares "actualizado" si EVENTOS_CONFIRMADOS_PENDIENTES contiene eventos sin procesar.',
  ].join(' ');
}

function buildTools() {
  return [
    {
      type: 'web_search',
      search_context_size: 'high',
      ...(WEB_SEARCH_DOMAINS.length
        ? { filters: { allowed_domains: WEB_SEARCH_DOMAINS } }
        : {}),
    },
    {
      type: 'function',
      name: 'get_last_loaded_fight',
      description: 'Devuelve la ultima pelea cargada y la fecha mas reciente en la hoja.',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      strict: false,
    },
    {
      type: 'function',
      name: 'append_fight_rows',
      description:
        'Agrega multiples filas al Google Sheet en el formato requerido para Fight History.',
      parameters: {
        type: 'object',
        properties: {
          rows: {
            type: 'array',
            items: {
              type: 'array',
              items: {
                type: ['string', 'number', 'null'],
              },
            },
          },
          eventName: { type: 'string' },
          eventDate: { type: 'string' },
        },
        required: ['rows'],
        additionalProperties: false,
      },
      strict: false,
    },
  ];
}

async function ensureLogDir() {
  const dir = path.dirname(LOG_PATH);
  await fs.mkdir(dir, { recursive: true });
}

async function appendLogEntry(entry) {
  await ensureLogDir();
  const line = `${JSON.stringify(entry)}\n`;
  await fs.appendFile(LOG_PATH, line, 'utf-8');
}

async function loadLoggedEvents() {
  try {
    const raw = await fs.readFile(LOG_PATH, 'utf-8');
    const lines = raw.split('\n').filter(Boolean);
    const keys = new Set();
    for (const line of lines) {
      const parsed = JSON.parse(line);
      if (!parsed) continue;
      const key = buildEventKey({
        eventName: parsed.eventName,
        eventDate: parsed.eventDate,
      });
      if (key) {
        keys.add(key);
      }
    }
    return keys;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return new Set();
    }
    throw error;
  }
}

async function loadExistingRowSet() {
  const rows = await readRange(SHEET_ID, RANGE);
  const set = new Set();
  for (const row of rows.slice(1)) {
    const normalized = normalizeRow(row);
    set.add(JSON.stringify(normalized));
  }
  return { rows, set };
}

function extractFunctionCalls(response) {
  const output = Array.isArray(response?.output) ? response.output : [];
  return output.filter((item) => item?.type === 'function_call');
}

function extractResponseText(response) {
  const direct = String(response?.output_text || '').trim();
  if (direct) return direct;
  const output = Array.isArray(response?.output) ? response.output : [];
  for (const item of output) {
    if (item?.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const content of item.content) {
      if (content?.type === 'output_text' && String(content.text || '').trim()) {
        return String(content.text).trim();
      }
    }
  }
  return '';
}

function decodeHtmlEntities(value = '') {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function toAbsoluteUrl(url = '', baseUrl = COMPLETED_EVENTS_URL) {
  const value = String(url || '').trim();
  if (!value) return null;
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return null;
  }
}

function stripTags(value = '') {
  return String(value || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

export function parseCompletedEventsFromHtml(html = '', { baseUrl = COMPLETED_EVENTS_URL } = {}) {
  const source = String(html || '');
  if (!source.trim()) {
    return [];
  }

  const events = [];
  const linkPattern = /<a[^>]+href="([^"]*event-details[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match = linkPattern.exec(source);

  while (match) {
    const href = decodeHtmlEntities(match[1] || '');
    const eventName = decodeHtmlEntities(stripTags(match[2] || ''));
    if (!/^ufc\b/i.test(eventName)) {
      match = linkPattern.exec(source);
      continue;
    }

    const windowEnd = Math.min(source.length, match.index + 600);
    const windowText = source.slice(match.index, windowEnd);
    const dateMatch = windowText.match(
      /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}\b/i
    );
    const eventDate = dateMatch ? toIso(parseEnglishDateCell(dateMatch[0])) : null;
    const eventUrl = toAbsoluteUrl(href, baseUrl);
    if (!eventDate || !eventUrl) {
      match = linkPattern.exec(source);
      continue;
    }

    events.push({
      eventName,
      eventDate,
      eventUrl,
    });
    match = linkPattern.exec(source);
  }

  const deduped = [];
  const seen = new Set();
  for (const event of events) {
    const key = `${normalizeKey(event.eventDate)}::${normalizeKey(event.eventName)}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(event);
  }
  return deduped;
}

export function listMissingCompletedEvents({
  events = [],
  sinceDate = null,
  untilDate = toIso(new Date()),
  maxEvents = MAX_EVENTS,
} = {}) {
  const list = Array.isArray(events) ? events : [];
  const after = sinceDate ? String(sinceDate).trim() : null;
  const until = untilDate ? String(untilDate).trim() : null;
  const sorted = list
    .filter((event) => event?.eventDate && event?.eventName)
    .filter((event) => !after || event.eventDate > after)
    .filter((event) => !until || event.eventDate <= until)
    .sort((a, b) => {
      if (a.eventDate !== b.eventDate) {
        return a.eventDate.localeCompare(b.eventDate);
      }
      return a.eventName.localeCompare(b.eventName);
    });

  return sorted.slice(0, Math.max(0, Number(maxEvents) || 0));
}

async function fetchCompletedEventsIndex({
  url = COMPLETED_EVENTS_URL,
  fetchImpl = fetch,
} = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      headers: {
        'User-Agent': 'ufc-orchestrator-bot/1.0',
        Accept: 'text/html,application/xhtml+xml',
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Failed fetching completed events index (${response.status})`);
    }
    const html = await response.text();
    return parseCompletedEventsFromHtml(html, { baseUrl: url });
  } finally {
    clearTimeout(timeout);
  }
}

function formatPendingEventsHint(events = []) {
  if (!Array.isArray(events) || !events.length) {
    return 'EVENTOS_CONFIRMADOS_PENDIENTES:\n- ninguno';
  }
  const lines = events.map(
    (event, index) => `${index + 1}. ${event.eventDate} | ${event.eventName} | ${event.eventUrl}`
  );
  return ['EVENTOS_CONFIRMADOS_PENDIENTES:', ...lines].join('\n');
}

export async function runHistoryScraper() {
  ensureConfigured();
  const client = new OpenAI({
    apiKey: OPENAI_API_KEY,
    timeout: OPENAI_TIMEOUT_MS,
    maxRetries: OPENAI_MAX_RETRIES,
  });
  const instructions = buildInstructions();
  const tools = buildTools();
  const summary = {
    eventsProcessed: 0,
    rowsAppended: 0,
    rowsSkippedExisting: 0,
    eventsSkippedLogged: 0,
    dryRun: DRY_RUN,
  };
  const loggedEvents = await loadLoggedEvents();
  let existingRowSet = null;
  const processedEventDates = new Set();
  const runStartedAt = Date.now();

  function ensureDeadline(contextLabel = 'history:sync') {
    if (Date.now() - runStartedAt > SCRAPER_DEADLINE_MS) {
      throw new Error(
        `${contextLabel} exceeded deadline (${SCRAPER_DEADLINE_MS}ms). Increase HISTORY_SCRAPER_DEADLINE_MS or narrow scope.`
      );
    }
  }

  async function createResponseWithLog(payload, label = 'model_call') {
    ensureDeadline(`history:sync ${label}`);
    const startedAt = Date.now();
    console.log(`[history:sync] ${label} -> started`);
    const response = await client.responses.create(payload);
    console.log(`[history:sync] ${label} -> completed in ${Date.now() - startedAt}ms`);
    return response;
  }

  console.log(
    `[history:sync] Starting run | model=${MODEL} | maxEvents=${MAX_EVENTS} | maxToolRounds=${MAX_TOOL_ROUNDS}`
  );
  console.log('[history:sync] Reading latest loaded fight from sheet...');

  const sheetRows = await readRange(SHEET_ID, RANGE);
  const latestLoaded = extractLatestLoadedFight(sheetRows);
  console.log(
    `[history:sync] Sheet latest: ${latestLoaded.lastDate || 'unknown'} | event=${
      latestLoaded.lastEvent || 'unknown'
    }`
  );

  console.log('[history:sync] Reconciling with completed UFC events index...');
  let pendingEventsHint = [];
  try {
    const completedEvents = await fetchCompletedEventsIndex();
    pendingEventsHint = listMissingCompletedEvents({
      events: completedEvents,
      sinceDate: latestLoaded.lastDate,
      untilDate: toIso(new Date()),
      maxEvents: MAX_EVENTS,
    });
    console.log(
      `[history:sync] Completed index loaded. Missing candidates: ${pendingEventsHint.length}`
    );
  } catch (error) {
    console.warn('⚠️ No se pudo obtener indice de eventos completados:', error?.message || error);
  }

  async function runModelToolLoop(initialInput, loopLabel = 'batch') {
    let response = await createResponseWithLog(
      {
        model: MODEL,
        instructions,
        input: initialInput,
        tools,
        tool_choice: 'auto',
      },
      `${loopLabel}:initial`
    );

    let rounds = 0;
    while (rounds < MAX_TOOL_ROUNDS) {
      ensureDeadline(`history:sync ${loopLabel}`);
      rounds += 1;
      const calls = extractFunctionCalls(response);
      if (!calls.length) {
        console.log(`[history:sync] ${loopLabel}: no tool calls in round ${rounds}, finishing loop.`);
        break;
      }
      console.log(
        `[history:sync] ${loopLabel}: round ${rounds} tool calls -> ${calls
          .map((call) => call.name)
          .join(', ')}`
      );

      const outputs = [];
      for (const call of calls) {
        if (call.name === 'get_last_loaded_fight') {
          const rows = await readRange(SHEET_ID, RANGE);
          const latest = extractLatestLoadedFight(rows);
          outputs.push({
            type: 'function_call_output',
            call_id: call.call_id,
            output: JSON.stringify({
              ok: true,
              ...latest,
            }),
          });
          continue;
        }

        if (call.name === 'append_fight_rows') {
          let payload = {};
          try {
            payload = JSON.parse(call.arguments || '{}');
          } catch {
            payload = {};
          }
          const rows = Array.isArray(payload.rows) ? payload.rows : [];
          const normalized = rows.map(normalizeRow).filter((row) => row[0] && row[1]);
          const derived = deriveEventInfo(payload, normalized);
          const eventKey = buildEventKey(derived);
          if (eventKey && loggedEvents.has(eventKey)) {
            summary.eventsSkippedLogged += 1;
            await appendLogEntry({
              at: new Date().toISOString(),
              eventName: derived.eventName || null,
              eventDate: derived.eventDate || null,
              rowsAppended: 0,
              sheetId: SHEET_ID,
              range: RANGE,
              dryRun: DRY_RUN,
              model: MODEL,
              skipped: true,
              reason: 'already_logged',
            });
            outputs.push({
              type: 'function_call_output',
              call_id: call.call_id,
              output: JSON.stringify({
                ok: true,
                appended: 0,
                skipped: true,
                reason: 'already_logged',
              }),
            });
            continue;
          }

          if (!existingRowSet) {
            existingRowSet = await loadExistingRowSet();
          }

          const deduped = [];
          for (const row of normalized) {
            const key = JSON.stringify(row);
            if (existingRowSet.set.has(key)) {
              summary.rowsSkippedExisting += 1;
              continue;
            }
            existingRowSet.set.add(key);
            deduped.push(row);
          }

          const logEntryBase = {
            at: new Date().toISOString(),
            eventName: derived.eventName || null,
            eventDate: derived.eventDate || null,
            rowsAppended: deduped.length,
            sheetId: SHEET_ID,
            range: RANGE,
            dryRun: DRY_RUN,
            model: MODEL,
          };
          summary.eventsProcessed += 1;
          summary.rowsAppended += deduped.length;
          if (eventKey) {
            loggedEvents.add(eventKey);
          }
          if (derived.eventDate) {
            const normalizedEventDate = toIso(parseIsoOrKnownDate(derived.eventDate));
            if (normalizedEventDate) {
              processedEventDates.add(normalizedEventDate);
            }
          }

          if (DRY_RUN) {
            await appendLogEntry(logEntryBase);
            outputs.push({
              type: 'function_call_output',
              call_id: call.call_id,
              output: JSON.stringify({
                ok: true,
                appended: normalized.length,
                dryRun: true,
              }),
            });
            continue;
          }

          if (deduped.length) {
            await writeRange(SHEET_ID, RANGE, deduped, { append: true });
          }
          await appendLogEntry(logEntryBase);

          outputs.push({
            type: 'function_call_output',
            call_id: call.call_id,
            output: JSON.stringify({
              ok: true,
              appended: normalized.length,
              eventName: payload.eventName || null,
              eventDate: payload.eventDate || null,
            }),
          });
          continue;
        }

        outputs.push({
          type: 'function_call_output',
          call_id: call.call_id,
          output: JSON.stringify({ ok: false, error: `Tool desconocida: ${call.name}` }),
        });
      }

      response = await createResponseWithLog(
        {
          model: MODEL,
          instructions,
          previous_response_id: response.id,
          input: outputs,
          tools,
          tool_choice: 'auto',
        },
        `${loopLabel}:round_${rounds}`
      );
    }

    return extractResponseText(response);
  }

  const firstInput = [
    `Inicia el batch. Limite maximo de eventos: ${MAX_EVENTS}.`,
    `ULTIMO_CARGADO_EN_SHEET: ${
      latestLoaded.lastDate && latestLoaded.lastEvent
        ? `${latestLoaded.lastDate} | ${latestLoaded.lastEvent}`
        : 'sin fecha detectable'
    }`,
    formatPendingEventsHint(pendingEventsHint),
  ].join('\n');

  const notes = [];
  const note = await runModelToolLoop(firstInput, 'initial_batch');
  if (note) {
    notes.push(note);
  }

  const unresolvedByDate = () =>
    pendingEventsHint.filter((event) => !processedEventDates.has(event.eventDate));

  let unresolved = unresolvedByDate();
  for (const event of unresolved) {
    const before = summary.eventsProcessed;
    const retryNote = await runModelToolLoop(
      [
        'REINTENTO FOCALIZADO.',
        'Debes cargar SOLO este evento confirmado en UFCStats.',
        `EVENTO_OBJETIVO: ${event.eventDate} | ${event.eventName}`,
        `URL_REFERENCIA: ${event.eventUrl}`,
        'Busca resultados completos del evento y llama append_fight_rows con todas las peleas.',
      ].join('\n'),
      `targeted_retry_${event.eventDate}`
    );
    if (retryNote) {
      notes.push(retryNote);
    }
    if (summary.eventsProcessed === before) {
      continue;
    }
  }

  unresolved = unresolvedByDate();
  if (unresolved.length) {
    notes.push(
      [
        `⚠️ Detecté ${unresolved.length} evento(s) confirmados en UFCStats que no pude cargar automaticamente:`,
        ...unresolved.map((event) => `- ${event.eventDate} | ${event.eventName}`),
      ].join('\n')
    );
  }

  const summaryLines = [
    'Resumen history:sync',
    `Eventos procesados: ${summary.eventsProcessed}`,
    `Eventos salteados (log): ${summary.eventsSkippedLogged}`,
    `Filas agregadas: ${summary.rowsAppended}`,
    `Filas salteadas (duplicadas): ${summary.rowsSkippedExisting}`,
    `Dry run: ${summary.dryRun ? 'si' : 'no'}`,
    `Log: ${LOG_PATH}`,
  ];

  return [notes.join('\n\n'), '', summaryLines.join('\n')].filter(Boolean).join('\n');
}

export default { runHistoryScraper };
