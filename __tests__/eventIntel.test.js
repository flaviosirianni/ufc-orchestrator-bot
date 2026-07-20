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

  console.log('All event intel tests passed.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runEventIntelTests().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
