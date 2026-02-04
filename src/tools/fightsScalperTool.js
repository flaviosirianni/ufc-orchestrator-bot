import '../core/env.js';
import { readRange } from './sheetOpsTool.js';

const DEFAULT_RANGE = 'Fights!A:E';
const MAX_HISTORY_ROWS = 12;

function normalise(value) {
  return value ? String(value).toLowerCase() : '';
}

function extractFighterNamesFromMessage(message = '') {
  const cleaned = message.replace(/[^a-zA-Z\s]/g, ' ');
  const words = cleaned.split(/\s+/).filter(Boolean);

  const names = new Set();
  let buffer = [];

  for (const word of words) {
    const isCapitalised = word[0] === word[0]?.toUpperCase();

    if (isCapitalised) {
      buffer.push(word);
      if (buffer.length === 2) {
        names.add(buffer.join(' '));
        buffer = [];
      }
      continue;
    }

    if (/^vs$/i.test(word) || /^versus$/i.test(word) || /^v$/i.test(word)) {
      if (buffer.length) {
        names.add(buffer.join(' '));
      }
      buffer = [];
      continue;
    }

    if (buffer.length) {
      names.add(buffer.join(' '));
      buffer = [];
    }
  }

  if (buffer.length) {
    names.add(buffer.join(' '));
  }

  if (!names.size && words.includes('vs')) {
    const [left, right] = message.split(/vs|versus|v/gi);
    const normaliseName = (segment = '') =>
      segment
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
        .join(' ');

    const leftName = normaliseName(left);
    const rightName = normaliseName(right);

    if (leftName) {
      names.add(leftName);
    }
    if (rightName) {
      names.add(rightName);
    }
  }

  return Array.from(names).filter(Boolean);
}

export async function getFighterHistory({
  sheetId = process.env.SHEET_ID,
  range = DEFAULT_RANGE,
  message = '',
} = {}) {
  const values = await readRange(sheetId, range);
  const fighters = extractFighterNamesFromMessage(message);

  if (!fighters.length) {
    return { fighters: [], rows: values };
  }

  const lowerNames = fighters.map((name) => normalise(name));
  const filteredRows = values.filter((row) => {
    const rowValues = row.map(normalise);
    return lowerNames.some((name) => rowValues.some((value) => value.includes(name)));
  });

  return { fighters, rows: filteredRows };
}

export async function fetchAndStoreUpcomingFights() {
  return 'Live fight scraping is disabled. Maintain the Google Sheet manually before requesting analysis.';
}

function formatHistoryResult({ fighters, rows }) {
  if (!fighters.length) {
    return [
      'No pude detectar peleadores en tu mensaje.',
      'Ejemplo: "historial de Alex Pereira vs Magomed Ankalaev".',
    ].join('\n');
  }

  if (!rows.length) {
    return `No encontré historial para: ${fighters.join(', ')}.`;
  }

  const preview = rows.slice(0, MAX_HISTORY_ROWS);
  const lines = preview.map((row, index) => `${index + 1}. ${row.join(' | ')}`);
  const hasMore = rows.length > MAX_HISTORY_ROWS;

  return [
    `Encontré ${rows.length} fila(s) para ${fighters.join(' vs ')}:`,
    ...lines,
    hasMore ? `... y ${rows.length - MAX_HISTORY_ROWS} fila(s) más.` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

export async function handleMessage(message = '', deps = {}) {
  const text = String(message || '').trim();
  const sheetId = deps.sheetId ?? process.env.SHEET_ID;
  const range = deps.range ?? DEFAULT_RANGE;
  const getFighterHistoryImpl = deps.getFighterHistoryImpl ?? getFighterHistory;
  const fetchAndStoreUpcomingFightsImpl =
    deps.fetchAndStoreUpcomingFightsImpl ?? fetchAndStoreUpcomingFights;

  if (!sheetId) {
    return '⚠️ Falta SHEET_ID. Configuralo para consultar historial de peleas.';
  }

  if (!text) {
    return 'Decime una pelea (ej: "Pereira vs Ankalaev") y te busco historial en la Sheet.';
  }

  const wantsRefresh = /\b(scrape|scraping|actualiza|actualizar|upcoming|proxim|pr[oó]ximas)\b/i.test(
    text
  );
  if (wantsRefresh) {
    return fetchAndStoreUpcomingFightsImpl();
  }

  try {
    const result = await getFighterHistoryImpl({
      sheetId,
      range,
      message: text,
    });
    return formatHistoryResult(result);
  } catch (error) {
    console.error('❌ Fights Scalper error:', error);
    return '⚠️ Fights Scalper falló al buscar historial.';
  }
}

export default {
  getFighterHistory,
  fetchAndStoreUpcomingFights,
  extractFighterNamesFromMessage,
  handleMessage,
};
