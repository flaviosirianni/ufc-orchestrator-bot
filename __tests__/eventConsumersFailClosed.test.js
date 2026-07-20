import assert from 'node:assert/strict';
import { scanFighterNews } from '../src/core/eventIntel.js';
import { runPreFightAnalysisCycle } from '../src/core/preFightAnalysis.js';
import { buildMirrorForWatchKey } from '../src/core/eventMirrorService.js';
import { runAutoSettlementCycle } from '../src/core/autoSettlement.js';
import { createVerifiedEventStoreView } from '../src/bots/ufc/index.js';

const NOW = '2026-07-18T12:00:00.000Z';

function eventState(overrides = {}) {
  return {
    watchKey: 'next_event',
    eventId: 'event_fixture',
    eventName: 'UFC Fixture',
    eventDateUtc: '2026-07-25',
    eventStatus: 'scheduled',
    sourcePrimary: 'ufc.example',
    sourceSecondary: 'odds.example',
    mainCard: [
      {
        fightId: 'fight_fixture',
        fighterA: 'Fixture Alpha',
        fighterB: 'Fixture Beta',
      },
    ],
    monitoredFighters: ['Fixture Alpha', 'Fixture Beta'],
    confidence: 'verified',
    consumerAllowed: true,
    ledgerMutationAllowed: false,
    verificationReasons: [],
    lastVerifiedAt: '2026-07-18T11:55:00.000Z',
    verificationExpiresAt: '2026-07-18T13:00:00.000Z',
    ...overrides,
  };
}

function freshStats() {
  return {
    isAvailable: true,
    generatedAt: '2026-07-18T10:00:00.000Z',
  };
}

function staleStats() {
  return {
    isAvailable: true,
    generatedAt: '2026-04-01T18:58:10.834Z',
  };
}

export async function runEventConsumersFailClosedTests() {
  {
    const rawInvalidState = eventState({
      confidence: 'invalid',
      consumerAllowed: false,
      verificationReasons: ['verification_missing'],
    });
    const safeView = createVerifiedEventStoreView({
      getEventWatchState: () => rawInvalidState,
      getEventFightMirror: () => [{ fightId: 'contaminated' }],
      getEventFighterMirror: () => [{ fighterSlug: 'contaminated' }],
      getStatsFreshness: () => freshStats(),
      nowProvider: () => new Date(NOW),
    });
    assert.equal(safeView.getEventWatchState('next_event'), null);
    assert.deepEqual(safeView.getEventFightMirror('next_event'), []);
    assert.deepEqual(safeView.getEventFighterMirror('next_event'), []);
  }

  {
    let fetchCount = 0;
    let insertCount = 0;
    const result = await scanFighterNews({
      getEventWatchState: () =>
        eventState({
          confidence: 'invalid',
          consumerAllowed: false,
          verificationReasons: ['title_like_fighter_name'],
        }),
      fetchGoogleNewsRss: async () => {
        fetchCount += 1;
        return [];
      },
      insertFighterNewsItems: () => {
        insertCount += 1;
        return { insertedCount: 1 };
      },
      now: NOW,
    });

    assert.equal(result.blocked, true);
    assert.equal(fetchCount, 0);
    assert.equal(insertCount, 0);
    assert.ok(result.reasons.includes('event_confidence_invalid'));
  }

  {
    let projectionWrites = 0;
    let scoringWrites = 0;
    const result = await runPreFightAnalysisCycle({
      getEventWatchState: () => eventState(),
      getStatsFreshness: () => staleStats(),
      listLatestRelevantNews: () => [],
      listLatestOddsMarketsForFight: () => [],
      getLatestProjectionForFight: () => null,
      insertFightProjectionSnapshots: () => {
        projectionWrites += 1;
        return { insertedCount: 1 };
      },
      insertFightBetScoringSnapshots: () => {
        scoringWrites += 1;
        return { insertedCount: 1 };
      },
      now: NOW,
      statsMaxAgeHours: 36,
    });

    assert.equal(result.blocked, true);
    assert.ok(result.reasons.includes('stats_stale'));
    assert.equal(projectionWrites, 0);
    assert.equal(scoringWrites, 0);
  }

  {
    let statsReads = 0;
    let mirrorWrites = 0;
    let mirrorClears = 0;
    const result = await buildMirrorForWatchKey('next_event', {
      now: NOW,
      ufcStats: {
        isAvailable: () => true,
        getFreshnessMeta: () => freshStats(),
        getFighterStats: () => {
          statsReads += 1;
          return { fighter: 'Fixture', fights: [] };
        },
      },
      store: {
        getEventWatchState: () =>
          eventState({
            confidence: 'stale',
            consumerAllowed: false,
            verificationReasons: ['verification_ttl_exceeded'],
          }),
        clearEventMirror: () => {
          mirrorClears += 1;
        },
        upsertEventFightMirror: () => {
          mirrorWrites += 1;
        },
        upsertEventFighterMirror: () => {
          mirrorWrites += 1;
        },
      },
    });

    assert.equal(result.blocked, true);
    assert.equal(statsReads, 0);
    assert.equal(mirrorClears, 0);
    assert.equal(mirrorWrites, 0);
  }

  {
    let historyReads = 0;
    let pendingReads = 0;
    let ledgerWrites = 0;
    const result = await runAutoSettlementCycle({
      getEventWatchState: () =>
        eventState({
          watchKey: 'current_event',
          eventStatus: 'completed',
          ledgerMutationAllowed: true,
        }),
      getStatsFreshness: () => staleStats(),
      getFightHistoryRows: () => {
        historyReads += 1;
        return [['2026-07-18', 'UFC Fixture', 'Fixture Alpha', 'Fixture Beta']];
      },
      listPendingBetsForAutoSettlement: () => {
        pendingReads += 1;
        return [{ id: 1, telegramUserId: 'user-fixture' }];
      },
      applyBetMutation: () => {
        ledgerWrites += 1;
        return { ok: true, affectedCount: 1 };
      },
      now: NOW,
      statsMaxAgeHours: 36,
    });

    assert.equal(result.blocked, true);
    assert.ok(result.reasons.includes('stats_stale'));
    assert.equal(historyReads, 0);
    assert.equal(pendingReads, 0);
    assert.equal(ledgerWrites, 0);
  }

  {
    let fetchCount = 0;
    let insertedItems = 0;
    const result = await scanFighterNews({
      getEventWatchState: () => eventState(),
      fetchGoogleNewsRss: async () => {
        fetchCount += 1;
        return [
          {
            title: 'Fixture Alpha ready for UFC Fixture',
            link: 'https://news.example/fixture-alpha',
            source: 'news.example',
            publishedAt: '2026-07-18T10:00:00.000Z',
          },
        ];
      },
      insertFighterNewsItems: (items) => {
        insertedItems += items.length;
        return { insertedCount: items.length };
      },
      now: NOW,
    });
    assert.equal(result.ok, true);
    assert.equal(fetchCount, 2);
    assert.equal(insertedItems, 2);
  }

  {
    let projectionRows = 0;
    let scoringRows = 0;
    const result = await runPreFightAnalysisCycle({
      getEventWatchState: () => eventState(),
      getStatsFreshness: () => freshStats(),
      listLatestRelevantNews: () => [],
      listLatestOddsMarketsForFight: () => [],
      getLatestProjectionForFight: () => null,
      insertFightProjectionSnapshots: (rows) => {
        projectionRows += rows.length;
        return { insertedCount: rows.length };
      },
      insertFightBetScoringSnapshots: (rows) => {
        scoringRows += rows.length;
        return { insertedCount: rows.length };
      },
      now: NOW,
      statsMaxAgeHours: 36,
    });
    assert.equal(result.ok, true);
    assert.equal(projectionRows, 1);
    assert.ok(scoringRows > 0);
  }

  {
    let statsReads = 0;
    let mirrorWrites = 0;
    let mirrorClears = 0;
    const result = await buildMirrorForWatchKey('next_event', {
      now: NOW,
      ufcStats: {
        isAvailable: () => true,
        getFreshnessMeta: () => freshStats(),
        getFighterStats: ({ fighterName }) => {
          statsReads += 1;
          return { fighter: fighterName, fights: [] };
        },
      },
      store: {
        getEventWatchState: () => eventState(),
        clearEventMirror: () => {
          mirrorClears += 1;
        },
        upsertEventFightMirror: () => {
          mirrorWrites += 1;
        },
        upsertEventFighterMirror: () => {
          mirrorWrites += 1;
        },
      },
    });
    assert.equal(result.blocked, undefined);
    assert.equal(result.fightCount, 1);
    assert.equal(result.fighterCount, 2);
    assert.equal(statsReads, 2);
    assert.equal(mirrorClears, 1);
    assert.equal(mirrorWrites, 2);
  }

  {
    let ledgerWrites = 0;
    const result = await runAutoSettlementCycle({
      getEventWatchState: () =>
        eventState({
          watchKey: 'current_event',
          eventStatus: 'completed',
          ledgerMutationAllowed: true,
        }),
      getStatsFreshness: () => freshStats(),
      getFightHistoryRows: () => [
        [
          '2026-07-18',
          'UFC Fixture',
          'Fixture Alpha',
          'Fixture Beta',
          '',
          'Fixture Alpha',
          'Decision',
          '3',
        ],
      ],
      listPendingBetsForAutoSettlement: () => [
        {
          id: 1,
          telegramUserId: 'user-fixture',
          fight: 'Fixture Alpha vs Fixture Beta',
          pick: 'Fixture Alpha ML',
        },
      ],
      applyBetMutation: () => {
        ledgerWrites += 1;
        return { ok: true, affectedCount: 1 };
      },
      now: NOW,
      statsMaxAgeHours: 36,
    });
    assert.equal(result.ok, true);
    assert.equal(result.settledCount, 1);
    assert.equal(ledgerWrites, 1);
  }

  console.log('All event consumer fail-closed tests passed.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runEventConsumersFailClosedTests().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
