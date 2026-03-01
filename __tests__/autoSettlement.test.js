import assert from 'node:assert/strict';
import { resolveAutoSettlementCandidate } from '../src/core/autoSettlement.js';

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
