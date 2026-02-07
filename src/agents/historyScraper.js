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

const WEB_SEARCH_DOMAINS = (process.env.HISTORY_SCRAPER_DOMAINS ||
  'ufc.com,espn.com,en.wikipedia.org,es.wikipedia.org,tapology.com,sherdog.com')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

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

export async function runHistoryScraper() {
  ensureConfigured();
  const client = new OpenAI({ apiKey: OPENAI_API_KEY });
  const instructions = buildInstructions();
  const tools = buildTools();
  const summary = {
    eventsProcessed: 0,
    rowsAppended: 0,
    dryRun: DRY_RUN,
  };

  let response = await client.responses.create({
    model: MODEL,
    instructions,
    input: `Inicia el batch. Limite maximo de eventos: ${MAX_EVENTS}.`,
    tools,
    tool_choice: 'auto',
  });

  let rounds = 0;
  while (rounds < MAX_TOOL_ROUNDS) {
    rounds += 1;
    const calls = extractFunctionCalls(response);
    if (!calls.length) {
      break;
    }

    const outputs = [];
    for (const call of calls) {
      if (call.name === 'get_last_loaded_fight') {
        const rows = await readRange(SHEET_ID, RANGE);
        let latestDate = null;
        let latestRow = null;
        for (const row of rows.slice(1)) {
          const cellDate = parseDateCell(row?.[0]);
          if (!cellDate) continue;
          if (!latestDate || cellDate > latestDate) {
            latestDate = cellDate;
            latestRow = row;
          }
        }
        outputs.push({
          type: 'function_call_output',
          call_id: call.call_id,
          output: JSON.stringify({
            ok: true,
            lastDate: latestDate ? toIso(latestDate) : null,
            lastEvent: latestRow?.[1] || null,
            lastRow: latestRow || null,
            rowCount: rows.length,
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
        const logEntryBase = {
          at: new Date().toISOString(),
          eventName: payload.eventName || null,
          eventDate: payload.eventDate || null,
          rowsAppended: normalized.length,
          sheetId: SHEET_ID,
          range: RANGE,
          dryRun: DRY_RUN,
          model: MODEL,
        };
        summary.eventsProcessed += 1;
        summary.rowsAppended += normalized.length;

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

        if (normalized.length) {
          await writeRange(SHEET_ID, RANGE, normalized, { append: true });
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

    response = await client.responses.create({
      model: MODEL,
      instructions,
      previous_response_id: response.id,
      input: outputs,
      tools,
      tool_choice: 'auto',
    });
  }

  const note = extractResponseText(response);
  const summaryLines = [
    'Resumen history:sync',
    `Eventos procesados: ${summary.eventsProcessed}`,
    `Filas agregadas: ${summary.rowsAppended}`,
    `Dry run: ${summary.dryRun ? 'si' : 'no'}`,
    `Log: ${LOG_PATH}`,
  ];

  return [note, '', summaryLines.join('\n')].filter(Boolean).join('\n');
}

export default { runHistoryScraper };
