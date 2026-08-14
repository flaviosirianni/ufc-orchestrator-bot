import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import '../../core/env.js';

export const REQUIRED_UFC_TABLES = [
  'users',
  'chats',
  'sessions',
  'messages',
  'user_profiles',
  'bets',
  'bet_mutations',
  'ledger_summary',
  'odds_snapshots',
  'fight_history_cache',
  'usage_records',
  'odds_api_cache',
  'odds_events_index',
];

function ensureDir(dirPath = '') {
  const normalized = String(dirPath || '').trim();
  if (!normalized) return;
  if (!fs.existsSync(normalized)) {
    fs.mkdirSync(normalized, { recursive: true });
  }
}

function fileSha256(filePath = '') {
  const normalized = String(filePath || '').trim();
  if (!normalized || !fs.existsSync(normalized)) return '';
  const payload = fs.readFileSync(normalized);
  return crypto.createHash('sha256').update(payload).digest('hex');
}

function nowStamp() {
  return new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
}

function toPositiveInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return Number(fallback) || 0;
  return Math.round(parsed);
}

function toPositiveIntList(value, fallback = []) {
  const raw = String(value || '').trim();
  if (!raw) return [...fallback];
  const parsed = raw
    .split(',')
    .map((item) => toPositiveInt(item.trim(), 0))
    .filter((item) => item > 0);
  return parsed.length ? parsed : [...fallback];
}

function readQuickCheckMessages(db) {
  const rows = db.prepare('PRAGMA quick_check').all();
  return rows
    .map((row) => Object.values(row || {})[0])
    .map((value) => String(value || '').trim())
    .filter(Boolean);
}

function readMissingTables(db, requiredTables = []) {
  const missing = [];
  const probe = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1"
  );
  for (const tableName of requiredTables) {
    const exists = probe.get(String(tableName || '').trim());
    if (!exists) {
      missing.push(tableName);
    }
  }
  return missing;
}

/**
 * Poda backups con retención escalonada tipo grandfather-father-son: conserva
 * todo dentro de `recentDays` (para rollback rápido), y de lo más viejo que
 * eso guarda a lo sumo un snapshot por cada antigüedad objetivo en
 * `milestoneDays` (el más cercano disponible a esa antigüedad), borrando el
 * resto.
 *
 * @returns {string[]} Paths absolutos de los backups eliminados.
 * @sideEffects Elimina archivos `ufc-backup-*.sqlite` del directorio dado.
 */
export function pruneOldBackups(backupDir, { recentDays, milestoneDays = [] } = {}) {
  const nowMs = Date.now();
  const recentCutoffMs = nowMs - recentDays * 24 * 60 * 60 * 1000;
  const items = fs.readdirSync(backupDir, { withFileTypes: true });
  const backups = [];
  for (const item of items) {
    if (!item.isFile()) continue;
    if (!item.name.startsWith('ufc-backup-') || !item.name.endsWith('.sqlite')) continue;
    const fullPath = path.join(backupDir, item.name);
    const stat = fs.statSync(fullPath);
    backups.push({ fullPath, mtimeMs: stat.mtimeMs });
  }

  const keep = new Set();
  const older = [];
  for (const backup of backups) {
    if (backup.mtimeMs >= recentCutoffMs) {
      keep.add(backup.fullPath);
    } else {
      older.push(backup);
    }
  }

  for (const daysAgo of milestoneDays) {
    const targetMs = nowMs - Number(daysAgo) * 24 * 60 * 60 * 1000;
    let closest = null;
    let closestDeltaMs = Infinity;
    for (const backup of older) {
      const deltaMs = Math.abs(backup.mtimeMs - targetMs);
      if (deltaMs < closestDeltaMs) {
        closestDeltaMs = deltaMs;
        closest = backup;
      }
    }
    if (closest) {
      keep.add(closest.fullPath);
    }
  }

  const pruned = [];
  for (const backup of backups) {
    if (!keep.has(backup.fullPath)) {
      fs.rmSync(backup.fullPath, { force: true });
      pruned.push(backup.fullPath);
    }
  }
  return pruned;
}

function resolveDefaultBackupDir(dbPath = '') {
  const normalizedDbPath = String(dbPath || '').trim();
  if (!normalizedDbPath) return '';
  return path.join(path.dirname(normalizedDbPath), 'backups');
}

function isFeatureEnabled(rawValue, fallback = true) {
  if (rawValue === undefined || rawValue === null || rawValue === '') {
    return Boolean(fallback);
  }
  return String(rawValue).toLowerCase() !== 'false';
}

export function verifyUfcDb({
  dbPath = process.env.DB_PATH || '',
  requiredTables = REQUIRED_UFC_TABLES,
} = {}) {
  const normalizedDbPath = String(dbPath || '').trim();
  if (!normalizedDbPath) {
    return {
      ok: false,
      error: 'missing_db_path',
      dbPath: normalizedDbPath,
      quickCheck: [],
      missingTables: [...requiredTables],
    };
  }
  if (!fs.existsSync(normalizedDbPath)) {
    return {
      ok: false,
      error: 'db_not_found',
      dbPath: normalizedDbPath,
      quickCheck: [],
      missingTables: [...requiredTables],
    };
  }

  const db = new Database(normalizedDbPath, { readonly: true, fileMustExist: true });
  try {
    const quickCheck = readQuickCheckMessages(db);
    const missingTables = readMissingTables(db, requiredTables);
    const quickCheckOk = quickCheck.length > 0 && quickCheck.every((msg) => msg.toLowerCase() === 'ok');
    return {
      ok: quickCheckOk && missingTables.length === 0,
      dbPath: normalizedDbPath,
      quickCheck,
      missingTables,
      checkedAt: new Date().toISOString(),
    };
  } finally {
    db.close();
  }
}

export async function createUfcDbBackup({
  dbPath = process.env.DB_PATH || '',
  backupDir = process.env.UFC_DB_BACKUP_DIR || '',
  recentDays = toPositiveInt(process.env.UFC_DB_BACKUP_RECENT_DAYS, 5),
  milestoneDays = toPositiveIntList(process.env.UFC_DB_BACKUP_MILESTONE_DAYS, [15, 30, 60, 90]),
  verifyBackup = isFeatureEnabled(process.env.UFC_DB_BACKUP_VERIFY_RESTORE, true),
} = {}) {
  const normalizedDbPath = String(dbPath || '').trim();
  const resolvedBackupDir = String(backupDir || '').trim() || resolveDefaultBackupDir(normalizedDbPath);
  if (!normalizedDbPath) {
    return { ok: false, error: 'missing_db_path' };
  }
  if (!resolvedBackupDir) {
    return { ok: false, error: 'missing_backup_dir' };
  }
  ensureDir(resolvedBackupDir);

  const tempFile = path.join(resolvedBackupDir, `ufc-backup-${nowStamp()}.tmp.sqlite`);
  const finalFile = tempFile.replace('.tmp.sqlite', '.sqlite');

  const db = new Database(normalizedDbPath, { readonly: true, fileMustExist: true });
  try {
    await db.backup(tempFile);
  } finally {
    db.close();
  }

  fs.renameSync(tempFile, finalFile);
  fs.chmodSync(finalFile, 0o600);
  const backupVerification = verifyBackup
    ? verifyUfcDb({ dbPath: finalFile })
    : { ok: true, skipped: true };
  if (!backupVerification.ok) {
    fs.rmSync(finalFile, { force: true });
    return {
      ok: false,
      error: 'backup_verification_failed',
      dbPath: normalizedDbPath,
      backupDir: resolvedBackupDir,
      backupFile: finalFile,
      backupVerification,
      createdAt: new Date().toISOString(),
    };
  }
  const pruned = pruneOldBackups(resolvedBackupDir, {
    recentDays: toPositiveInt(recentDays, 5),
    milestoneDays,
  });
  const stat = fs.statSync(finalFile);

  return {
    ok: true,
    dbPath: normalizedDbPath,
    backupDir: resolvedBackupDir,
    backupFile: finalFile,
    sizeBytes: Number(stat.size) || 0,
    sha256: fileSha256(finalFile),
    backupVerification,
    pruned,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Inicia verificación y backup periódicos de la DB UFC con estado observable.
 *
 * @returns {{stop:Function,getStatus:Function}} Control del loop y snapshot seguro.
 * @sideEffects Puede verificar, respaldar y podar backups según configuración.
 */
export function startUfcDbReliabilityLoop({
  enabled = isFeatureEnabled(process.env.UFC_DB_BACKUP_ENABLED, true),
  dbPath = process.env.DB_PATH || '',
  backupDir = process.env.UFC_DB_BACKUP_DIR || '',
  intervalMs = toPositiveInt(process.env.UFC_DB_BACKUP_INTERVAL_MS, 6 * 60 * 60 * 1000),
  recentDays = toPositiveInt(process.env.UFC_DB_BACKUP_RECENT_DAYS, 5),
  milestoneDays = toPositiveIntList(process.env.UFC_DB_BACKUP_MILESTONE_DAYS, [15, 30, 60, 90]),
  verifyBackup = isFeatureEnabled(process.env.UFC_DB_BACKUP_VERIFY_RESTORE, true),
  logger = console,
} = {}) {
  const status = {
    enabled: Boolean(enabled),
    inFlight: false,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastError: null,
  };
  /**
   * @returns {object} Copia read-only del último ciclo de mantenimiento.
   * @sideEffects Ninguno.
   */
  const getStatus = () => ({ ...status });
  if (!enabled) {
    return { stop() {}, getStatus };
  }

  let stopped = false;
  let inFlight = false;
  let timer = null;

  const runCycle = async (trigger = 'interval') => {
    if (stopped || inFlight) return;
    inFlight = true;
    status.inFlight = true;
    status.lastAttemptAt = new Date().toISOString();
    try {
      const verification = verifyUfcDb({ dbPath });
      if (!verification.ok) {
        status.lastError = 'ufc_db_verification_failed';
        logger.error(`[ufc-db] verification failed (${trigger})`, JSON.stringify(verification));
        return;
      }
      const backupResult = await createUfcDbBackup({
        dbPath,
        backupDir,
        recentDays,
        milestoneDays,
        verifyBackup,
      });
      if (!backupResult.ok) {
        status.lastError = backupResult.error || 'ufc_db_backup_failed';
        logger.error(`[ufc-db] backup failed (${trigger})`, JSON.stringify(backupResult));
        return;
      }
      status.lastSuccessAt = backupResult.createdAt || new Date().toISOString();
      status.lastError = null;
      logger.log(
        `[ufc-db] backup ok (${trigger}) file=${backupResult.backupFile} size=${backupResult.sizeBytes}`
      );
    } catch (error) {
      status.lastError = 'ufc_db_maintenance_cycle_failed';
      logger.error(`[ufc-db] reliability cycle failed (${trigger})`, error);
    } finally {
      inFlight = false;
      status.inFlight = false;
    }
  };

  void runCycle('startup');
  timer = setInterval(() => {
    void runCycle('interval');
  }, Math.max(60_000, toPositiveInt(intervalMs, 6 * 60 * 60 * 1000)));

  return {
    getStatus,
    stop() {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
