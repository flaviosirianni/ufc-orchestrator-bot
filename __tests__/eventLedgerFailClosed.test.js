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

  // 2026-08-14: destrabar auto-settlement. El evento arranca "live" (como
  // esta hoy en produccion, escrito por el path de deteccion en vivo) y sin
  // completionVerified/statsVerified — exactamente el estado que dejaba todo
  // bloqueado para siempre. Con upsertEventWatchState wireado,
  // runAutoSettlementCycle debe detectar por si mismo que ufc_stats.db ya
  // tiene resultado real para la fecha pasada, marcar el evento completo, y
  // asentar la apuesta pendiente en el mismo ciclo.
  {
    const tempDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ufc-event-ledger-guard-'));
    const dbPath2 = path.join(tempDir2, 'bot.db');
    let db2 = null;
    try {
      process.env.DB_PATH = dbPath2;
      process.env.DB_STARTUP_QUICK_CHECK = 'false';
      const moduleUrl2 = new URL(`../src/core/sqliteStore.js?ledgerGuard=${Date.now()}-settle`, import.meta.url);
      const store = await import(moduleUrl2.href);
      db2 = store.getDb();

      const bet = store.addBetRecord('settle-user', {
        eventName: 'UFC Settle Fixture',
        fight: 'Test Winner vs Test Loser',
        pick: 'Test Winner ML',
        odds: 1.9,
        stake: 1000,
        units: 1,
        result: 'pending',
      });
      store.upsertEventWatchState(
        {
          eventId: 'ufc_settle_fixture_2026_08_01',
          eventName: 'UFC Settle Fixture',
          eventDateUtc: '2026-08-01',
          eventStatus: 'live',
          sourcePrimary: 'odds_scores_live',
          mainCard: [{ fightId: 'settle_fight', fighterA: 'Test Winner', fighterB: 'Test Loser' }],
          monitoredFighters: ['Test Winner', 'Test Loser'],
        },
        'current_event'
      );

      const notifyCalls = [];
      const result = await runAutoSettlementCycle({
        getEventWatchState: store.getEventWatchState,
        upsertEventWatchState: store.upsertEventWatchState,
        getStatsFreshness: () => ({
          isAvailable: true,
          generatedAt: '2026-08-03T00:00:00.000Z',
        }),
        getFightHistoryRows: () => [
          ['2026-08-01', 'UFC Settle Fixture', 'Test Winner', 'Test Loser', '', 'Test Winner', 'Decision', '3'],
        ],
        listPendingBetsForAutoSettlement: store.listPendingBetsForAutoSettlement,
        applyBetMutation: store.applyBetMutation,
        getLatestChatIdForUser: () => 'chat-settle-user',
        notify: async (payload) => {
          notifyCalls.push(payload);
        },
        now: '2026-08-03T12:00:00.000Z',
        statsMaxAgeHours: 36,
      });

      const afterBet = store.listUserBets('settle-user', { limit: 10 })[0];
      const afterEventState = store.getEventWatchState('current_event');

      assert.equal(result.ok, true);
      assert.equal(result.blocked, undefined);
      assert.equal(result.settledCount, 1);
      assert.equal(afterBet?.id, bet.id);
      assert.equal(afterBet?.result, 'win');
      assert.equal(notifyCalls.length, 1);
      assert.equal(notifyCalls[0].chatId, 'chat-settle-user');
      assert.match(notifyCalls[0].text, /GANADA/);
      assert.equal(afterEventState?.eventStatus, 'completed');
      assert.equal(afterEventState?.ledgerMutationAllowed, true);
      assert.equal(afterEventState?.sourcePrimary, 'ufc_stats_db');
    } finally {
      if (db2?.open) db2.close();
      delete process.env.DB_PATH;
      delete process.env.DB_STARTUP_QUICK_CHECK;
    }
  }

  // Misma apertura de evento, pero una apuesta que el matcher no puede
  // clasificar solo (pick con formato no soportado) -> no debe quedar
  // pending en silencio para siempre: se notifica aparte pidiendo revision
  // manual, sin tocar su resultado.
  {
    const tempDir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'ufc-event-ledger-guard-'));
    const dbPath3 = path.join(tempDir3, 'bot.db');
    let db3 = null;
    try {
      process.env.DB_PATH = dbPath3;
      process.env.DB_STARTUP_QUICK_CHECK = 'false';
      const moduleUrl3 = new URL(`../src/core/sqliteStore.js?ledgerGuard=${Date.now()}-unresolved`, import.meta.url);
      const store = await import(moduleUrl3.href);
      db3 = store.getDb();

      const bet = store.addBetRecord('unresolved-user', {
        eventName: 'UFC Settle Fixture',
        fight: 'Test Winner vs Test Loser',
        pick: 'Test Winner KO/TKO + Under 2.5',
        odds: 2.5,
        stake: 500,
        units: 1,
        result: 'pending',
      });
      store.upsertEventWatchState(
        {
          eventId: 'ufc_settle_fixture_2026_08_01',
          eventName: 'UFC Settle Fixture',
          eventDateUtc: '2026-08-01',
          eventStatus: 'live',
          sourcePrimary: 'odds_scores_live',
          mainCard: [{ fightId: 'settle_fight', fighterA: 'Test Winner', fighterB: 'Test Loser' }],
          monitoredFighters: ['Test Winner', 'Test Loser'],
        },
        'current_event'
      );

      const notifyCalls = [];
      const result = await runAutoSettlementCycle({
        getEventWatchState: store.getEventWatchState,
        upsertEventWatchState: store.upsertEventWatchState,
        getStatsFreshness: () => ({
          isAvailable: true,
          generatedAt: '2026-08-03T00:00:00.000Z',
        }),
        getFightHistoryRows: () => [
          ['2026-08-01', 'UFC Settle Fixture', 'Test Winner', 'Test Loser', '', 'Test Winner', 'KO/TKO', '2'],
        ],
        listPendingBetsForAutoSettlement: store.listPendingBetsForAutoSettlement,
        applyBetMutation: store.applyBetMutation,
        getLatestChatIdForUser: () => 'chat-unresolved-user',
        notify: async (payload) => {
          notifyCalls.push(payload);
        },
        now: '2026-08-03T12:00:00.000Z',
        statsMaxAgeHours: 36,
      });

      const afterBet = store.listUserBets('unresolved-user', { limit: 10 })[0];

      assert.equal(result.ok, true);
      assert.equal(result.settledCount, 0);
      assert.equal(afterBet?.id, bet.id);
      assert.equal(afterBet?.result, 'pending');
      assert.equal(notifyCalls.length, 1);
      assert.equal(notifyCalls[0].chatId, 'chat-unresolved-user');
      assert.match(notifyCalls[0].text, new RegExp(`bet_id ${bet.id}`));
      assert.match(notifyCalls[0].text, /no pude verificar/i);
    } finally {
      if (db3?.open) db3.close();
      delete process.env.DB_PATH;
      delete process.env.DB_STARTUP_QUICK_CHECK;
    }
  }

  console.log('All event ledger fail-closed tests passed.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runEventLedgerFailClosedTests().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
