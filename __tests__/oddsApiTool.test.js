import assert from 'node:assert/strict';
import { createOddsApiTool } from '../src/tools/oddsApiTool.js';

function createMockResponse({
  ok = true,
  status = 200,
  body = {},
  headers = {},
} = {}) {
  return {
    ok,
    status,
    headers: {
      get(name) {
        return headers[String(name || '').toLowerCase()] ?? null;
      },
    },
    async text() {
      return JSON.stringify(body);
    },
  };
}

export async function runOddsApiToolTests() {
  const tests = [];

  tests.push(async () => {
    const fetchCalls = [];
    const cache = new Map();
    const usageLog = [];

    const tool = createOddsApiTool({
      apiKey: 'test-api-key',
      fetchImpl: async (url) => {
        fetchCalls.push(url);
        return createMockResponse({
          body: [{ key: 'mma_mixed_martial_arts' }],
          headers: {
            'x-requests-remaining': '499',
            'x-requests-used': '1',
            'x-requests-last': '1',
          },
        });
      },
      store: {
        getOddsApiCacheEntry(cacheKey) {
          return cache.get(cacheKey) || null;
        },
        upsertOddsApiCacheEntry(entry) {
          cache.set(entry.cacheKey, entry);
          return entry;
        },
        logOddsApiUsage(entry) {
          usageLog.push(entry);
        },
      },
    });

    const first = await tool.getSports({ ttlMs: 3600000 });
    const second = await tool.getSports({ ttlMs: 3600000 });

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(fetchCalls.length, 1);
    assert.equal(second.meta.cached, true);
    assert.equal(usageLog.length, 1);
    assert.equal(first.meta.requestsRemaining, 499);
  });

  tests.push(async () => {
    const tool = createOddsApiTool({
      apiKey: 'test-api-key',
      fetchImpl: async () => createMockResponse({ body: [] }),
    });

    const payload = [
      {
        id: 'event_1',
        sport_key: 'mma_mixed_martial_arts',
        commence_time: '2026-03-21T23:00:00Z',
        home_team: 'Alpha One',
        away_team: 'Bravo Two',
        bookmakers: [
          {
            key: 'draftkings',
            title: 'DraftKings',
            last_update: '2026-03-20T10:00:00Z',
            markets: [
              {
                key: 'h2h',
                last_update: '2026-03-20T10:05:00Z',
                outcomes: [
                  { name: 'Alpha One', price: 1.8 },
                  { name: 'Bravo Two', price: 2.05 },
                ],
              },
            ],
          },
        ],
      },
    ];

    const snapshots = tool.normalizeSnapshotsFromOddsPayload({
      sportKey: 'mma_mixed_martial_arts',
      payload,
      fetchedAt: '2026-03-20T10:06:00Z',
    });

    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0].eventId, 'event_1');
    assert.equal(snapshots[0].bookmakerKey, 'draftkings');
    assert.equal(snapshots[0].marketKey, 'h2h');
    assert.equal(snapshots[0].outcomeAPrice, 1.8);
    assert.equal(snapshots[0].outcomeBPrice, 2.05);
    assert.ok(snapshots[0].dedupeKey);
  });

  tests.push(async () => {
    const tool = createOddsApiTool({
      apiKey: 'test-api-key',
      fetchImpl: async () => createMockResponse({ body: [] }),
    });

    const eventOdds = await tool.getEventOdds({});
    const eventMarkets = await tool.getEventMarkets({});
    const historicalEventOdds = await tool.getHistoricalEventOdds({});

    assert.equal(eventOdds.ok, false);
    assert.equal(eventOdds.error, 'event_id_required');
    assert.equal(eventMarkets.ok, false);
    assert.equal(historicalEventOdds.ok, false);
  });

  tests.push(async () => {
    const fetchCalls = [];
    const tool = createOddsApiTool({
      apiKey: 'test-api-key',
      fetchImpl: async (url) => {
        fetchCalls.push(String(url));
        return createMockResponse({ body: [] });
      },
    });

    await tool.getEvents({
      commenceTimeFrom: '2026-03-08T02:37:52.860Z',
      commenceTimeTo: '2026-03-09T02:37:52.120Z',
      force: true,
    });

    await tool.getHistoricalEvents({
      date: '2026-03-08T02:37:52.999Z',
      force: true,
    });

    const eventsUrl = new URL(fetchCalls[0]);
    assert.equal(
      eventsUrl.searchParams.get('commenceTimeFrom'),
      '2026-03-08T02:37:52Z'
    );
    assert.equal(
      eventsUrl.searchParams.get('commenceTimeTo'),
      '2026-03-09T02:37:52Z'
    );

    const historicalEventsUrl = new URL(fetchCalls[1]);
    assert.equal(
      historicalEventsUrl.searchParams.get('date'),
      '2026-03-08T02:37:52Z'
    );
  });

  for (const test of tests) {
    await test();
  }

  console.log('All oddsApiTool tests passed.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runOddsApiToolTests().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
