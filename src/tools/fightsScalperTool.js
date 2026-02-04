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
  const fighters = extractFighterNamesFromMessage(message);

  if (!fighters.length) {
    return { fighters: [], rows: [] };
  }

  const values = await loadHistoryRows({
    sheetId,
    range,
    readRangeImpl,
  });
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
