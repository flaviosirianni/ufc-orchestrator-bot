import assert from 'node:assert/strict';
import { buildFightBetScoringPack } from '../src/core/betScoringEngine.js';

export async function runBetScoringEngineTests() {
  const tests = [];

  tests.push(async () => {
    const pack = buildFightBetScoringPack({
      eventId: 'ufc_326_2026-03-08',
      fight: {
        fightId: 'fight_1',
        fighterA: 'Max Holloway',
        fighterB: 'Charles Oliveira',
      },
      projection: {
        predictedWinner: 'Max Holloway',
        predictedMethod: 'inside_distance_or_clear_decision',
        confidencePct: 68,
        fighterAWinPct: 62,
        fighterBWinPct: 38,
      },
      oddsRows: [
        {
          marketKey: 'h2h',
          bookmakerKey: 'draftkings',
          fetchedAt: '2026-03-08T00:01:00Z',
          outcomeAName: 'Max Holloway',
          outcomeAPrice: 1.8,
          outcomeBName: 'Charles Oliveira',
          outcomeBPrice: 2.05,
        },
        {
          marketKey: 'h2h',
          bookmakerKey: 'fanduel',
          fetchedAt: '2026-03-08T00:02:00Z',
          outcomeAName: 'Max Holloway',
          outcomeAPrice: 1.85,
          outcomeBName: 'Charles Oliveira',
          outcomeBPrice: 2.0,
        },
        {
          marketKey: 'method_of_victory',
          bookmakerKey: 'draftkings',
          fetchedAt: '2026-03-08T00:01:00Z',
          payload: {
            market: {
              outcomes: [
                { name: 'Max Holloway by KO/TKO', price: 3.2 },
                { name: 'Max Holloway by Decision', price: 4.2 },
                { name: 'Charles Oliveira by KO/TKO', price: 3.8 },
              ],
            },
          },
        },
        {
          marketKey: 'totals',
          bookmakerKey: 'draftkings',
          fetchedAt: '2026-03-08T00:01:00Z',
          outcomeAName: 'Over 2.5 Rounds',
          outcomeAPrice: 1.87,
          outcomeBName: 'Under 2.5 Rounds',
          outcomeBPrice: 1.98,
        },
      ],
    });

    assert.equal(pack.length, 3);
    const moneyline = pack.find((row) => row.marketKey === 'moneyline');
    const method = pack.find((row) => row.marketKey === 'method');
    const totalRounds = pack.find((row) => row.marketKey === 'total_rounds');

    assert.ok(moneyline);
    assert.ok(method);
    assert.ok(totalRounds);

    assert.equal(moneyline.selection, 'Max Holloway');
    assert.ok(['bet', 'lean'].includes(moneyline.recommendation));
    assert.ok(Number.isFinite(Number(moneyline.edgePct)));
    assert.ok(Number.isFinite(Number(moneyline.confidencePct)));
    assert.ok(Number.isFinite(Number(moneyline.suggestedStakeUnits)));

    assert.ok(method.selection);
    assert.ok(['bet', 'lean', 'no_bet'].includes(method.recommendation));
    assert.ok(Number.isFinite(Number(method.edgePct)));

    assert.ok(/Over|Under/i.test(totalRounds.selection || ''));
    assert.ok(['bet', 'lean', 'no_bet'].includes(totalRounds.recommendation));
    assert.ok(Number.isFinite(Number(totalRounds.confidencePct)));
  });

  tests.push(async () => {
    const pack = buildFightBetScoringPack({
      eventId: 'ufc_fn_2026-03-14',
      fight: {
        fightId: 'fight_2',
        fighterA: 'Fighter A',
        fighterB: 'Fighter B',
      },
      projection: {
        predictedWinner: 'Fighter A',
        predictedMethod: 'decision_lean',
        confidencePct: 57,
        fighterAWinPct: 55,
        fighterBWinPct: 45,
      },
      oddsRows: [],
    });

    assert.equal(pack.length, 3);
    for (const row of pack) {
      assert.equal(row.recommendation, 'no_bet');
      assert.ok(row.noBetReason);
      assert.equal(row.booksCount, 0);
    }
  });

  for (const test of tests) {
    await test();
  }
  console.log('All betScoringEngine tests passed.');
}

