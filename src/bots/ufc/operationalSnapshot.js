import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

export const OPERATIONAL_SNAPSHOT_SCHEMA_VERSION = 'ufc-operational-snapshot/v1';

export const PROTECTED_UFC_TABLES = Object.freeze([
  'bets',
  'bet_mutations',
  'ledger_summary',
  'user_credits',
  'credit_transactions',
  'mp_processed_payments',
]);

const SENSITIVE_KEY_PATTERN =
  /(?:token|secret|password|authorization|api[_-]?key|chat[_-]?id|telegram[_-]?user[_-]?id|username|first[_-]?name|last[_-]?name|content|message|notes|raw|payload)/i;

const SYSTEMD_PROPERTIES = Object.freeze([
  'Id',
  'ActiveState',
  'SubState',
  'MainPID',
  'NRestarts',
  'ExecMainStartTimestamp',
  'WorkingDirectory',
  'FragmentPath',
  'ControlGroup',
]);

/**
 * Produce SHA-256 hexadecimal para evidencia determinística sin divulgar el valor original.
 *
 * @returns {string} Digest hexadecimal.
 * @sideEffects Ninguno.
 */
function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/**
 * Calcula SHA-256 por chunks para no cargar una DB completa en memoria.
 *
 * @returns {string} Digest hexadecimal del archivo.
 * @sideEffects Lee secuencialmente el archivo indicado.
 */
function fileSha256(filePath = '') {
  const hash = crypto.createHash('sha256');
  const descriptor = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest('hex');
}

/**
 * Escapa un identificador SQLite leído desde sqlite_master.
 *
 * @returns {string} Identificador entre comillas dobles.
 * @sideEffects Ninguno.
 */
function quoteIdentifier(identifier = '') {
  return `"${String(identifier).replaceAll('"', '""')}"`;
}

/**
 * Convierte valores SQLite a una representación tipada y estable para hashing.
 *
 * @returns {object} Valor canónico sin pérdida de tipo.
 * @sideEffects Ninguno.
 */
function canonicalizeSqliteValue(value) {
  if (value === null) return { type: 'null', value: null };
  if (Buffer.isBuffer(value)) {
    return { type: 'blob', size: value.length, sha256: sha256(value) };
  }
  if (typeof value === 'number') {
    return { type: 'number', value: Object.is(value, -0) ? '-0' : String(value) };
  }
  return { type: typeof value, value: String(value) };
}

/**
 * Calcula un digest independiente del orden físico de las filas de una tabla protegida.
 *
 * @returns {string} SHA-256 del conjunto de filas y columnas.
 * @sideEffects Lee todas las filas de la tabla indicada.
 */
function digestTableRows(db, tableName = '') {
  const quotedTable = quoteIdentifier(tableName);
  const rows = db.prepare(`SELECT * FROM ${quotedTable}`).iterate();
  const rowDigests = [];
  for (const row of rows) {
    const canonicalRow = Object.keys(row)
      .sort()
      .map((column) => [column, canonicalizeSqliteValue(row[column])]);
    rowDigests.push(sha256(JSON.stringify(canonicalRow)));
  }
  rowDigests.sort();
  return sha256(JSON.stringify(rowDigests));
}

/**
 * Resuelve better-sqlite3 desde el proyecto objetivo, incluso al ejecutar el script desde /tmp.
 *
 * @returns {typeof import('better-sqlite3')} Constructor de Database.
 * @sideEffects Resuelve y carga un módulo Node instalado.
 */
function resolveDatabaseConstructor(moduleRoot = process.cwd()) {
  const requireFromProject = createRequire(path.join(path.resolve(moduleRoot), 'package.json'));
  return requireFromProject('better-sqlite3');
}

/**
 * Captura integridad, esquema, conteos y digests protegidos de una SQLite sin escribirla.
 *
 * @returns {object} Snapshot sin contenidos de filas ni valores identificables.
 * @throws {Error} Si la DB no existe, no abre o falla quick_check.
 * @sideEffects Lee archivo, schema y filas protegidas en modo readonly/query_only.
 */
export function captureSqliteSnapshot({
  dbPath = '',
  role = 'ufc',
  protectedTables = role === 'ufc' ? PROTECTED_UFC_TABLES : [],
  moduleRoot = process.cwd(),
  includeFileSha256 = role === 'ufc',
} = {}) {
  const resolvedDbPath = path.resolve(String(dbPath || '').trim());
  if (!String(dbPath || '').trim() || !fs.existsSync(resolvedDbPath)) {
    throw new Error(`snapshot_db_not_found:${role}`);
  }

  const Database = resolveDatabaseConstructor(moduleRoot);
  const db = new Database(resolvedDbPath, { readonly: true, fileMustExist: true });
  try {
    db.pragma('query_only = ON');
    const quickCheck = db
      .prepare('PRAGMA quick_check')
      .all()
      .map((row) => String(Object.values(row || {})[0] || '').trim())
      .filter(Boolean);
    const schemaRows = db
      .prepare(
        `SELECT name, COALESCE(sql, '') AS sql
           FROM sqlite_master
          WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
          ORDER BY name`
      )
      .all();
    const tables = schemaRows.map((row) => {
      const rowCount = db
        .prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(row.name)}`)
        .get()?.count;
      return {
        name: String(row.name),
        row_count: Number(rowCount) || 0,
        schema_sha256: sha256(String(row.sql || '')),
      };
    });
    const existingTables = new Set(tables.map((entry) => entry.name));
    const protectedSnapshot = [...protectedTables]
      .filter((tableName) => existingTables.has(tableName))
      .sort()
      .map((tableName) => ({
        name: tableName,
        row_count: tables.find((entry) => entry.name === tableName)?.row_count || 0,
        content_sha256: digestTableRows(db, tableName),
      }));
    const missingProtectedTables = [...protectedTables]
      .filter((tableName) => !existingTables.has(tableName))
      .sort();
    const stat = fs.statSync(resolvedDbPath);
    const fileSha = includeFileSha256 ? fileSha256(resolvedDbPath) : null;

    return {
      role,
      db_path: resolvedDbPath,
      quick_check: quickCheck,
      file: {
        size_bytes: Number(stat.size) || 0,
        mtime_iso: stat.mtime.toISOString(),
        sha256: fileSha,
        sha256_status: includeFileSha256 ? 'captured' : 'omitted_large_read',
      },
      table_count: tables.length,
      tables,
      table_counts_sha256: sha256(
        JSON.stringify(tables.map(({ name, row_count: rowCount }) => [name, rowCount]))
      ),
      schema_sha256: sha256(
        JSON.stringify(tables.map(({ name, schema_sha256: schemaHash }) => [name, schemaHash]))
      ),
      protected_tables: protectedSnapshot,
      missing_protected_tables: missingProtectedTables,
    };
  } finally {
    db.close();
  }
}

/**
 * Redacta secretos y campos identificables de un payload health conservando su estructura.
 *
 * @returns {*} Copia sanitizada apta para persistir como evidencia.
 * @sideEffects Ninguno.
 */
export function sanitizeHealthPayload(value, key = '') {
  if (SENSITIVE_KEY_PATTERN.test(String(key || ''))) {
    return '[redacted]';
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeHealthPayload(entry));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        sanitizeHealthPayload(childValue, childKey),
      ])
    );
  }
  if (typeof value === 'string') {
    return value
      .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, '[redacted-token]')
      .replace(/\bBearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [redacted]');
  }
  return value;
}

/**
 * Resume líneas journal por categorías y timestamps sin conservar texto, IDs ni PII.
 *
 * @returns {object} Conteos, rango temporal y digest de categorías.
 * @sideEffects Ninguno.
 */
export function summarizeJournalLines(lines = []) {
  const categories = {
    telegram_409_conflict: 0,
    background_refresh_failure: 0,
    suspicious_event_candidate: 0,
    restart_signal: 0,
    billing_failure: 0,
    odds_api_auth_failure: 0,
    other_error: 0,
  };
  const timestamps = [];
  const categorySequence = [];

  for (const rawLine of lines) {
    const line = String(rawLine || '');
    const timestampMatch = line.match(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})\b/);
    if (timestampMatch) {
      const parsed = new Date(timestampMatch[0]);
      if (!Number.isNaN(parsed.getTime())) timestamps.push(parsed.toISOString());
    }

    let category = '';
    if (/\b409\b.*\bconflict\b|terminated by other getupdates/i.test(line)) {
      category = 'telegram_409_conflict';
    } else if (/background.*refresh.*fail|refresh.*background.*fail/i.test(line)) {
      category = 'background_refresh_failure';
    } else if (/ufc\s*329|suspicious event|\bpreview\b.*fighter|fighter.*\bpreview\b/i.test(line)) {
      category = 'suspicious_event_candidate';
    } else if (/restart counter|scheduled restart|start request repeated|restart storm/i.test(line)) {
      category = 'restart_signal';
    } else if (/billing.*(?:fail|error|unavailable)|(?:fail|error).*billing/i.test(line)) {
      category = 'billing_failure';
    } else if (/odds.*(?:401|unauthori[sz]ed)|(?:401|unauthori[sz]ed).*odds/i.test(line)) {
      category = 'odds_api_auth_failure';
    } else if (/\b(?:error|failed|fatal|exception)\b/i.test(line)) {
      category = 'other_error';
    }
    if (category) {
      categories[category] += 1;
      categorySequence.push(category);
    }
  }

  timestamps.sort();
  return {
    line_count: lines.length,
    categorized_line_count: categorySequence.length,
    categories,
    first_timestamp: timestamps[0] || null,
    latest_timestamp: timestamps.at(-1) || null,
    category_sequence_sha256: sha256(JSON.stringify(categorySequence)),
  };
}

/**
 * Parsea la salida KEY=VALUE de systemctl show con allowlist fija.
 *
 * @returns {object} Propiedades systemd tipadas cuando corresponde.
 * @sideEffects Ninguno.
 */
function parseSystemdShow(output = '') {
  const allowed = new Set(SYSTEMD_PROPERTIES);
  const result = {};
  for (const line of String(output || '').split('\n')) {
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    const key = line.slice(0, separator);
    if (!allowed.has(key)) continue;
    const value = line.slice(separator + 1);
    result[key] = ['MainPID', 'NRestarts'].includes(key) ? Number(value) || 0 : value;
  }
  return result;
}

/**
 * Captura propiedades systemd allowlisted sin leer Environment ni secretos del proceso.
 *
 * @returns {object} Estado y lifecycle del servicio.
 * @sideEffects Ejecuta systemctl show en modo lectura.
 */
export function captureSystemdSnapshot({
  service = 'bot-factory@ufc',
  execFile = execFileSync,
} = {}) {
  if (!/^[a-zA-Z0-9@_.-]+$/.test(service)) {
    throw new Error('snapshot_invalid_service_name');
  }
  const args = ['show', service, ...SYSTEMD_PROPERTIES.flatMap((property) => ['--property', property])];
  const output = execFile('systemctl', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return parseSystemdShow(output);
}

/**
 * Consulta health y redacta campos sensibles antes de devolver cualquier contenido.
 *
 * @returns {Promise<object>} Status HTTP y body sanitizado.
 * @sideEffects Realiza un GET HTTP local.
 */
export async function captureHealthSnapshot({
  healthUrl = 'http://127.0.0.1:3000/health',
  fetchImpl = globalThis.fetch,
} = {}) {
  const response = await fetchImpl(healthUrl, {
    method: 'GET',
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(5_000),
  });
  const body = await response.json();
  return {
    url: healthUrl,
    status: response.status,
    ok: response.ok,
    body: sanitizeHealthPayload(body),
  };
}

/**
 * Lee journal reciente y devuelve sólo el resumen anonimizado.
 *
 * @returns {object} Resumen de categorías sin líneas crudas.
 * @sideEffects Ejecuta journalctl en modo lectura.
 */
export function captureJournalSnapshot({
  service = 'bot-factory@ufc',
  lineLimit = 500,
  execFile = execFileSync,
} = {}) {
  if (!/^[a-zA-Z0-9@_.-]+$/.test(service)) {
    throw new Error('snapshot_invalid_service_name');
  }
  const boundedLimit = Math.min(5_000, Math.max(1, Number(lineLimit) || 500));
  const output = execFile(
    'journalctl',
    ['-u', service, '-n', String(boundedLimit), '--no-pager', '-o', 'short-iso'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  );
  return summarizeJournalLines(String(output || '').split('\n').filter(Boolean));
}

/**
 * Describe un path operativo sin leer ni publicar su contenido.
 *
 * @returns {object} Existencia, tipo, tamaño y mtime.
 * @sideEffects Ejecuta stat sobre el path.
 */
export function capturePathMetadata(targetPath = '') {
  const resolvedPath = path.resolve(String(targetPath || '').trim());
  if (!String(targetPath || '').trim() || !fs.existsSync(resolvedPath)) {
    return { path: resolvedPath, exists: false };
  }
  const stat = fs.statSync(resolvedPath);
  return {
    path: resolvedPath,
    exists: true,
    type: stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : 'other',
    size_bytes: Number(stat.size) || 0,
    mtime_iso: stat.mtime.toISOString(),
  };
}

/**
 * Ensambla el baseline operativo UFC a partir de lecturas locales no mutantes.
 *
 * @returns {Promise<object>} Documento versionado y sanitizado para comparación futura.
 * @sideEffects Lee SQLite/paths, consulta health y ejecuta systemctl/journalctl.
 */
export async function captureOperationalSnapshot({
  dbPath = '',
  statsDbPath = '',
  moduleRoot = process.cwd(),
  service = 'bot-factory@ufc',
  healthUrl = 'http://127.0.0.1:3000/health',
  journalLines = 500,
  gitSha = '',
  fetchImpl = globalThis.fetch,
  execFile = execFileSync,
  capturedAt = new Date().toISOString(),
} = {}) {
  const databases = {
    ufc: captureSqliteSnapshot({ dbPath, role: 'ufc', moduleRoot }),
  };
  if (String(statsDbPath || '').trim()) {
    databases.ufc_stats = captureSqliteSnapshot({
      dbPath: statsDbPath,
      role: 'ufc_stats',
      protectedTables: [],
      moduleRoot,
    });
  }

  const runtime = {};
  try {
    runtime.systemd = captureSystemdSnapshot({ service, execFile });
  } catch {
    runtime.systemd = { available: false, error: 'systemd_snapshot_failed' };
  }
  try {
    runtime.health = await captureHealthSnapshot({ healthUrl, fetchImpl });
  } catch {
    runtime.health = { available: false, error: 'health_snapshot_failed', url: healthUrl };
  }
  try {
    runtime.journal = captureJournalSnapshot({ service, lineLimit: journalLines, execFile });
  } catch {
    runtime.journal = { available: false, error: 'journal_snapshot_failed' };
  }

  return {
    schema_version: OPERATIONAL_SNAPSHOT_SCHEMA_VERSION,
    captured_at: capturedAt,
    git_sha: String(gitSha || '').trim() || null,
    host: {
      hostname_sha256_prefix: sha256(os.hostname()).slice(0, 16),
      platform: os.platform(),
      arch: os.arch(),
    },
    privacy: {
      row_values_persisted: false,
      sensitive_health_fields_redacted: true,
      raw_journal_lines_persisted: false,
    },
    paths: {
      ufc_db: capturePathMetadata(dbPath),
      ufc_stats_db: statsDbPath ? capturePathMetadata(statsDbPath) : null,
    },
    databases,
    runtime,
  };
}
