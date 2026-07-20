import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EVENT_CONFIDENCE,
  EVENT_STATUS,
  evaluateEventTruth,
} from '../src/core/eventTruthGate.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(HERE, 'fixtures', 'ufc-stabilization');

function readFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8'));
}

function validFight(overrides = {}) {
  return {
    fightId: 'fixture_fight_1',
    fighterA: 'Fixture Alpha',
    fighterB: 'Fixture Beta',
    ...overrides,
  };
}

export async function runEventTruthGateTests() {
  {
    const fixture = readFixture('invalid-ufc-329-candidate.json');
    const result = evaluateEventTruth({
      watchKey: 'next_event',
      candidate: {
        eventId: 'ufc_329_2035_07_18',
        eventName: fixture.observed.event_label,
        eventDateUtc: fixture.observed.candidate_date_iso,
        eventStatus: fixture.observed.candidate_status,
        mainCard: [validFight()],
        sourcePrimary: 'editorial.example',
      },
      verification: {
        compatibleSourceCount: fixture.observed.compatible_source_count,
        structuredCardSource: true,
        verifiedAt: `${fixture.observed.observation_date_iso}T12:00:00.000Z`,
      },
      now: `${fixture.observed.observation_date_iso}T12:00:00.000Z`,
    });

    assert.equal(result.confidence, fixture.expected.confidence);
    assert.equal(result.consumerAllowed, fixture.expected.consumer_allowed);
    for (const reason of fixture.expected.reasons) {
      assert.ok(result.reasons.includes(reason), `missing reason ${reason}`);
    }
  }

  {
    const fixture = readFixture('preview-title-as-fighter.json');
    const result = evaluateEventTruth({
      watchKey: 'next_event',
      candidate: {
        eventId: 'editorial_preview_2026_07_19',
        eventName: 'UFC Fixture',
        eventDateUtc: '2026-07-19',
        eventStatus: EVENT_STATUS.SCHEDULED,
        mainCard: [
          validFight({
            fighterA: fixture.observed.fighter_a,
            fighterB: fixture.observed.fighter_b,
          }),
        ],
        sourcePrimary: fixture.observed.source_kind,
      },
      verification: {
        compatibleSourceCount: 1,
        structuredCardSource: false,
        verifiedAt: '2026-07-18T12:00:00.000Z',
      },
      now: '2026-07-18T12:00:00.000Z',
    });

    assert.equal(result.confidence, fixture.expected.confidence);
    assert.equal(result.consumerAllowed, fixture.expected.consumer_allowed);
    for (const reason of fixture.expected.reasons) {
      assert.ok(result.reasons.includes(reason), `missing reason ${reason}`);
    }
  }

  {
    const fixture = readFixture('stale-live-state.json');
    const result = evaluateEventTruth({
      watchKey: 'current_event',
      candidate: {
        eventId: 'stale_live_fixture',
        eventName: 'UFC Live Fixture',
        eventDateUtc: '2026-07-18',
        eventStatus: fixture.observed.event_status,
        mainCard: [validFight()],
        sourcePrimary: 'ufc.example',
        sourceSecondary: 'odds.example',
      },
      verification: {
        compatibleSourceCount: 2,
        structuredCardSource: true,
        liveSignalCount: fixture.observed.live_signal_count,
        verifiedAt: fixture.observed.last_verified_at,
      },
      now: fixture.observed.evaluated_at,
      ttlMs: 15 * 60 * 1000,
    });

    assert.equal(result.confidence, fixture.expected.confidence);
    assert.equal(result.consumerAllowed, fixture.expected.consumer_allowed);
    assert.equal(result.ledgerMutationAllowed, fixture.expected.ledger_mutation_allowed);
    for (const reason of fixture.expected.reasons) {
      assert.ok(result.reasons.includes(reason), `missing reason ${reason}`);
    }
  }

  {
    const result = evaluateEventTruth({
      watchKey: 'next_event',
      candidate: {
        eventId: 'verified_fixture_2026_07_25',
        eventName: 'UFC Verified Fixture',
        eventDateUtc: '2026-07-25',
        eventStatus: EVENT_STATUS.SCHEDULED,
        mainCard: [validFight()],
        sourcePrimary: 'ufc.example',
        sourceSecondary: 'odds.example',
      },
      verification: {
        compatibleSourceCount: 2,
        structuredCardSource: true,
        verifiedAt: '2026-07-18T11:55:00.000Z',
      },
      now: '2026-07-18T12:00:00.000Z',
      ttlMs: 60 * 60 * 1000,
    });

    assert.equal(result.confidence, EVENT_CONFIDENCE.VERIFIED);
    assert.equal(result.consumerAllowed, true);
    assert.equal(result.ledgerMutationAllowed, false);
    assert.equal(result.reasons.length, 0);
    assert.match(result.candidateHash, /^[a-f0-9]{64}$/);
  }

  {
    const result = evaluateEventTruth({
      watchKey: 'current_event',
      candidate: {
        eventId: 'completed_fixture_2026_07_18',
        eventName: 'UFC Completed Fixture',
        eventDateUtc: '2026-07-18',
        eventStatus: EVENT_STATUS.COMPLETED,
        mainCard: [validFight()],
        sourcePrimary: 'ufc.example',
        sourceSecondary: 'stats.example',
      },
      verification: {
        compatibleSourceCount: 2,
        structuredCardSource: true,
        verifiedAt: '2026-07-18T11:59:00.000Z',
        completionVerified: true,
        statsVerified: true,
      },
      now: '2026-07-18T12:00:00.000Z',
    });

    assert.equal(result.confidence, EVENT_CONFIDENCE.VERIFIED);
    assert.equal(result.consumerAllowed, true);
    assert.equal(result.ledgerMutationAllowed, true);
  }

  console.log('All event truth gate tests passed.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runEventTruthGateTests().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
