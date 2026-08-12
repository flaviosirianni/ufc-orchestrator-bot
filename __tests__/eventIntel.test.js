import assert from 'node:assert/strict';
import { discoverNextEvent } from '../src/core/eventIntel.js';

export async function runEventIntelTests() {
  {
    const writes = [];
    const result = await discoverNextEvent({
      buildWebContextForMessage: async () => ({
        eventName: 'UFC Single Source Fixture',
        date: '2026-07-25',
        source: 'ufc.com',
        fights: [
          {
            fighterA: 'Fixture Alpha',
            fighterB: 'Fixture Beta',
          },
        ],
      }),
      upsertEventWatchState(snapshot) {
        writes.push(snapshot);
        return snapshot;
      },
      now: new Date('2026-07-18T12:00:00.000Z'),
    });

    assert.equal(result.ok, true);
    assert.equal(writes.length, 1);
    assert.equal(writes[0]?.verification?.confidence, 'invalid');
    assert.equal(writes[0]?.verification?.consumerAllowed, false);
    assert.ok(writes[0]?.verification?.reasons?.includes('source_quorum_failed'));
    assert.ok(writes[0]?.verification?.reasons?.includes('structured_card_source_missing'));
  }

  {
    const writes = [];
    const result = await discoverNextEvent({
      buildWebContextForMessage: async () => ({
        eventName: 'UFC Editorial Fixture',
        date: '2026-07-25',
        source: 'editorial_page',
        fights: [
          {
            fighterA: 'Event Preview',
            fighterB: 'Fixture Fighter',
          },
        ],
      }),
      upsertEventWatchState(snapshot) {
        writes.push(snapshot);
        return snapshot;
      },
      now: new Date('2026-07-18T12:00:00.000Z'),
    });

    assert.equal(result.ok, true);
    assert.equal(result.verification?.confidence, 'invalid');
    assert.ok(result.verification?.reasons?.includes('title_like_fighter_name'));
    assert.equal(writes.length, 1);
  }

  {
    // Odds API gives a structured card, and web news corroborates the same main event ->
    // quorum of 2 structured/corroborated sources should be enough to reach `verified`.
    const writes = [];
    const result = await discoverNextEvent({
      listUpcomingOddsEvents: () => [
        { homeTeam: 'Louie Sutherland', awayTeam: 'Jose Montanha', commenceTime: '2026-08-15T23:30:00Z' },
        { homeTeam: 'Islam Makhachev', awayTeam: 'Ian Garry', commenceTime: '2026-08-16T03:30:00Z' },
      ],
      buildWebContextForMessage: async () => ({
        eventName: 'UFC 330: Makhachev vs. Machado Garry',
        date: '2026-08-15',
        source: 'ufc.com',
        fights: [{ fighterA: 'Islam Makhachev', fighterB: 'Ian Machado Garry' }],
      }),
      upsertEventWatchState(snapshot) {
        writes.push(snapshot);
        return snapshot;
      },
      now: new Date('2026-08-12T02:00:00.000Z'),
    });

    assert.equal(result.ok, true);
    assert.equal(writes[0]?.eventDateUtc, '2026-08-15');
    assert.equal(writes[0]?.eventName, 'UFC: Islam Makhachev vs Ian Garry');
    assert.equal(writes[0]?.verification?.confidence, 'verified');
    assert.equal(writes[0]?.verification?.consumerAllowed, true);
  }

  {
    // Odds API gives a structured card but web news has nothing matching it (no corroboration) ->
    // single-source structured data stays `degraded`, not `verified`, not consumable.
    const writes = [];
    const result = await discoverNextEvent({
      listUpcomingOddsEvents: () => [
        { homeTeam: 'Islam Makhachev', awayTeam: 'Ian Garry', commenceTime: '2026-08-16T03:30:00Z' },
      ],
      buildWebContextForMessage: async () => ({ eventName: null, date: null, source: null, fights: [] }),
      upsertEventWatchState(snapshot) {
        writes.push(snapshot);
        return snapshot;
      },
      now: new Date('2026-08-12T02:00:00.000Z'),
    });

    assert.equal(result.ok, true);
    assert.equal(writes[0]?.verification?.confidence, 'degraded');
    assert.equal(writes[0]?.verification?.consumerAllowed, false);
    assert.deepEqual(writes[0]?.verification?.reasons, ['source_quorum_failed']);
  }

  {
    // listUpcomingOddsEvents is wired but returns nothing usable -> falls back to the
    // pre-existing pure web-based path unchanged (same fixture as the first test above).
    const writes = [];
    const result = await discoverNextEvent({
      listUpcomingOddsEvents: () => [],
      buildWebContextForMessage: async () => ({
        eventName: 'UFC Single Source Fixture',
        date: '2026-07-25',
        source: 'ufc.com',
        fights: [{ fighterA: 'Fixture Alpha', fighterB: 'Fixture Beta' }],
      }),
      upsertEventWatchState(snapshot) {
        writes.push(snapshot);
        return snapshot;
      },
      now: new Date('2026-07-18T12:00:00.000Z'),
    });

    assert.equal(result.ok, true);
    assert.equal(writes[0]?.eventName, 'UFC Single Source Fixture');
    assert.equal(writes[0]?.verification?.confidence, 'invalid');
    assert.ok(writes[0]?.verification?.reasons?.includes('structured_card_source_missing'));
  }

  console.log('All event intel tests passed.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runEventIntelTests().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
