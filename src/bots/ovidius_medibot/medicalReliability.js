import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import '../../core/env.js';

const REQUIRED_MEDICAL_TABLES = [
  'med_patients',
  'med_patient_profile',
  'med_episodes',
  'med_documents',
  'med_clinical_insights',
  'med_followup_items',
  'med_user_state',
  'med_operation_receipts',
  'med_usage_records',
];

function ensureDir(dirPath = '') {
  const normalized = String(dirPath || '').trim();
  if (!normalized) return;
  if (!fs.existsSync(normalized)) fs.mkdirSync(normalized, { recursive: true });
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

function resolveDefaultBackupDir(dbPath = '') {
  const normalized = String(dbPath || '').trim();
  if (!normalized) return '';
  return path.join(path.dirname(normalized), 'backups');
}

function isFeatureEnabled(rawValue, fallback = true) {
  if (rawValue === undefined || rawValue === null || rawValue === '') return Boolean(fallback);
  return String(rawValue).toLowerCase() !== 'false';
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
  const probe = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1");
  for (const tableName of requiredTables) {
    const exists = probe.get(String(tableName || '').trim());
    if (!exists) missing.push(tableName);
  }
  return missing;
}

function pruneOldBackups(backupDir, retentionDays) {
  const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const pruned = [];
  const items = fs.readdirSync(backupDir, { withFileTypes: true });
  for (const item of items) {
    if (!item.isFile()) continue;
    if (!item.name.startsWith('medical-backup-') || !item.name.endsWith('.sqlite')) continue;
    const fullPath = path.join(backupDir, item.name);
    const stat = fs.statSync(fullPath);
    if (stat.mtimeMs < cutoffMs) {
      fs.rmSync(fullPath, { force: true });
      pruned.push(fullPath);
    }
  }
  return pruned;
}

export function verifyMedicalDb({
  dbPath = process.env.DB_PATH || '',
  requiredTables = REQUIRED_MEDICAL_TABLES,
} = {}) {
  const normalizedDbPath = String(dbPath || '').trim();
  if (!normalizedDbPath) {
    return { ok: false, error: 'missing_db_path', dbPath: normalizedDbPath, quickCheck: [], missingTables: [...requiredTables] };
  }
  if (!fs.existsSync(normalizedDbPath)) {
    return { ok: false, error: 'db_not_found', dbPath: normalizedDbPath, quickCheck: [], missingTables: [...requiredTables] };
  }

  const db = new Database(normalizedDbPath, { readonly: true, fileMustExist: true });
  try {
    const quickCheck = readQuickCheckMessages(db);
    const missingTables = readMissingTables(db, requiredTables);
    const quickCheckOk = quickCheck.length > 0 && quickCheck.every((msg) => msg.toLowerCase() === 'ok');
    return { ok: quickCheckOk && missingTables.length === 0, dbPath: normalizedDbPath, quickCheck, missingTables, checkedAt: new Date().toISOString() };
  } finally {
    db.close();
  }
}

export async function createMedicalDbBackup({
  dbPath = process.env.DB_PATH || '',
  backupDir = process.env.OVIDIUS_MEDIBOT_DB_BACKUP_DIR || '',
  retentionDays = toPositiveInt(process.env.OVIDIUS_MEDIBOT_DB_BACKUP_RETENTION_DAYS, 14),
  verifyBackup = isFeatureEnabled(process.env.OVIDIUS_MEDIBOT_DB_BACKUP_VERIFY_RESTORE, true),
} = {}) {
  const normalizedDbPath = String(dbPath || '').trim();
  const normalizedBackupDir = String(backupDir || '').trim() || resolveDefaultBackupDir(normalizedDbPath);
  if (!normalizedDbPath) return { ok: false, error: 'missing_db_path' };
  if (!normalizedBackupDir) return { ok: false, error: 'missing_backup_dir' };
  ensureDir(normalizedBackupDir);

  const tempFile = path.join(normalizedBackupDir, `medical-backup-${nowStamp()}.tmp.sqlite`);
  const finalFile = tempFile.replace('.tmp.sqlite', '.sqlite');

  const db = new Database(normalizedDbPath, { readonly: true, fileMustExist: true });
  try {
    await db.backup(tempFile);
  } finally {
    db.close();
  }

  fs.renameSync(tempFile, finalFile);
  fs.chmodSync(finalFile, 0o600);

  const backupVerification = verifyBackup ? verifyMedicalDb({ dbPath: finalFile }) : { ok: true, skipped: true };
  if (!backupVerification.ok) {
    fs.rmSync(finalFile, { force: true });
    return { ok: false, error: 'backup_verification_failed', dbPath: normalizedDbPath, backupDir: normalizedBackupDir, backupFile: finalFile, backupVerification, createdAt: new Date().toISOString() };
  }

  const pruned = pruneOldBackups(normalizedBackupDir, toPositiveInt(retentionDays, 14));
  const stat = fs.statSync(finalFile);

  return {
    ok: true,
    dbPath: normalizedDbPath,
    backupDir: normalizedBackupDir,
    backupFile: finalFile,
    sizeBytes: Number(stat.size) || 0,
    sha256: fileSha256(finalFile),
    backupVerification,
    pruned,
    createdAt: new Date().toISOString(),
  };
}

export function startMedicalDbReliabilityLoop({
  enabled = isFeatureEnabled(process.env.OVIDIUS_MEDIBOT_DB_BACKUP_ENABLED, true),
  dbPath = process.env.DB_PATH || '',
  backupDir = process.env.OVIDIUS_MEDIBOT_DB_BACKUP_DIR || '',
  intervalMs = toPositiveInt(process.env.OVIDIUS_MEDIBOT_DB_BACKUP_INTERVAL_MS, 6 * 60 * 60 * 1000),
  retentionDays = toPositiveInt(process.env.OVIDIUS_MEDIBOT_DB_BACKUP_RETENTION_DAYS, 14),
  verifyBackup = isFeatureEnabled(process.env.OVIDIUS_MEDIBOT_DB_BACKUP_VERIFY_RESTORE, true),
  logger = console,
} = {}) {
  if (!enabled) return { stop() {} };

  let stopped = false;
  let inFlight = false;
  let timer = null;

  const runCycle = async (trigger = 'interval') => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const verification = verifyMedicalDb({ dbPath });
      if (!verification.ok) {
        logger.error(`[medical-db] verification failed (${trigger})`, JSON.stringify(verification));
        return;
      }
      const backupResult = await createMedicalDbBackup({ dbPath, backupDir, retentionDays, verifyBackup });
      if (!backupResult.ok) {
        logger.error(`[medical-db] backup failed (${trigger})`, JSON.stringify(backupResult));
        return;
      }
      logger.log(`[medical-db] backup ok (${trigger}) file=${backupResult.backupFile} size=${backupResult.sizeBytes}`);
    } catch (error) {
      logger.error(`[medical-db] reliability cycle failed (${trigger})`, error);
    } finally {
      inFlight = false;
    }
  };

  void runCycle('startup');
  timer = setInterval(() => {
    void runCycle('interval');
  }, Math.max(60_000, toPositiveInt(intervalMs, 6 * 60 * 60 * 1000)));

  return {
    stop() {
      stopped = true;
      if (timer) { clearInterval(timer); timer = null; }
    },
  };
}
