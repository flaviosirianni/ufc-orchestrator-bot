import assert from 'node:assert/strict';
import { resolveNextEventFromOddsRows } from '../src/core/oddsEventResolver.js';

function row({ id, fighterA, fighterB, commenceTime, completed = 0 }) {
  return {
    eventId: id,
    homeTeam: fighterA,
    awayTeam: fighterB,
    commenceTime,
    completed,
  };
}

export function runOddsEventResolverTests() {
  {
    const result = resolveNextEventFromOddsRows([]);
    assert.equal(result, null);
  }

  {
    // Real UFC 330 shape: early prelims 23:30Z, main event rolls into the next UTC day (03:30Z).
    // The card's real-world date is the US-evening date (2026-08-15), not the UTC date of the
    // main event (2026-08-16) -- this locks in the anchor-date behavior.
    const rows = [
      row({ id: 'f1', fighterA: 'Louie Sutherland', fighterB: 'Jose Montanha', commenceTime: '2026-08-15T23:30:00Z' }),
      row({ id: 'f2', fighterA: 'Charles Johnson', fighterB: 'Jose Ochoa', commenceTime: '2026-08-16T02:00:00Z' }),
      row({ id: 'f3', fighterA: 'Mackenzie Dern', fighterB: 'Gillian Robertson', commenceTime: '2026-08-16T02:45:00Z' }),
      row({ id: 'f4', fighterA: 'Islam Makhachev', fighterB: 'Ian Garry', commenceTime: '2026-08-16T03:30:00Z' }),
    ];

    const result = resolveNextEventFromOddsRows(rows);

    assert.ok(result);
    assert.equal(result.eventDateUtc, '2026-08-15');
    assert.equal(result.sourcePrimary, 'odds_api');
    assert.equal(result.structuredCardSource, true);
    assert.equal(result.mainCard.length, 4);
    // Headliner = latest commence_time in the cluster.
    assert.equal(result.mainEventFighterA, 'Islam Makhachev');
    assert.equal(result.mainEventFighterB, 'Ian Garry');
    assert.equal(result.eventName, 'UFC: Islam Makhachev vs Ian Garry');
    assert.deepEqual(
      result.mainCard.map((fight) => [fight.fighterA, fight.fighterB]),
      [
        ['Louie Sutherland', 'Jose Montanha'],
        ['Charles Johnson', 'Jose Ochoa'],
        ['Mackenzie Dern', 'Gillian Robertson'],
        ['Islam Makhachev', 'Ian Garry'],
      ]
    );
  }

  {
    // A second, unrelated card 5 days later must not bleed into the next card's cluster.
    const rows = [
      row({ id: 'f1', fighterA: 'Near Fighter A', fighterB: 'Near Fighter B', commenceTime: '2026-08-15T23:30:00Z' }),
      row({ id: 'f2', fighterA: 'Far Fighter A', fighterB: 'Far Fighter B', commenceTime: '2026-08-20T23:30:00Z' }),
    ];

    const result = resolveNextEventFromOddsRows(rows);

    assert.equal(result.mainCard.length, 1);
    assert.equal(result.mainEventFighterA, 'Near Fighter A');
  }

  {
    // Missing fighter names on a row must not produce a candidate fight with blank names.
    const rows = [
      row({ id: 'f1', fighterA: '', fighterB: 'Solo Fighter', commenceTime: '2026-08-15T23:30:00Z' }),
    ];

    const result = resolveNextEventFromOddsRows(rows);
    assert.equal(result, null);
  }

  console.log('All odds event resolver tests passed.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runOddsEventResolverTests();
}
