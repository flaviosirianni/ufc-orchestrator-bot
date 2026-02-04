import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import '../core/env.js';
import { readRange } from './sheetOpsTool.js';

const DEFAULT_RANGE = process.env.FIGHT_HISTORY_RANGE || 'Fight History!A:Z';
const MAX_HISTORY_ROWS = 12;
const DEFAULT_SYNC_INTERVAL_MS = Number(
  process.env.FIGHT_HISTORY_SYNC_INTERVAL_MS ?? '21600000'
);
const NAME_STOPWORDS = new Set([
  'a',
  'al',
  'ante',
  'con',
  'contra',
  'de',
  'del',
  'el',
  'en',
  'fight',
  'la',
  'las',
  'los',
  'lucha',
  'mi',
  'pelea',
  'por',
  'que',
  'su',
  'sobre',
  'the',
  'vs',
  'v',
  'versus',
]);
const SEARCH_STOPWORDS = new Set([
  ...NAME_STOPWORDS,
  'analiza',
  'analizar',
  'analicemos',
  'apuesta',
  'apuestas',
  'bot',
  'card',
  'cartelera',
  'como',
  'cual',
  'cuales',
  'dame',
  'datos',
  'evento',
  'gustaria',
  'historial',
  'hoy',
  'main',
  'me',
  'opinas',
  'opinion',
  'pelea',
  'pelea',
  'peleador',
  'peleadores',
  'prediccion',
  'quotes',
  'quiero',
  'respecto',
  'saber',
  'semana',
  'sin',
  'sobre',
  'todavia',
  'ufc',
  'una',
  'uno',
  'ver',
]);
const CACHE_DIR = path.resolve(
  process.cwd(),
  process.env.FIGHT_HISTORY_CACHE_DIR || 'data'
);
const CACHE_FILE = path.join(CACHE_DIR, 'fight_history.json');
const META_FILE = path.join(CACHE_DIR, 'fight_history.meta.json');

let syncIntervalHandle = null;
let syncInFlight = null;

function normalise(value) {
  return value ? String(value).toLowerCase() : '';
}

function normaliseWord(word = '') {
  return word
    .replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function toTitleCase(words = []) {
  return words
    .map((part) => {
      const lower = normaliseWord(part);
      return `${lower.charAt(0).toUpperCase()}${lower.slice(1)}`;
    })
    .filter(Boolean)
    .join(' ')
    .trim();
}

function splitWords(message = '') {
  return message
    .replace(/[^\p{L}\s'.-]/gu, ' ')
    .split(/\s+/)
    .map((word) => word.trim())
    .filter(Boolean);
}

function isVsToken(word = '') {
  return /^(vs|versus|v)$/i.test(word.replace('.', ''));
}

function extractNamesAroundVs(words = []) {
  const names = [];

  for (let i = 0; i < words.length; i += 1) {
    if (!isVsToken(words[i])) continue;

    const left = [];
    for (let li = i - 1; li >= 0 && left.length < 1; li -= 1) {
      const token = normaliseWord(words[li]);
      if (!token || NAME_STOPWORDS.has(token)) continue;
      left.unshift(words[li]);
    }

    const right = [];
    for (let ri = i + 1; ri < words.length && right.length < 1; ri += 1) {
      const token = normaliseWord(words[ri]);
      if (!token || NAME_STOPWORDS.has(token)) continue;
      right.push(words[ri]);
    }

    if (left.length) {
      names.push(toTitleCase(left));
    }
    if (right.length) {
      names.push(toTitleCase(right));
    }
  }

  return names;
}

function extractCapitalizedNames(words = []) {
  const names = [];
  let buffer = [];

  for (const rawWord of words) {
    const word = rawWord.replace(/[.'-]/g, '');
    const isCapitalised = word[0] === word[0]?.toUpperCase();

    if (isCapitalised) {
      buffer.push(rawWord);
      if (buffer.length === 2) {
        names.push(toTitleCase(buffer));
        buffer = [];
      }
      continue;
    }

    if (buffer.length >= 2) {
      names.push(toTitleCase(buffer));
    }
    buffer = [];
  }

  if (buffer.length >= 2) {
    names.push(toTitleCase(buffer));
  }

  return names;
}

function extractSearchTokens(message = '', fighters = []) {
  const tokenSet = new Set();

  for (const fighter of fighters) {
    for (const part of fighter.split(/\s+/)) {
      const token = normaliseWord(part);
      if (token && token.length >= 3 && !SEARCH_STOPWORDS.has(token)) {
        tokenSet.add(token);
      }
    }
  }

  for (const part of splitWords(message)) {
    const token = normaliseWord(part);
    if (token && token.length >= 4 && !SEARCH_STOPWORDS.has(token)) {
      tokenSet.add(token);
    }
  }

  return Array.from(tokenSet);
}

function ensureCacheDir() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function readJsonFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (error) {
    console.error(`❌ Failed to parse JSON file ${filePath}:`, error);
    return null;
  }
}

function writeJsonFile(filePath, data) {
  ensureCacheDir();
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

function computeRowsHash(rows) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(rows))
    .digest('hex');
}

export function extractFighterNamesFromMessage(message = '') {
  const words = splitWords(message);
  const names = new Set([
    ...extractNamesAroundVs(words),
    ...extractCapitalizedNames(words),
  ]);

  return Array.from(names).filter(Boolean).slice(0, 6);
}

function isCacheStale(meta, maxAgeMs) {
  if (!meta?.lastSyncAt) {
    return true;
  }

  const ts = Date.parse(meta.lastSyncAt);
  if (Number.isNaN(ts)) {
    return true;
  }

  return Date.now() - ts > maxAgeMs;
}

export function getFightHistoryCacheStatus() {
  return readJsonFile(META_FILE);
}

export function loadFightHistoryCache() {
  const payload = readJsonFile(CACHE_FILE);
  if (!payload || !Array.isArray(payload.rows)) {
    return null;
  }
  return payload;
}

export async function syncFightHistoryCache({
  sheetId = process.env.SHEET_ID,
  range = DEFAULT_RANGE,
  readRangeImpl = readRange,
  force = false,
} = {}) {
  if (!sheetId) {
    throw new Error('SHEET_ID is required to sync fight history cache.');
  }

  if (syncInFlight) {
    return syncInFlight;
  }

  syncInFlight = (async () => {
    const rows = await readRangeImpl(sheetId, range);
    const hash = computeRowsHash(rows);
    const previousMeta = getFightHistoryCacheStatus();
    const updated =
      force ||
      previousMeta?.hash !== hash ||
      previousMeta?.sheetId !== sheetId ||
      previousMeta?.range !== range;
    const now = new Date().toISOString();

    if (updated) {
      writeJsonFile(CACHE_FILE, {
        sheetId,
        range,
        rowCount: rows.length,
        syncedAt: now,
        rows,
      });
    }

    writeJsonFile(META_FILE, {
      sheetId,
      range,
      rowCount: rows.length,
      hash,
      lastSyncAt: now,
      lastSyncUpdatedCache: updated,
    });

    return {
      updated,
      rowCount: rows.length,
      hash,
      rows,
      sheetId,
      range,
    };
  })();

  try {
    return await syncInFlight;
  } finally {
    syncInFlight = null;
  }
}

async function loadHistoryRows({
  sheetId,
  range,
  maxAgeMs = DEFAULT_SYNC_INTERVAL_MS,
  readRangeImpl = readRange,
} = {}) {
  const cached = loadFightHistoryCache();
  const meta = getFightHistoryCacheStatus();

  if (cached?.rows?.length) {
    if (isCacheStale(meta, maxAgeMs)) {
      syncFightHistoryCache({ sheetId, range, readRangeImpl }).catch((error) =>
        console.error('❌ Background cache refresh failed:', error)
      );
    }
    return cached.rows;
  }

  const synced = await syncFightHistoryCache({ sheetId, range, readRangeImpl });
  return synced.rows;
}

export function startFightHistorySync({
  sheetId = process.env.SHEET_ID,
  range = DEFAULT_RANGE,
  intervalMs = DEFAULT_SYNC_INTERVAL_MS,
  readRangeImpl = readRange,
} = {}) {
  if (syncIntervalHandle) {
    return syncIntervalHandle;
  }

  if (!sheetId) {
    console.warn('⚠️ Skipping fight history sync startup because SHEET_ID is missing.');
    return null;
  }

  const runSync = async () => {
    try {
      const result = await syncFightHistoryCache({
        sheetId,
        range,
        readRangeImpl,
      });
      console.log(
        `[fightsScalper] Cache sync ${result.updated ? 'updated' : 'unchanged'} (${result.rowCount} rows)`
      );
    } catch (error) {
      console.error('❌ Scheduled fight history sync failed:', error);
    }
  };

  runSync().catch((error) =>
    console.error('❌ Initial fight history sync failed:', error)
  );

  syncIntervalHandle = setInterval(runSync, intervalMs);
  syncIntervalHandle.unref?.();

  console.log(
    `[fightsScalper] Background sync enabled every ${Math.round(intervalMs / 3600000)} hour(s)`
  );

  return syncIntervalHandle;
}

export function stopFightHistorySync() {
  if (!syncIntervalHandle) {
    return;
  }

  clearInterval(syncIntervalHandle);
  syncIntervalHandle = null;
}

export async function getFighterHistory({
  sheetId = process.env.SHEET_ID,
  range = DEFAULT_RANGE,
  message = '',
  readRangeImpl = readRange,
} = {}) {
  let fighters = extractFighterNamesFromMessage(message);

  const values = await loadHistoryRows({
    sheetId,
    range,
    readRangeImpl,
  });

  let filteredRows = [];
  if (fighters.length) {
    const lowerNames = fighters.map((name) => normalise(name));
    filteredRows = values.filter((row) => {
      const rowValues = row.map(normalise);
      return lowerNames.some((name) => rowValues.some((value) => value.includes(name)));
    });
  }

  // Fallback for noisy queries when fighter tokens exist (e.g. lowercase surnames)
  if (fighters.length && !filteredRows.length) {
    const tokens = extractSearchTokens(message, fighters);
    if (tokens.length) {
      filteredRows = values.filter((row) => {
        const rowJoined = row.map(normalise).join(' ');
        return tokens.some((token) => rowJoined.includes(token));
      });
    }
  }

  const dedupedRows = [];
  const seen = new Set();
  for (const row of filteredRows) {
    const key = JSON.stringify(row);
    if (seen.has(key)) continue;
    seen.add(key);
    dedupedRows.push(row);
  }

  return { fighters, rows: dedupedRows };
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

function formatSyncStatus(result) {
  return [
    `✅ Sync de Fight History completado (${result.rowCount} fila(s)).`,
    `Cache ${result.updated ? 'actualizado' : 'sin cambios'}.`,
  ].join('\n');
}

export async function handleMessage(message = '', deps = {}) {
  const text = String(message || '').trim();
  const sheetId = deps.sheetId ?? process.env.SHEET_ID;
  const range = deps.range ?? DEFAULT_RANGE;
  const getFighterHistoryImpl = deps.getFighterHistoryImpl ?? getFighterHistory;
  const fetchAndStoreUpcomingFightsImpl =
    deps.fetchAndStoreUpcomingFightsImpl ?? fetchAndStoreUpcomingFights;
  const syncFightHistoryCacheImpl = deps.syncFightHistoryCacheImpl ?? syncFightHistoryCache;

  if (!sheetId) {
    return '⚠️ Falta SHEET_ID. Configuralo para consultar historial de peleas.';
  }

  if (!text) {
    return 'Decime una pelea (ej: "Pereira vs Ankalaev") y te busco historial en la Sheet/cache local.';
  }

  const wantsRefresh =
    /\b(sync|cache|refresh|actualiza|actualizar|upcoming|proxim|pr[oó]ximas)\b/i.test(
      text
    );
  if (wantsRefresh) {
    if (/\b(upcoming|proxim|pr[oó]ximas|scrape|scraping)\b/i.test(text)) {
      return fetchAndStoreUpcomingFightsImpl();
    }

    try {
      const result = await syncFightHistoryCacheImpl({ sheetId, range });
      return formatSyncStatus(result);
    } catch (error) {
      console.error('❌ Fight history sync failed:', error);
      return '⚠️ No pude sincronizar Fight History desde Google Sheets.';
    }
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
  syncFightHistoryCache,
  loadFightHistoryCache,
  getFightHistoryCacheStatus,
  startFightHistorySync,
  stopFightHistorySync,
  handleMessage,
};
