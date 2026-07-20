import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { evaluateEventTruth } from '../src/core/eventTruthGate.js';

/**
 * Crea el esquema legacy mínimo para probar una migración in-place compatible.
 *
 * @returns {void}
 * @sideEffects Escribe una DB SQLite temporal.
 */
function createLegacyEventState(dbPath) {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE event_watch_state (
      watch_key TEXT PRIMARY KEY,
      event_id TEXT,
      event_name TEXT NOT NULL,
      event_date_utc TEXT,
      event_status TEXT,
      source_primary TEXT,
      source_secondary TEXT,
      main_card_json TEXT NOT NULL,
      monitored_fighters_json TEXT NOT NULL,
      last_reconciled_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  db.prepare(
    `INSERT INTO event_watch_state
      (watch_key, event_id, event_name, event_date_utc, event_status,
       source_primary, source_secondary, main_card_json, monitored_fighters_json,
       last_reconciled_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    'next_event',
    'legacy_event',
    'Legacy Event',
    '2026-07-25',
    'scheduled',
    'legacy.example',
    null,
    JSON.stringify([
      {
        fightId: 'legacy_fight',
        fighterA: 'Legacy Alpha',
        fighterB: 'Legacy Beta',
      },
    ]),
    JSON.stringify(['Legacy Alpha', 'Legacy Beta']),
    '2026-07-18T10:00:00.000Z',
    '2026-07-18T10:00:00.000Z'
  );
  db.close();
}

export async function runEventTruthStoreTests() {
  const previousDbPath = process.env.DB_PATH;
  const previousQuickCheck = process.env.DB_STARTUP_QUICK_CHECK;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ufc-event-truth-store-'));
  const dbPath = path.join(tempDir, 'bot.db');
  let db = null;

  try {
    createLegacyEventState(dbPath);
    process.env.DB_PATH = dbPath;
    process.env.DB_STARTUP_QUICK_CHECK = 'false';

    const moduleUrl = new URL(`../src/core/sqliteStore.js?eventTruth=${Date.now()}`, import.meta.url);
    const store = await import(moduleUrl.href);
    db = store.getDb();

    const legacy = store.getEventWatchState('next_event');
    assert.equal(legacy?.eventId, 'legacy_event');
    assert.equal(legacy?.confidence, 'invalid');
    assert.equal(legacy?.consumerAllowed, false);
    assert.equal(legacy?.ledgerMutationAllowed, false);
    assert.ok(legacy?.verificationReasons?.includes('verification_missing'));
    assert.deepEqual(store.listEventVerificationRuns({ watchKey: 'next_event' }), []);

    const candidate = {
      watchKey: 'next_event',
      eventId: 'verified_event_2026_07_25',
      eventName: 'UFC Verified Store Fixture',
      eventDateUtc: '2026-07-25',
      eventStatus: 'scheduled',
      sourcePrimary: 'ufc.example',
      sourceSecondary: 'odds.example',
      mainCard: [
        {
          fightId: 'verified_fight',
          fighterA: 'Verified Alpha',
          fighterB: 'Verified Beta',
        },
      ],
      monitoredFighters: ['Verified Alpha', 'Verified Beta'],
      lastReconciledAt: '2026-07-18T12:00:00.000Z',
    };
    const verification = evaluateEventTruth({
      watchKey: 'next_event',
      candidate,
      verification: {
        compatibleSourceCount: 2,
        structuredCardSource: true,
        verifiedAt: '2026-07-18T12:00:00.000Z',
      },
      now: '2026-07-18T12:01:00.000Z',
    });

    const saved = store.upsertEventWatchState({ ...candidate, verification }, 'next_event');
    assert.equal(saved?.confidence, 'verified');
    assert.equal(saved?.consumerAllowed, true);
    assert.equal(saved?.ledgerMutationAllowed, false);
    assert.equal(saved?.verificationVersion, 'event-truth/v1');
    assert.equal(saved?.lastVerifiedAt, '2026-07-18T12:00:00.000Z');
    assert.match(saved?.candidateHash || '', /^[a-f0-9]{64}$/);

    const verifiedRuns = store.listEventVerificationRuns({
      watchKey: 'next_event',
      limit: 10,
    });
    assert.equal(verifiedRuns.length, 1);
    assert.equal(verifiedRuns[0]?.eventId, candidate.eventId);
    assert.equal(verifiedRuns[0]?.confidence, 'verified');
    assert.equal(verifiedRuns[0]?.consumerAllowed, true);
    assert.equal(verifiedRuns[0]?.candidateHash, verification.candidateHash);

    const unsafe = store.upsertEventWatchState(
      {
        ...candidate,
        eventId: 'unverified_replacement',
        eventName: 'Unverified Replacement',
        verification: null,
      },
      'next_event'
    );
    assert.equal(unsafe?.confidence, 'invalid');
    assert.equal(unsafe?.consumerAllowed, false);
    assert.ok(unsafe?.verificationReasons?.includes('verification_missing'));

    const allRuns = store.listEventVerificationRuns({ watchKey: 'next_event', limit: 10 });
    assert.equal(allRuns.length, 2);
    assert.equal(allRuns[0]?.eventId, 'unverified_replacement');
    assert.equal(allRuns[0]?.confidence, 'invalid');
    assert.ok(allRuns[0]?.reasons?.includes('verification_missing'));
  } finally {
    if (db?.open) db.close();
    if (previousDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = previousDbPath;
    if (previousQuickCheck === undefined) delete process.env.DB_STARTUP_QUICK_CHECK;
    else process.env.DB_STARTUP_QUICK_CHECK = previousQuickCheck;
  }

  console.log('All event truth store tests passed.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runEventTruthStoreTests().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
