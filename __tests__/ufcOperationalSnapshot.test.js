import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  captureOperationalSnapshot,
  captureSqliteSnapshot,
  sanitizeHealthPayload,
  summarizeJournalLines,
} from '../src/bots/ufc/operationalSnapshot.js';

/**
 * Calcula SHA-256 de un archivo para demostrar que la captura no lo modifica.
 *
 * @returns {string} Digest hexadecimal del archivo.
 * @sideEffects Lee el archivo completo.
 */
function fileSha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

/**
 * Construye una DB mínima con ledger y PII deliberada para probar no divulgación.
 *
 * @returns {void}
 * @sideEffects Crea y escribe una base SQLite temporal.
 */
function createFixtureDb(dbPath) {
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE users (
        telegram_user_id TEXT PRIMARY KEY,
        username TEXT,
        first_name TEXT,
        last_name TEXT
      );
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY,
        content TEXT
      );
      CREATE TABLE bets (
        id INTEGER PRIMARY KEY,
        telegram_user_id TEXT,
        event_name TEXT,
        fight TEXT,
        pick TEXT,
        stake REAL,
        result TEXT
      );
      CREATE TABLE bet_mutations (
        id INTEGER PRIMARY KEY,
        telegram_user_id TEXT,
        bet_id INTEGER,
        action TEXT,
        metadata TEXT
      );
      CREATE TABLE ledger_summary (
        telegram_user_id TEXT PRIMARY KEY,
        total_staked REAL,
        total_bets INTEGER
      );
      CREATE TABLE user_credits (
        telegram_user_id TEXT PRIMARY KEY,
        paid_credits REAL,
        free_credits REAL
      );
      CREATE TABLE credit_transactions (
        id INTEGER PRIMARY KEY,
        telegram_user_id TEXT,
        amount REAL,
        type TEXT
      );
      CREATE TABLE mp_processed_payments (
        payment_id TEXT PRIMARY KEY,
        telegram_user_id TEXT,
        credits REAL,
        amount REAL
      );
    `);
    db.prepare('INSERT INTO users VALUES (?, ?, ?, ?)').run(
      'chat-998877',
      'private_handle',
      'Private',
      'Person'
    );
    db.prepare('INSERT INTO messages VALUES (?, ?)').run(1, 'mi apuesta secreta');
    db.prepare('INSERT INTO bets VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      7,
      'chat-998877',
      'UFC Fixture',
      'Alpha vs Beta',
      'Alpha ML',
      25,
      'pending'
    );
    db.prepare('INSERT INTO bet_mutations VALUES (?, ?, ?, ?, ?)').run(
      1,
      'chat-998877',
      7,
      'create',
      '{"private":"detail"}'
    );
    db.prepare('INSERT INTO ledger_summary VALUES (?, ?, ?)').run('chat-998877', 25, 1);
    db.prepare('INSERT INTO user_credits VALUES (?, ?, ?)').run('chat-998877', 3, 1);
    db.prepare('INSERT INTO credit_transactions VALUES (?, ?, ?, ?)').run(
      1,
      'chat-998877',
      -1,
      'usage'
    );
    db.prepare('INSERT INTO mp_processed_payments VALUES (?, ?, ?, ?)').run(
      'payment-private-1',
      'chat-998877',
      10,
      500
    );
  } finally {
    db.close();
  }
}

/**
 * Verifica estabilidad de digests, cero escrituras y sanitización de health/journal.
 *
 * @returns {Promise<void>} Se resuelve al pasar todos los contratos del baseline.
 * @throws {AssertionError|Error} Ante modificación, fuga de PII o digest inestable.
 * @sideEffects Crea y elimina una base SQLite temporal.
 */
export async function runUfcOperationalSnapshotTests() {
  const packageJson = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'));
  assert.equal(
    packageJson.scripts?.['ufc:baseline:capture'],
    'node src/scripts/ufcOperationalSnapshot.js'
  );
  const incidentFixtureDir = path.resolve('__tests__/fixtures/ufc-stabilization');
  const expectedFixtures = [
    'invalid-ufc-329-candidate.json',
    'preview-title-as-fighter.json',
    'stale-live-state.json',
    'restart-storm-303.json',
  ];
  for (const fixtureName of expectedFixtures) {
    const fixturePath = path.join(incidentFixtureDir, fixtureName);
    const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    assert.equal(fixture.fixture_version, 1);
    assert.equal(fixture.anonymized, true);
    assert.ok(fixture.expected, `${fixtureName} debe declarar resultado esperado`);
    assert.doesNotMatch(
      JSON.stringify(fixture),
      /telegram_user_id|chat_id|username|first_name|last_name|bot_token/i,
      `${fixtureName} no debe incluir campos identificables`
    );
  }

  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ufc-operational-snapshot-'));
  const dbPath = path.join(fixtureRoot, 'bot.db');
  createFixtureDb(dbPath);

  try {
    const beforeFileHash = fileSha256(dbPath);
    const first = captureSqliteSnapshot({ dbPath, role: 'ufc' });
    const afterFileHash = fileSha256(dbPath);
    const second = captureSqliteSnapshot({ dbPath, role: 'ufc' });
    const statsShape = captureSqliteSnapshot({ dbPath, role: 'ufc_stats' });

    assert.equal(beforeFileHash, afterFileHash, 'capturar debe ser byte-for-byte read-only');
    assert.deepEqual(first.quick_check, ['ok']);
    assert.equal(statsShape.file.sha256, null);
    assert.equal(statsShape.file.sha256_status, 'omitted_large_read');
    assert.equal(first.tables.find((entry) => entry.name === 'bets')?.row_count, 1);
    assert.equal(first.tables.find((entry) => entry.name === 'messages')?.row_count, 1);
    assert.equal(
      first.protected_tables.find((entry) => entry.name === 'bets')?.content_sha256,
      second.protected_tables.find((entry) => entry.name === 'bets')?.content_sha256,
      'el mismo ledger debe producir el mismo digest'
    );

    const serialized = JSON.stringify(first);
    for (const forbidden of [
      'chat-998877',
      'private_handle',
      'Private',
      'Person',
      'mi apuesta secreta',
      'payment-private-1',
    ]) {
      assert.doesNotMatch(serialized, new RegExp(forbidden), `no debe filtrar ${forbidden}`);
    }

    const fakeExecFile = (command) => {
      if (command === 'systemctl') {
        return [
          'Id=bot-factory@ufc.service',
          'ActiveState=active',
          'SubState=running',
          'MainPID=1234',
          'NRestarts=3',
          'WorkingDirectory=/srv/bot-factory',
        ].join('\n');
      }
      if (command === 'journalctl') {
        return '2026-07-18T12:00:00Z Telegram 409 Conflict token=must-not-persist';
      }
      throw new Error('unexpected fixture command');
    };
    const fakeFetch = async () => ({
      status: 200,
      ok: true,
      async json() {
        return { ok: true, token: 'must-not-persist', runtime: { status: 'healthy' } };
      },
    });
    const operational = await captureOperationalSnapshot({
      dbPath,
      service: 'bot-factory@ufc',
      healthUrl: 'http://127.0.0.1:3000/health',
      fetchImpl: fakeFetch,
      execFile: fakeExecFile,
      capturedAt: '2026-07-18T12:30:00.000Z',
    });
    assert.equal(operational.schema_version, 'ufc-operational-snapshot/v1');
    assert.equal(operational.runtime.systemd.ActiveState, 'active');
    assert.equal(operational.runtime.systemd.NRestarts, 3);
    assert.equal(operational.runtime.health.body.token, '[redacted]');
    assert.equal(operational.runtime.journal.categories.telegram_409_conflict, 1);
    assert.doesNotMatch(JSON.stringify(operational), /must-not-persist/);

    const outputPath = path.join(fixtureRoot, 'snapshot.json');
    const cliResult = spawnSync(
      process.execPath,
      [
        'src/scripts/ufcOperationalSnapshot.js',
        '--db',
        dbPath,
        '--module-root',
        path.resolve('.'),
        '--service',
        'invalid/service',
        '--health-url',
        'http://127.0.0.1:1/health',
        '--out',
        outputPath,
      ],
      { cwd: path.resolve('.'), encoding: 'utf8' }
    );
    assert.equal(cliResult.status, 0, cliResult.stderr || cliResult.stdout);
    assert.ok(fs.existsSync(outputPath));
    const persisted = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    assert.equal(persisted.schema_version, 'ufc-operational-snapshot/v1');
    assert.doesNotMatch(JSON.stringify(persisted), /chat-998877|private_handle/);

    const writable = new Database(dbPath);
    writable.prepare("UPDATE bets SET result = 'won' WHERE id = 7").run();
    writable.close();
    const changed = captureSqliteSnapshot({ dbPath, role: 'ufc' });
    assert.notEqual(
      first.protected_tables.find((entry) => entry.name === 'bets')?.content_sha256,
      changed.protected_tables.find((entry) => entry.name === 'bets')?.content_sha256,
      'una mutación de ledger debe cambiar el digest'
    );

    const health = sanitizeHealthPayload({
      ok: true,
      runtime: { telegram: { status: 'healthy', token: 'bot-secret-token' } },
      chat_id: 'chat-998877',
      username: 'private_handle',
      billing: { last_success_at: '2026-07-18T12:00:00.000Z', api_key: 'billing-secret' },
    });
    assert.equal(health.runtime.telegram.token, '[redacted]');
    assert.equal(health.chat_id, '[redacted]');
    assert.equal(health.username, '[redacted]');
    assert.equal(health.billing.api_key, '[redacted]');
    assert.equal(health.billing.last_success_at, '2026-07-18T12:00:00.000Z');
    assert.doesNotMatch(JSON.stringify(health), /bot-secret-token|private_handle|chat-998877/);

    const journal = summarizeJournalLines([
      '2026-04-01T01:00:00Z Telegram 409 Conflict token=secret',
      '2026-04-01T01:01:00Z Background cache refresh failed for user chat-998877',
      '2026-04-01T01:02:00Z suspicious event candidate UFC 329 Preview',
      '2026-04-01T01:03:00Z Scheduled restart job, restart counter is at 303',
    ]);
    assert.equal(journal.line_count, 4);
    assert.equal(journal.categories.telegram_409_conflict, 1);
    assert.equal(journal.categories.background_refresh_failure, 1);
    assert.equal(journal.categories.suspicious_event_candidate, 1);
    assert.equal(journal.categories.restart_signal, 1);
    assert.equal(journal.latest_timestamp, '2026-04-01T01:03:00.000Z');
    assert.doesNotMatch(JSON.stringify(journal), /secret|chat-998877|Preview/);

    console.log('All UFC operational snapshot tests passed.');
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runUfcOperationalSnapshotTests().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
