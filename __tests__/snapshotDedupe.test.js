import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

function projectionSnapshot(overrides = {}) {
  return {
    eventId: 'event_dedupe',
    fightId: 'fight_dedupe',
    fighterA: 'Dedupe Alpha',
    fighterB: 'Dedupe Beta',
    predictedWinner: 'Dedupe Alpha',
    predictedMethod: 'decision_lean',
    confidencePct: 61.5,
    keyFactors: ['fixture factor'],
    relevantNewsIds: [1, 2],
    reasoningVersion: 'v1_fixture',
    changedFromPrev: false,
    changeSummary: null,
    ...overrides,
  };
}

function scoringSnapshot(overrides = {}) {
  return {
    eventId: 'event_dedupe',
    fightId: 'fight_dedupe',
    fighterA: 'Dedupe Alpha',
    fighterB: 'Dedupe Beta',
    marketKey: 'moneyline',
    selection: 'Dedupe Alpha',
    recommendation: 'lean',
    edgePct: 4.25,
    confidencePct: 61.5,
    riskLevel: 'medium',
    suggestedStakeUnits: 0.5,
    noBetReason: null,
    modelProbabilityPct: 61.5,
    impliedProbabilityPct: 57.25,
    consensusOdds: 1.75,
    booksCount: 4,
    inputs: { projectionHash: 'fixture', books: 4 },
    reasoningVersion: 'v1_fixture',
    ...overrides,
  };
}

export async function runSnapshotDedupeTests() {
  const previousDbPath = process.env.DB_PATH;
  const previousQuickCheck = process.env.DB_STARTUP_QUICK_CHECK;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ufc-snapshot-dedupe-'));
  const dbPath = path.join(tempDir, 'bot.db');
  let db = null;

  try {
    process.env.DB_PATH = dbPath;
    process.env.DB_STARTUP_QUICK_CHECK = 'false';
    const moduleUrl = new URL(`../src/core/sqliteStore.js?dedupe=${Date.now()}`, import.meta.url);
    const store = await import(moduleUrl.href);
    db = store.getDb();

    let projectionInserted = 0;
    let scoringInserted = 0;
    const startMs = Date.parse('2026-07-18T00:00:00.000Z');
    for (let cycle = 0; cycle < 96; cycle += 1) {
      const createdAt = new Date(startMs + cycle * 15 * 60 * 1000).toISOString();
      projectionInserted += store.insertFightProjectionSnapshots([
        projectionSnapshot({ createdAt }),
      ]).insertedCount;
      scoringInserted += store.insertFightBetScoringSnapshots([
        scoringSnapshot({ createdAt }),
      ]).insertedCount;
    }

    assert.equal(projectionInserted, 1);
    assert.equal(scoringInserted, 1);
    assert.equal(
      Number(db.prepare('SELECT COUNT(*) AS count FROM fight_projection_snapshots').get()?.count),
      1
    );
    assert.equal(
      Number(db.prepare('SELECT COUNT(*) AS count FROM fight_bet_scoring_snapshots').get()?.count),
      1
    );

    const changedProjection = store.insertFightProjectionSnapshots([
      projectionSnapshot({ confidencePct: 67.5, createdAt: '2026-07-19T00:15:00.000Z' }),
    ]);
    const changedScoring = store.insertFightBetScoringSnapshots([
      scoringSnapshot({ edgePct: 6.25, createdAt: '2026-07-19T00:15:00.000Z' }),
    ]);
    assert.equal(changedProjection.insertedCount, 1);
    assert.equal(changedScoring.insertedCount, 1);

    const projectionHashes = db
      .prepare('SELECT snapshot_hash FROM fight_projection_snapshots ORDER BY id')
      .all();
    const scoringHashes = db
      .prepare('SELECT snapshot_hash FROM fight_bet_scoring_snapshots ORDER BY id')
      .all();
    assert.equal(new Set(projectionHashes.map((row) => row.snapshot_hash)).size, 2);
    assert.equal(new Set(scoringHashes.map((row) => row.snapshot_hash)).size, 2);
    assert.ok(projectionHashes.every((row) => /^[a-f0-9]{64}$/.test(row.snapshot_hash)));
    assert.ok(scoringHashes.every((row) => /^[a-f0-9]{64}$/.test(row.snapshot_hash)));

    assert.equal(
      store.getLatestProjectionForFight({
        eventId: 'event_dedupe',
        fightId: 'fight_dedupe',
      }).snapshotHash,
      projectionHashes[1].snapshot_hash
    );
    assert.equal(
      store.getLatestBetScoringForFight({
        eventId: 'event_dedupe',
        fightId: 'fight_dedupe',
        marketKey: 'moneyline',
      }).snapshotHash,
      scoringHashes[1].snapshot_hash
    );

    db.close();
    db = null;

    const legacyDbPath = path.join(tempDir, 'legacy-bot.db');
    const legacyDb = new Database(legacyDbPath);
    legacyDb.exec(`
      CREATE TABLE fight_projection_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL,
        fight_id TEXT NOT NULL,
        fighter_a TEXT NOT NULL,
        fighter_b TEXT NOT NULL,
        predicted_winner TEXT,
        predicted_method TEXT,
        confidence_pct REAL,
        key_factors_json TEXT NOT NULL,
        relevant_news_ids_json TEXT NOT NULL,
        reasoning_version TEXT NOT NULL,
        changed_from_prev INTEGER NOT NULL DEFAULT 0,
        change_summary TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE fight_bet_scoring_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL,
        fight_id TEXT NOT NULL,
        fighter_a TEXT NOT NULL,
        fighter_b TEXT NOT NULL,
        market_key TEXT NOT NULL,
        selection TEXT,
        recommendation TEXT NOT NULL,
        edge_pct REAL,
        confidence_pct REAL,
        risk_level TEXT,
        suggested_stake_units REAL,
        suggested_stake_amount REAL,
        no_bet_reason TEXT,
        model_probability_pct REAL,
        implied_probability_pct REAL,
        consensus_odds REAL,
        books_count INTEGER NOT NULL DEFAULT 0,
        inputs_json TEXT NOT NULL,
        reasoning_version TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT INTO fight_projection_snapshots
        (event_id, fight_id, fighter_a, fighter_b, key_factors_json,
         relevant_news_ids_json, reasoning_version, created_at)
      VALUES ('legacy_event', 'legacy_fight', 'Legacy A', 'Legacy B', '[]', '[]', 'v0',
              '2026-04-01T00:00:00.000Z');
      INSERT INTO fight_bet_scoring_snapshots
        (event_id, fight_id, fighter_a, fighter_b, market_key, recommendation,
         books_count, inputs_json, reasoning_version, created_at)
      VALUES ('legacy_event', 'legacy_fight', 'Legacy A', 'Legacy B', 'moneyline', 'no_bet',
              0, '{}', 'v0', '2026-04-01T00:00:00.000Z');
    `);
    legacyDb.close();

    process.env.DB_PATH = legacyDbPath;
    const legacyModuleUrl = new URL(
      `../src/core/sqliteStore.js?legacy-dedupe=${Date.now()}`,
      import.meta.url
    );
    const legacyStore = await import(legacyModuleUrl.href);
    db = legacyStore.getDb();
    assert.ok(
      db.prepare("PRAGMA table_info('fight_projection_snapshots')")
        .all()
        .some((column) => column.name === 'snapshot_hash')
    );
    assert.ok(
      db.prepare("PRAGMA table_info('fight_bet_scoring_snapshots')")
        .all()
        .some((column) => column.name === 'snapshot_hash')
    );
    assert.equal(
      Number(db.prepare('SELECT COUNT(*) AS count FROM fight_projection_snapshots').get()?.count),
      1
    );
    assert.equal(
      Number(db.prepare('SELECT COUNT(*) AS count FROM fight_bet_scoring_snapshots').get()?.count),
      1
    );
    assert.equal(
      legacyStore.insertFightProjectionSnapshots([
        projectionSnapshot({ eventId: 'legacy_event', fightId: 'legacy_fight' }),
      ]).insertedCount,
      1
    );
    assert.equal(
      legacyStore.insertFightBetScoringSnapshots([
        scoringSnapshot({ eventId: 'legacy_event', fightId: 'legacy_fight' }),
      ]).insertedCount,
      1
    );
  } finally {
    if (db?.open) db.close();
    if (previousDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = previousDbPath;
    if (previousQuickCheck === undefined) delete process.env.DB_STARTUP_QUICK_CHECK;
    else process.env.DB_STARTUP_QUICK_CHECK = previousQuickCheck;
  }

  console.log('All snapshot dedupe tests passed.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runSnapshotDedupeTests().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
