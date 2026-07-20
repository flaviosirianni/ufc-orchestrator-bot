import crypto from 'node:crypto';

export const EVENT_STATUS = Object.freeze({
  SCHEDULED: 'scheduled',
  LIVE: 'live',
  COMPLETED: 'completed',
  UNKNOWN: 'unknown',
});

export const EVENT_CONFIDENCE = Object.freeze({
  VERIFIED: 'verified',
  DEGRADED: 'degraded',
  INVALID: 'invalid',
  STALE: 'stale',
});

export const EVENT_TRUTH_VERSION = 'event-truth/v1';

const VALID_STATUSES = new Set(Object.values(EVENT_STATUS));
const TITLE_LIKE_FIGHTER_PATTERN =
  /\b(preview|fight card|full card|main card|prelims?|live updates?|results?|analysis|predictions?)\b/i;

/**
 * Normaliza texto deportivo para validaciones conservadoras sin depender de acentos o casing.
 *
 * @returns {string} Texto normalizado.
 * @sideEffects Ninguno.
 */
function normalizeText(value = '') {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Convierte valores arbitrarios a un objeto con claves ordenadas para hashing reproducible.
 *
 * @returns {*} Valor estable y serializable.
 * @sideEffects Ninguno.
 */
function stableValue(value) {
  if (Array.isArray(value)) return value.map((item) => stableValue(item));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])])
  );
}

/**
 * Calcula un SHA-256 determinístico de un payload JSON.
 *
 * @returns {string} Digest hexadecimal.
 * @sideEffects Ninguno.
 */
function hashPayload(payload = {}) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(stableValue(payload)))
    .digest('hex');
}

/**
 * Convierte un timestamp válido a milisegundos o devuelve null.
 *
 * @returns {number|null} Epoch en milisegundos.
 * @sideEffects Ninguno.
 */
function parseTimestamp(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Convierte una fecha deportiva a `YYYY-MM-DD` sin inventar fechas inválidas.
 *
 * @returns {string|null} Fecha ISO corta.
 * @sideEffects Ninguno.
 */
function toIsoDate(value) {
  const raw = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const parsed = Date.parse(`${raw}T00:00:00.000Z`);
    return Number.isFinite(parsed) ? raw : null;
  }
  const parsed = parseTimestamp(raw);
  return parsed === null ? null : new Date(parsed).toISOString().slice(0, 10);
}

/**
 * Resuelve el TTL operativo según watch key y estado, permitiendo override de test/config.
 *
 * @returns {number} TTL positivo en milisegundos.
 * @sideEffects Lee variables de entorno cuando no se pasa override.
 */
function resolveTtlMs({ watchKey = 'next_event', eventStatus = '', ttlMs } = {}) {
  const explicit = Number(ttlMs);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const isCurrent = watchKey === 'current_event' || eventStatus === EVENT_STATUS.LIVE;
  const raw = isCurrent
    ? process.env.EVENT_CURRENT_VERIFICATION_TTL_MS || String(15 * 60 * 1000)
    : process.env.EVENT_NEXT_VERIFICATION_TTL_MS || String(8 * 60 * 60 * 1000);
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : isCurrent
      ? 15 * 60 * 1000
      : 8 * 60 * 60 * 1000;
}

/**
 * Cuenta fuentes compatibles explícitas o, en su defecto, fuentes únicas del candidato.
 *
 * @returns {number} Cantidad no negativa de fuentes compatibles.
 * @sideEffects Ninguno.
 */
function resolveCompatibleSourceCount(candidate = {}, verification = {}) {
  const explicit = Number(verification.compatibleSourceCount);
  if (Number.isFinite(explicit) && explicit >= 0) return Math.floor(explicit);
  const sources = [candidate.sourcePrimary, candidate.sourceSecondary]
    .map((value) => normalizeText(value))
    .filter(Boolean);
  return new Set(sources).size;
}

/**
 * Revisa que la cartelera sea estructuralmente utilizable y no contenga títulos editoriales.
 *
 * @returns {string[]} Razones invalidantes en orden determinístico.
 * @sideEffects Ninguno.
 */
function validateMainCard(mainCard = []) {
  if (!Array.isArray(mainCard) || mainCard.length === 0) {
    return ['main_card_missing'];
  }

  const reasons = [];
  const fightKeys = new Set();
  for (const fight of mainCard) {
    const fighterA = String(fight?.fighterA || fight?.fighter_a || '').trim();
    const fighterB = String(fight?.fighterB || fight?.fighter_b || '').trim();
    if (!fighterA || !fighterB) {
      reasons.push('fighter_name_missing');
      continue;
    }
    if (
      TITLE_LIKE_FIGHTER_PATTERN.test(normalizeText(fighterA)) ||
      TITLE_LIKE_FIGHTER_PATTERN.test(normalizeText(fighterB))
    ) {
      reasons.push('title_like_fighter_name');
    }
    if (normalizeText(fighterA) === normalizeText(fighterB)) {
      reasons.push('duplicate_fighter_pair');
    }
    const fightKey = [normalizeText(fighterA), normalizeText(fighterB)].sort().join('::');
    if (fightKeys.has(fightKey)) {
      reasons.push('duplicate_fight');
    }
    fightKeys.add(fightKey);
  }
  return Array.from(new Set(reasons));
}

/**
 * Evalúa un candidato deportivo y produce una decisión fail-closed sin escribir estado.
 *
 * @returns {{version:string,watchKey:string,eventStatus:string,confidence:string,consumerAllowed:boolean,ledgerMutationAllowed:boolean,reasons:string[],evaluatedAt:string,lastVerifiedAt:string|null,expiresAt:string|null,compatibleSourceCount:number,candidateHash:string,evidence:object}} Decisión auditable.
 * @sideEffects Ninguno salvo lectura de TTL desde entorno cuando no se especifica.
 */
export function evaluateEventTruth({
  watchKey = 'next_event',
  candidate = {},
  verification = {},
  now = new Date(),
  ttlMs,
} = {}) {
  const nowMs = now instanceof Date ? now.getTime() : parseTimestamp(now);
  if (!Number.isFinite(nowMs)) {
    throw new Error('event_truth_invalid_evaluation_time');
  }

  const evaluatedAt = new Date(nowMs).toISOString();
  const rawStatus = normalizeText(candidate.eventStatus || EVENT_STATUS.UNKNOWN);
  const eventStatus = VALID_STATUSES.has(rawStatus) ? rawStatus : EVENT_STATUS.UNKNOWN;
  const eventDateIso = toIsoDate(candidate.eventDateUtc);
  const currentDateIso = evaluatedAt.slice(0, 10);
  const compatibleSourceCount = resolveCompatibleSourceCount(candidate, verification);
  const effectiveTtlMs = resolveTtlMs({ watchKey, eventStatus, ttlMs });
  const verifiedAtMs = parseTimestamp(
    verification.verifiedAt || verification.lastVerifiedAt || candidate.lastVerifiedAt
  );
  const lastVerifiedAt = verifiedAtMs === null ? null : new Date(verifiedAtMs).toISOString();
  const expiresAt =
    verifiedAtMs === null ? null : new Date(verifiedAtMs + effectiveTtlMs).toISOString();

  const invalidReasons = [];
  const staleReasons = [];
  const degradedReasons = [];

  if (!String(candidate.eventId || '').trim()) invalidReasons.push('event_id_missing');
  if (!String(candidate.eventName || '').trim()) invalidReasons.push('event_name_missing');
  if (eventStatus === EVENT_STATUS.UNKNOWN) invalidReasons.push('event_status_invalid');
  if (!eventDateIso) invalidReasons.push('event_date_missing');
  if (
    eventStatus === EVENT_STATUS.COMPLETED &&
    eventDateIso &&
    eventDateIso > currentDateIso
  ) {
    invalidReasons.push('future_event_marked_completed');
  }
  if (
    eventStatus === EVENT_STATUS.SCHEDULED &&
    eventDateIso &&
    eventDateIso < currentDateIso
  ) {
    staleReasons.push('scheduled_event_date_elapsed');
  }

  invalidReasons.push(...validateMainCard(candidate.mainCard));
  if (verification.structuredCardSource !== true) {
    invalidReasons.push('structured_card_source_missing');
  }
  if (compatibleSourceCount < 2) {
    degradedReasons.push('source_quorum_failed');
  }
  if (verifiedAtMs === null) {
    staleReasons.push('verification_timestamp_missing');
  } else if (nowMs > verifiedAtMs + effectiveTtlMs) {
    staleReasons.push('verification_ttl_exceeded');
  }
  if (eventStatus === EVENT_STATUS.LIVE && Number(verification.liveSignalCount || 0) < 1) {
    staleReasons.push('live_signal_missing');
  }

  let confidence = EVENT_CONFIDENCE.VERIFIED;
  if (invalidReasons.length) {
    confidence = EVENT_CONFIDENCE.INVALID;
  } else if (staleReasons.length) {
    confidence = EVENT_CONFIDENCE.STALE;
  } else if (degradedReasons.length) {
    confidence = EVENT_CONFIDENCE.DEGRADED;
  }

  const reasons = Array.from(
    new Set([...invalidReasons, ...staleReasons, ...degradedReasons])
  );
  const consumerAllowed = confidence === EVENT_CONFIDENCE.VERIFIED;
  const ledgerMutationAllowed = Boolean(
    consumerAllowed &&
      eventStatus === EVENT_STATUS.COMPLETED &&
      verification.completionVerified === true &&
      verification.statsVerified === true
  );
  const evidence = {
    compatibleSourceCount,
    structuredCardSource: verification.structuredCardSource === true,
    liveSignalCount: Number(verification.liveSignalCount || 0),
    completionVerified: verification.completionVerified === true,
    statsVerified: verification.statsVerified === true,
    ttlMs: effectiveTtlMs,
  };
  const candidateHash = hashPayload({
    watchKey: String(watchKey || 'next_event'),
    eventId: String(candidate.eventId || '').trim() || null,
    eventName: String(candidate.eventName || '').trim() || null,
    eventDateUtc: eventDateIso,
    eventStatus,
    sourcePrimary: String(candidate.sourcePrimary || '').trim() || null,
    sourceSecondary: String(candidate.sourceSecondary || '').trim() || null,
    mainCard: Array.isArray(candidate.mainCard) ? candidate.mainCard : [],
    evidence: {
      compatibleSourceCount,
      structuredCardSource: evidence.structuredCardSource,
      liveSignalCount: evidence.liveSignalCount,
      completionVerified: evidence.completionVerified,
      statsVerified: evidence.statsVerified,
    },
  });

  return {
    version: EVENT_TRUTH_VERSION,
    watchKey: String(watchKey || 'next_event'),
    eventStatus,
    confidence,
    consumerAllowed,
    ledgerMutationAllowed,
    reasons,
    evaluatedAt,
    lastVerifiedAt,
    expiresAt,
    compatibleSourceCount,
    candidateHash,
    evidence,
  };
}

/**
 * Revalida permisos de consumo en el instante de uso, incluyendo expiración y stats.
 *
 * @returns {{allowed:boolean,reasons:string[],eventAllowed:boolean,statsAllowed:boolean,ledgerMutationAllowed:boolean,evaluatedAt:string,statsAgeHours:number|null}} Decisión fail-closed de consumo.
 * @sideEffects Lee `UFC_STATS_MAX_AGE_HOURS` cuando no se pasa override.
 */
export function evaluateEventConsumption({
  eventState = null,
  statsFreshness = null,
  requireStats = false,
  requireLedgerMutation = false,
  now = new Date(),
  statsMaxAgeHours,
} = {}) {
  const nowMs = now instanceof Date ? now.getTime() : parseTimestamp(now);
  if (!Number.isFinite(nowMs)) {
    throw new Error('event_consumption_invalid_evaluation_time');
  }
  const reasons = [];
  const confidence = String(eventState?.confidence || 'invalid').trim().toLowerCase();
  if (!eventState?.eventId) {
    reasons.push('event_state_missing');
  }
  if (confidence !== EVENT_CONFIDENCE.VERIFIED) {
    reasons.push(`event_confidence_${confidence || EVENT_CONFIDENCE.INVALID}`);
  }
  if (eventState?.consumerAllowed !== true) {
    reasons.push('event_consumer_not_allowed');
  }

  const expiresAtMs = parseTimestamp(eventState?.verificationExpiresAt);
  if (expiresAtMs === null) {
    reasons.push('event_verification_expiry_missing');
  } else if (nowMs > expiresAtMs) {
    reasons.push('event_verification_stale');
  }

  const eventReasonCount = reasons.length;
  let statsAgeHours = null;
  if (requireStats) {
    if (!statsFreshness || statsFreshness.isAvailable !== true) {
      reasons.push('stats_unavailable');
    } else {
      if (
        statsFreshness.integrityOk === false ||
        statsFreshness.quickCheckOk === false
      ) {
        reasons.push('stats_integrity_failed');
      }
      const generatedAtMs = parseTimestamp(
        statsFreshness.generatedAt ||
          statsFreshness.fileMtimeIso ||
          statsFreshness.mtimeIso ||
          statsFreshness.dbGeneratedAt
      );
      if (generatedAtMs === null) {
        reasons.push('stats_generated_at_missing');
      } else if (generatedAtMs > nowMs + 5 * 60 * 1000) {
        reasons.push('stats_timestamp_future');
      } else {
        statsAgeHours = Math.max(0, (nowMs - generatedAtMs) / 3_600_000);
        const configuredMaxAge = Number(
          statsMaxAgeHours ?? process.env.UFC_STATS_MAX_AGE_HOURS ?? '36'
        );
        const maxAgeHours =
          Number.isFinite(configuredMaxAge) && configuredMaxAge > 0 ? configuredMaxAge : 36;
        if (statsAgeHours > maxAgeHours) {
          reasons.push('stats_stale');
        }
      }
    }
  }

  if (requireLedgerMutation) {
    if (String(eventState?.eventStatus || '').toLowerCase() !== EVENT_STATUS.COMPLETED) {
      reasons.push('event_not_completed');
    }
    if (eventState?.ledgerMutationAllowed !== true) {
      reasons.push('event_ledger_mutation_not_allowed');
    }
  }

  const uniqueReasons = Array.from(new Set(reasons));
  const statsReasons = new Set([
    'stats_unavailable',
    'stats_integrity_failed',
    'stats_generated_at_missing',
    'stats_timestamp_future',
    'stats_stale',
  ]);
  return {
    allowed: uniqueReasons.length === 0,
    reasons: uniqueReasons,
    eventAllowed: eventReasonCount === 0,
    statsAllowed: !uniqueReasons.some((reason) => statsReasons.has(reason)),
    ledgerMutationAllowed:
      requireLedgerMutation &&
      uniqueReasons.length === 0 &&
      eventState?.ledgerMutationAllowed === true,
    evaluatedAt: new Date(nowMs).toISOString(),
    statsAgeHours:
      statsAgeHours === null ? null : Number(statsAgeHours.toFixed(3)),
  };
}

export default {
  EVENT_STATUS,
  EVENT_CONFIDENCE,
  EVENT_TRUTH_VERSION,
  evaluateEventTruth,
  evaluateEventConsumption,
};
