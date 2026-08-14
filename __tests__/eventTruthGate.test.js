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

  {
    // Fase B (2026-08-14): un candidato sourced estructuralmente desde Odds API
    // (fuente paga, confiable) no debe quedar bloqueado por quorum de 2 fuentes
    // solo porque Google News no cubre un card chico (ej. UFC Fight Night sin
    // prensa). El quorum existe para desconfiar de fuentes NO estructuradas
    // (el caso UFC 329 de arriba, sourcePrimary editorial), no para bloquear un
    // solo source ya confiable/estructurado.
    const result = evaluateEventTruth({
      watchKey: 'next_event',
      candidate: {
        eventId: 'ufc_sidney_outlaw_vs_rasul_magomedov_2026_08_15',
        eventName: 'UFC: Sidney Outlaw vs Rasul Magomedov',
        eventDateUtc: '2026-08-15',
        eventStatus: EVENT_STATUS.SCHEDULED,
        mainCard: [validFight()],
        sourcePrimary: 'odds_api',
      },
      verification: {
        compatibleSourceCount: 1,
        structuredCardSource: true,
        verifiedAt: '2026-08-14T12:00:00.000Z',
      },
      now: '2026-08-14T18:00:00.000Z',
    });

    assert.equal(result.confidence, EVENT_CONFIDENCE.VERIFIED);
    assert.equal(result.consumerAllowed, true);
    assert.ok(!result.reasons.includes('source_quorum_failed'));
  }

  {
    // Mismo bypass para el path de "current_event" en vivo (odds_scores_live),
    // que usa el mismo mecanismo de deteccion en tiempo real via Odds API.
    const result = evaluateEventTruth({
      watchKey: 'current_event',
      candidate: {
        eventId: 'ufc_live_fixture_2026_08_15',
        eventName: 'UFC Live Fixture',
        eventDateUtc: '2026-08-15',
        eventStatus: EVENT_STATUS.LIVE,
        mainCard: [validFight()],
        sourcePrimary: 'odds_scores_live',
      },
      verification: {
        compatibleSourceCount: 1,
        structuredCardSource: true,
        liveSignalCount: 1,
        verifiedAt: '2026-08-15T00:00:00.000Z',
      },
      now: '2026-08-15T00:10:00.000Z',
      ttlMs: 15 * 60 * 1000,
    });

    assert.equal(result.confidence, EVENT_CONFIDENCE.VERIFIED);
    assert.equal(result.consumerAllowed, true);
    assert.ok(!result.reasons.includes('source_quorum_failed'));
  }

  {
    // Fase de auto-settlement (2026-08-14): ufc_stats_db tambien es una
    // fuente estructurada confiable (ya validada por getStatsFreshness en
    // otro lado) — un evento marcado completed con completionVerified +
    // statsVerified desde esta fuente debe llegar a ledgerMutationAllowed
    // sin necesitar una segunda fuente corroborando.
    const result = evaluateEventTruth({
      watchKey: 'current_event',
      candidate: {
        eventId: 'ufc_completed_fixture_2026_08_10',
        eventName: 'UFC Completed Fixture',
        eventDateUtc: '2026-08-10',
        eventStatus: EVENT_STATUS.COMPLETED,
        mainCard: [validFight()],
        sourcePrimary: 'ufc_stats_db',
      },
      verification: {
        compatibleSourceCount: 1,
        structuredCardSource: true,
        completionVerified: true,
        statsVerified: true,
        verifiedAt: '2026-08-12T00:00:00.000Z',
      },
      now: '2026-08-12T00:05:00.000Z',
    });

    assert.equal(result.confidence, EVENT_CONFIDENCE.VERIFIED);
    assert.equal(result.consumerAllowed, true);
    assert.equal(result.ledgerMutationAllowed, true);
    assert.ok(!result.reasons.includes('source_quorum_failed'));
  }

  {
    // El bypass NO debe aplicar solo por structuredCardSource:true si la fuente
    // no esta en el allowlist de fuentes confiables — evita que cualquier path
    // futuro que marque structuredCardSource=true sin ser realmente Odds API
    // se cuele sin quorum. sourcePrimary generico ("web_live_context") con
    // structuredCardSource:true y 1 sola fuente debe seguir bloqueado.
    const result = evaluateEventTruth({
      watchKey: 'next_event',
      candidate: {
        eventId: 'untrusted_structured_fixture_2026_08_15',
        eventName: 'UFC Untrusted Fixture',
        eventDateUtc: '2026-08-15',
        eventStatus: EVENT_STATUS.SCHEDULED,
        mainCard: [validFight()],
        sourcePrimary: 'web_live_context',
      },
      verification: {
        compatibleSourceCount: 1,
        structuredCardSource: true,
        verifiedAt: '2026-08-14T12:00:00.000Z',
      },
      now: '2026-08-14T18:00:00.000Z',
    });

    assert.ok(result.reasons.includes('source_quorum_failed'));
    assert.equal(result.consumerAllowed, false);
  }

  console.log('All event truth gate tests passed.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runEventTruthGateTests().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
