import assert from 'node:assert/strict';
import { buildHealthPayload } from '../src/platform/runtime/healthServer.js';
import { createUfcHealthStatusProvider } from '../src/bots/ufc/ufcHealthStatus.js';
import { createBillingApiClient } from '../src/platform/billing/billingApiClient.js';
import { startUfcDbReliabilityLoop } from '../src/bots/ufc/ufcReliability.js';

/**
 * @returns {object} Estado deportivo sintético verificado.
 * @sideEffects Ninguno.
 */
function verifiedEvent(overrides = {}) {
  return {
    watchKey: 'next_event',
    eventId: 'event_verified',
    eventName: 'Verified UFC Event',
    eventDateUtc: '2026-07-25T22:00:00.000Z',
    eventStatus: 'scheduled',
    confidence: 'verified',
    consumerAllowed: true,
    ledgerMutationAllowed: false,
    verificationReasons: [],
    lastVerifiedAt: '2026-07-20T11:55:00.000Z',
    verificationExpiresAt: '2026-07-20T20:00:00.000Z',
    compatibleSourceCount: 2,
    verificationEvidence: { apiToken: 'must-not-leak' },
    mainCard: [{ fighterA: 'Private A', fighterB: 'Private B' }],
    ...overrides,
  };
}

/**
 * @returns {Promise<void>} Finaliza o lanza ante contrato inseguro.
 * @sideEffects Ejecuta sólo proveedores sintéticos y requests de billing simulados.
 */
export async function runUfcHealthStatusTests() {
  const calls = {
    events: 0,
    stats: 0,
    odds: 0,
    billing: 0,
    maintenance: 0,
  };
  const provider = createUfcHealthStatusProvider({
    nowProvider: () => new Date('2026-07-20T12:00:00.000Z'),
    processInfo: {
      pid: 4242,
      startedAt: '2026-07-20T10:00:00.000Z',
    },
    getEventWatchState(watchKey) {
      calls.events += 1;
      if (watchKey === 'current_event') {
        return verifiedEvent({
          watchKey,
          eventId: 'event_stale',
          eventName: 'Stale UFC Event',
          eventStatus: 'live',
          confidence: 'stale',
          consumerAllowed: false,
          verificationReasons: ['live_signal_stale'],
          verificationExpiresAt: '2026-07-20T11:00:00.000Z',
        });
      }
      return verifiedEvent();
    },
    getStatsFreshness() {
      calls.stats += 1;
      return {
        isAvailable: true,
        isFresh: false,
        generatedAt: '2026-04-01T18:58:10.834Z',
        ageHours: 2633.03,
        maxAgeHours: 36,
        fightCount: 5103,
        upcomingCount: 78,
        dbPath: '/home/ubuntu/private/ufc_stats.db',
      };
    },
    getOddsApiStatus() {
      calls.odds += 1;
      return {
        enabled: true,
        statusCode: 200,
        requestsRemaining: 147,
        requestsUsed: 353,
        requestsLast: 1,
        endpoint: 'sports/mma/odds',
        createdAt: '2026-07-20T11:58:00.000Z',
        apiKey: 'must-not-leak',
      };
    },
    getBillingStatus() {
      calls.billing += 1;
      return {
        enabled: true,
        lastRequestOk: true,
        lastSuccessAt: '2026-07-20T11:59:00.000Z',
        lastRequestAt: '2026-07-20T11:59:00.000Z',
        lastStatusCode: 200,
        lastLatencyMs: 14,
        lastTraceId: 'safe-trace-id',
        apiToken: 'must-not-leak',
      };
    },
    getMaintenanceStatus() {
      calls.maintenance += 1;
      return {
        enabled: true,
        inFlight: false,
        lastSuccessAt: '2026-07-20T06:00:00.000Z',
        lastAttemptAt: '2026-07-20T06:00:00.000Z',
        lastError: null,
        backupFile: '/home/ubuntu/private/backup.sqlite',
      };
    },
  });

  const blocks = provider();
  assert.deepEqual(Object.keys(blocks), [
    'process',
    'event_intel',
    'ufc_stats',
    'odds_api',
    'billing',
    'maintenance',
  ]);
  assert.equal(blocks.process.status, 'running');
  assert.equal(blocks.process.pid, 4242);
  assert.equal(blocks.process.uptime_seconds, 7200);
  assert.equal(blocks.event_intel.status, 'degraded');
  assert.equal(blocks.event_intel.current_event.confidence, 'stale');
  assert.equal(blocks.event_intel.next_event.status, 'scheduled');
  assert.equal(blocks.event_intel.last_success_at, '2026-07-20T11:55:00.000Z');
  assert.equal(blocks.ufc_stats.status, 'degraded');
  assert.equal(blocks.ufc_stats.reason, 'stats_stale');
  assert.equal(blocks.odds_api.status, 'healthy');
  assert.equal(blocks.odds_api.last_success_at, '2026-07-20T11:58:00.000Z');
  assert.equal(blocks.billing.status, 'healthy');
  assert.equal(blocks.billing.last_success_at, '2026-07-20T11:59:00.000Z');
  assert.equal(blocks.maintenance.status, 'healthy');
  assert.equal(blocks.maintenance.last_success_at, '2026-07-20T06:00:00.000Z');
  assert.deepEqual(calls, { events: 2, stats: 1, odds: 1, billing: 1, maintenance: 1 });
  assert.doesNotMatch(
    JSON.stringify(blocks),
    /must-not-leak|\/home\/ubuntu\/private|Private A|Private B/
  );

  let runtimeCalls = 0;
  let healthCalls = 0;
  const payload = await buildHealthPayload({
    appName: 'UFC Test',
    botId: 'ufc',
    statusProvider: () => {
      runtimeCalls += 1;
      return { telegram: { degraded: false } };
    },
    healthProvider: () => {
      healthCalls += 1;
      return blocks;
    },
    nowProvider: () => new Date('2026-07-20T12:00:00.000Z'),
  });
  assert.equal(payload.ok, true);
  assert.equal(payload.now, '2026-07-20T12:00:00.000Z');
  assert.deepEqual(payload.runtime, { telegram: { degraded: false } });
  assert.equal(payload.event_intel.status, 'degraded');
  assert.equal(payload.ufc_stats.reason, 'stats_stale');
  assert.equal(payload.billing.last_trace_id, 'safe-trace-id');
  assert.equal(runtimeCalls, 1);
  assert.equal(healthCalls, 1);

  const billingClient = createBillingApiClient({
    baseUrl: 'http://billing.invalid',
    apiToken: 'private-billing-token',
    nowProvider: () => new Date('2026-07-20T12:01:00.000Z'),
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ ok: true, packs: [] });
      },
    }),
  });
  assert.equal(billingClient.getHealthStatus().lastRequestAt, null);
  await billingClient.getTopupConfig();
  const billingHealth = billingClient.getHealthStatus();
  assert.equal(billingHealth.enabled, true);
  assert.equal(billingHealth.lastRequestOk, true);
  assert.equal(billingHealth.lastStatusCode, 200);
  assert.equal(billingHealth.lastSuccessAt, '2026-07-20T12:01:00.000Z');
  assert.doesNotMatch(JSON.stringify(billingHealth), /private-billing-token|billing\.invalid/);

  const disabledMaintenance = startUfcDbReliabilityLoop({ enabled: false });
  assert.deepEqual(disabledMaintenance.getStatus(), {
    enabled: false,
    inFlight: false,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastError: null,
  });

  console.log('All UFC health status tests passed.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runUfcHealthStatusTests().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
