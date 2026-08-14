import assert from 'node:assert/strict';
import {
  resolveAutoSettlementCandidate,
  verifyEventCompletionFromStats,
} from '../src/core/autoSettlement.js';

export async function runAutoSettlementTests() {
  const tests = [];

  tests.push(async () => {
    const bet = {
      id: 1,
      telegramUserId: 'u-1',
      fight: 'Daniel Zellhuber vs King Green',
      pick: 'Daniel Zellhuber ML',
    };
    const rows = [
      ['2026-03-01', 'UFC FN', 'Daniel Zellhuber', 'King Green', '', 'Daniel Zellhuber', 'Decision', '3'],
    ];

    const result = resolveAutoSettlementCandidate(bet, rows);
    assert.equal(result?.result, 'win');
    assert.equal(result?.classification?.type, 'fighter_moneyline');
  });

  tests.push(async () => {
    const bet = {
      id: 2,
      telegramUserId: 'u-2',
      fight: 'Daniel Zellhuber vs King Green',
      pick: 'Under 2.5 rounds',
    };
    const rows = [
      ['2026-03-01', 'UFC FN', 'Daniel Zellhuber', 'King Green', '', 'King Green', 'KO/TKO', '2'],
    ];

    const result = resolveAutoSettlementCandidate(bet, rows);
    assert.equal(result?.result, 'win');
    assert.equal(result?.classification?.type, 'total_under');
  });

  tests.push(async () => {
    const bet = {
      id: 3,
      telegramUserId: 'u-3',
      fight: 'Daniel Zellhuber vs King Green',
      pick: 'Over 2.5 rounds',
    };
    const rows = [
      ['2026-03-01', 'UFC FN', 'Daniel Zellhuber', 'King Green', '', 'King Green', 'KO/TKO', '2'],
    ];

    const result = resolveAutoSettlementCandidate(bet, rows);
    assert.equal(result?.result, 'loss');
    assert.equal(result?.classification?.type, 'total_over');
  });

  tests.push(async () => {
    const bet = {
      id: 4,
      telegramUserId: 'u-4',
      fight: 'Daniel Zellhuber vs King Green',
      pick: 'Zellhuber KO/TKO + Under 2.5',
    };
    const rows = [
      ['2026-03-01', 'UFC FN', 'Daniel Zellhuber', 'King Green', '', 'King Green', 'KO/TKO', '2'],
    ];

    const result = resolveAutoSettlementCandidate(bet, rows);
    assert.equal(result, null);
  });

  tests.push(async () => {
    // Evento con fecha pasada y mayoria de la cartelera con resultado real
    // en ufc_stats.db -> se considera genuinamente terminado.
    const eventState = {
      eventDateUtc: '2026-08-10',
      mainCard: [
        { fighterA: 'Daniel Zellhuber', fighterB: 'King Green' },
        { fighterA: 'Mario Bautista', fighterB: 'Vinicius Oliveira' },
      ],
    };
    const rows = [
      ['2026-08-10', 'UFC FN', 'Daniel Zellhuber', 'King Green', '', 'Daniel Zellhuber', 'Decision', '3'],
      ['2026-08-10', 'UFC FN', 'Mario Bautista', 'Vinicius Oliveira', '', 'Mario Bautista', 'Submission', '2'],
    ];

    const result = verifyEventCompletionFromStats({
      eventState,
      historyRows: rows,
      now: new Date('2026-08-12T00:00:00.000Z'),
    });

    assert.equal(result.isComplete, true);
    assert.equal(result.matchedCount, 2);
    assert.equal(result.totalCount, 2);
  });

  tests.push(async () => {
    // Fecha del evento todavia no paso -> nunca se marca completo, aunque
    // por casualidad haya filas viejas que matcheen los mismos nombres.
    const eventState = {
      eventDateUtc: '2026-08-15',
      mainCard: [{ fighterA: 'Sidney Outlaw', fighterB: 'Rasul Magomedov' }],
    };
    const rows = [
      ['2026-08-15', 'UFC FN', 'Sidney Outlaw', 'Rasul Magomedov', '', 'Sidney Outlaw', 'Decision', '3'],
    ];

    const result = verifyEventCompletionFromStats({
      eventState,
      historyRows: rows,
      now: new Date('2026-08-14T12:00:00.000Z'),
    });

    assert.equal(result.isComplete, false);
    assert.equal(result.reason, 'event_not_past');
  });

  tests.push(async () => {
    // Fecha pasada pero ufc_stats.db todavia no tiene resultados reales
    // (columnas winner/method vacias, o directamente sin filas) -> no
    // completo, para no marcar el evento antes de tiempo.
    const eventState = {
      eventDateUtc: '2026-08-10',
      mainCard: [{ fighterA: 'Daniel Zellhuber', fighterB: 'King Green' }],
    };
    const rows = [
      ['2026-08-10', 'UFC FN', 'Daniel Zellhuber', 'King Green', '', '', '', ''],
    ];

    const result = verifyEventCompletionFromStats({
      eventState,
      historyRows: rows,
      now: new Date('2026-08-12T00:00:00.000Z'),
    });

    assert.equal(result.isComplete, false);
    assert.equal(result.matchedCount, 0);
  });

  tests.push(async () => {
    // Sin cartelera guardada -> fail closed, nunca completo.
    const result = verifyEventCompletionFromStats({
      eventState: { eventDateUtc: '2026-08-10', mainCard: [] },
      historyRows: [],
      now: new Date('2026-08-12T00:00:00.000Z'),
    });

    assert.equal(result.isComplete, false);
    assert.equal(result.reason, 'main_card_missing');
  });

  for (const test of tests) {
    await test();
  }

  console.log('All autoSettlement tests passed.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runAutoSettlementTests().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
