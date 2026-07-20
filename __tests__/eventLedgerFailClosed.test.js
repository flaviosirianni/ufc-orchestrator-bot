import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAutoSettlementCycle } from '../src/core/autoSettlement.js';

export async function runEventLedgerFailClosedTests() {
  const previousDbPath = process.env.DB_PATH;
  const previousQuickCheck = process.env.DB_STARTUP_QUICK_CHECK;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ufc-event-ledger-guard-'));
  const dbPath = path.join(tempDir, 'bot.db');
  let db = null;

  try {
    process.env.DB_PATH = dbPath;
    process.env.DB_STARTUP_QUICK_CHECK = 'false';
    const moduleUrl = new URL(`../src/core/sqliteStore.js?ledgerGuard=${Date.now()}`, import.meta.url);
    const store = await import(moduleUrl.href);
    db = store.getDb();

    const bet = store.addBetRecord('guard-user', {
      eventName: 'UFC Guard Fixture',
      fight: 'Guard Alpha vs Guard Beta',
      pick: 'Guard Alpha ML',
      odds: 1.8,
      stake: 1000,
      units: 1,
      result: 'pending',
    });
    store.upsertEventWatchState(
      {
        eventId: 'unverified_completed_fixture',
        eventName: 'UFC Guard Fixture',
        eventDateUtc: '2026-07-18',
        eventStatus: 'completed',
        sourcePrimary: 'legacy.example',
        mainCard: [
          {
            fightId: 'guard_fight',
            fighterA: 'Guard Alpha',
            fighterB: 'Guard Beta',
          },
        ],
        monitoredFighters: ['Guard Alpha', 'Guard Beta'],
      },
      'current_event'
    );

    const beforeBet = store.listUserBets('guard-user', { limit: 10 })[0];
    const beforeMutations = Number(
      db.prepare('SELECT COUNT(*) AS count FROM bet_mutations').get()?.count || 0
    );

    const result = await runAutoSettlementCycle({
      getEventWatchState: store.getEventWatchState,
      getStatsFreshness: () => ({
        isAvailable: true,
        generatedAt: '2026-04-01T18:58:10.834Z',
      }),
      getFightHistoryRows: () => [
        [
          '2026-07-18',
          'UFC Guard Fixture',
          'Guard Alpha',
          'Guard Beta',
          '',
          'Guard Alpha',
          'Decision',
          '3',
        ],
      ],
      listPendingBetsForAutoSettlement: store.listPendingBetsForAutoSettlement,
      applyBetMutation: store.applyBetMutation,
      now: '2026-07-18T12:00:00.000Z',
      statsMaxAgeHours: 36,
    });

    const afterBet = store.listUserBets('guard-user', { limit: 10 })[0];
    const afterMutations = Number(
      db.prepare('SELECT COUNT(*) AS count FROM bet_mutations').get()?.count || 0
    );
    assert.equal(result.blocked, true);
    assert.ok(result.reasons.includes('event_confidence_invalid'));
    assert.ok(result.reasons.includes('stats_stale'));
    assert.equal(afterBet?.id, bet.id);
    assert.equal(beforeBet?.result, 'pending');
    assert.equal(afterBet?.result, 'pending');
    assert.equal(afterBet?.settledAt, null);
    assert.equal(afterMutations, beforeMutations);
  } finally {
    if (db?.open) db.close();
    if (previousDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = previousDbPath;
    if (previousQuickCheck === undefined) delete process.env.DB_STARTUP_QUICK_CHECK;
    else process.env.DB_STARTUP_QUICK_CHECK = previousQuickCheck;
  }

  console.log('All event ledger fail-closed tests passed.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runEventLedgerFailClosedTests().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
