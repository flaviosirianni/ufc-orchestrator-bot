import crypto from 'node:crypto';
import '../core/env.js';
import { evaluateEventConsumption, evaluateEventTruth } from './eventTruthGate.js';
import { resolveNextEventFromOddsRows } from './oddsEventResolver.js';

const EVENT_INTEL_DISCOVERY_INTERVAL_MS = Number(
  process.env.EVENT_INTEL_DISCOVERY_INTERVAL_MS ?? String(6 * 60 * 60 * 1000)
);
const EVENT_INTEL_NEWS_BASE_TICK_MS = Number(
  process.env.EVENT_INTEL_NEWS_BASE_TICK_MS ?? String(60 * 60 * 1000)
);
const EVENT_INTEL_NEWS_SCAN_MS_FAR = Number(
  process.env.EVENT_INTEL_NEWS_SCAN_MS_FAR ?? String(8 * 60 * 60 * 1000)
);
const EVENT_INTEL_NEWS_SCAN_MS_NEAR = Number(
  process.env.EVENT_INTEL_NEWS_SCAN_MS_NEAR ?? String(4 * 60 * 60 * 1000)
);
const EVENT_INTEL_NEWS_SCAN_MS_FINAL = Number(
  process.env.EVENT_INTEL_NEWS_SCAN_MS_FINAL ?? String(2 * 60 * 60 * 1000)
);
const EVENT_INTEL_NEWS_LOOKBACK_DAYS = Number(
  process.env.EVENT_INTEL_NEWS_LOOKBACK_DAYS ?? '4'
);
const EVENT_INTEL_NEWS_MAX_PER_FIGHTER = Number(
  process.env.EVENT_INTEL_NEWS_MAX_PER_FIGHTER ?? '6'
);

function nowIso(date = new Date()) {
  return date.toISOString();
}

function normalize(value = '') {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function slugify(value = '') {
  return normalize(value)
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
}

function hash(value = '') {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function toIsoDate(value = '') {
  const raw = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function daysUntilEvent(eventDateIso = null) {
  if (!eventDateIso) return null;
  const target = Date.parse(`${eventDateIso}T00:00:00Z`);
  if (!Number.isFinite(target)) return null;
  const now = Date.now();
  return Math.floor((target - now) / 86400000);
}

function recommendedNewsCadenceMs(eventDateIso = null) {
  const days = daysUntilEvent(eventDateIso);
  if (days === null) return EVENT_INTEL_NEWS_SCAN_MS_FAR;
  if (days <= 1) return EVENT_INTEL_NEWS_SCAN_MS_FINAL;
  if (days <= 3) return EVENT_INTEL_NEWS_SCAN_MS_NEAR;
  return EVENT_INTEL_NEWS_SCAN_MS_FAR;
}

function sourceConfidenceScore(domain = '') {
  const host = normalize(domain);
  if (!host) return 55;
  if (host.includes('ufc.com')) return 92;
  if (host.includes('espn.com')) return 88;
  if (host.includes('sherdog.com') || host.includes('tapology.com')) return 76;
  if (host.includes('mmajunkie.usatoday.com') || host.includes('bloodyelbow.com')) return 70;
  return 62;
}

function classifyImpact(title = '') {
  const text = normalize(title);
  const highSignals = [
    'injury',
    'injured',
    'out of',
    'out for',
    'withdraw',
    'withdrawn',
    'replacement',
    'replaced',
    'miss weight',
    'weight miss',
    'fails weigh',
    'hospital',
    'suspend',
    'cancel',
    'cancelled',
    'visa issue',
  ];
  const mediumSignals = [
    'camp',
    'coach',
    'training',
    'weigh in',
    'weigh-in',
    'statement',
    'interview',
    'strategy',
    'gameplan',
  ];

  if (highSignals.some((signal) => text.includes(signal))) {
    return {
      impactLevel: 'high',
      impactScore: 86,
      tags: ['roster_or_availability_risk'],
    };
  }
  if (mediumSignals.some((signal) => text.includes(signal))) {
    return {
      impactLevel: 'medium',
      impactScore: 64,
      tags: ['pre_fight_signal'],
    };
  }
  return {
    impactLevel: 'low',
    impactScore: 38,
    tags: ['general_update'],
  };
}

/**
 * Extrae el último token de un nombre normalizado (apellido) para matching tolerante entre fuentes.
 *
 * @returns {string} Último token en minúsculas sin acentos, o cadena vacía.
 * @sideEffects Ninguno.
 */
function surname(name = '') {
  return normalize(name).split(/\s+/).filter(Boolean).slice(-1)[0] || '';
}

/**
 * Verifica si el contexto web menciona al mismo main event que el candidato de Odds API,
 * comparando apellidos (nombre completo puede variar entre fuentes, ej. "Garry" vs "Machado Garry").
 *
 * @returns {boolean} true si el contexto web corrobora el main event de Odds API.
 * @sideEffects Ninguno.
 */
function webCorroboratesOddsMainEvent(context = {}, fighterA = '', fighterB = '') {
  const surnameA = surname(fighterA);
  const surnameB = surname(fighterB);
  if (!surnameA || !surnameB) return false;

  const fights = Array.isArray(context?.fights) ? context.fights : [];
  const inFights = fights.some((fight) => {
    const a = normalize(fight?.fighterA || '');
    const b = normalize(fight?.fighterB || '');
    const direct = a.includes(surnameA) && b.includes(surnameB);
    const reverse = a.includes(surnameB) && b.includes(surnameA);
    return direct || reverse;
  });
  if (inFights) return true;

  const eventNameNorm = normalize(context?.eventName || '');
  return eventNameNorm.includes(surnameA) && eventNameNorm.includes(surnameB);
}

function extractUniqueFighters(fights = []) {
  if (!Array.isArray(fights)) return [];
  const seen = new Set();
  const out = [];
  for (const fight of fights) {
    for (const raw of [fight?.fighterA, fight?.fighterB]) {
      const name = String(raw || '').trim();
      if (!name) continue;
      const key = normalize(name);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(name);
    }
  }
  return out;
}

function buildEventId({ eventName = '', eventDate = '' } = {}) {
  const safeDate = toIsoDate(eventDate) || 'unknown_date';
  const safeName = slugify(eventName || 'ufc_next_event');
  return `${safeName}_${safeDate}`;
}

function isFighterMentioned(title = '', fighterName = '') {
  const text = normalize(title);
  const fighter = normalize(fighterName);
  if (!text || !fighter) return false;
  if (text.includes(fighter)) return true;
  const surname = fighter.split(/\s+/).filter(Boolean).slice(-1)[0] || '';
  if (surname.length >= 4 && text.includes(surname)) return true;
  return false;
}

function mapNewsItem({ raw = {}, fighterName = '', eventId = '' } = {}) {
  const title = String(raw?.title || '').trim();
  const url = String(raw?.link || '').trim();
  if (!title || !url) return null;

  const publishedAtIso = toIsoDate(raw?.publishedAt)
    ? new Date(String(raw.publishedAt)).toISOString()
    : null;
  const mention = isFighterMentioned(title, fighterName);
  const impact = classifyImpact(title);
  const dedupeBase = `${normalize(url)}::${normalize(title)}::${publishedAtIso?.slice(0, 10) || ''}`;

  return {
    eventId: String(eventId || '').trim() || 'unknown_event',
    fighterSlug: slugify(fighterName),
    fighterNameDisplay: fighterName,
    title,
    url,
    sourceDomain: String(raw?.source || '').trim() || null,
    publishedAt: publishedAtIso,
    fetchedAt: nowIso(),
    summary: null,
    impactLevel: impact.impactLevel,
    impactScore: impact.impactScore,
    confidenceScore: sourceConfidenceScore(raw?.source),
    tags: impact.tags,
    contentHash: hash(`${title}::${url}`),
    dedupeKey: hash(dedupeBase),
    isRelevant: mention ? 1 : 0,
  };
}

/**
 * Descubre el próximo candidato de evento (Odds API como fuente estructurada primaria si está
 * disponible, con noticias web como corroboración de quorum; cae al camino web puro si no hay
 * filas de Odds), lo evalúa fail-closed y persiste candidato más veredicto.
 *
 * @returns {Promise<object>} Resultado del descubrimiento con decisión de confianza.
 * @sideEffects Consulta web y escribe estado/auditoría mediante el store inyectado.
 */
export async function discoverNextEvent({
  buildWebContextForMessage,
  upsertEventWatchState,
  listUpcomingOddsEvents,
  fetchImpl,
  now = new Date(),
} = {}) {
  if (typeof buildWebContextForMessage !== 'function' || typeof upsertEventWatchState !== 'function') {
    return { ok: false, error: 'missing_dependencies' };
  }

  const evaluatedAt = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(evaluatedAt.getTime())) {
    return { ok: false, error: 'invalid_evaluation_time' };
  }

  const oddsCandidate =
    typeof listUpcomingOddsEvents === 'function'
      ? resolveNextEventFromOddsRows(listUpcomingOddsEvents())
      : null;

  const context = await buildWebContextForMessage(
    'cual es el proximo evento de ufc y su main card?',
    {
      force: true,
      fetchImpl,
      referenceDate: new Date(),
    }
  );

  let eventName;
  let eventDate;
  let mainCard;
  let sourcePrimary;
  let sourceSecondary = null;
  let structuredCardSource;
  let compatibleSourceCount;

  if (oddsCandidate) {
    eventName = oddsCandidate.eventName;
    eventDate = oddsCandidate.eventDateUtc;
    mainCard = oddsCandidate.mainCard;
    sourcePrimary = oddsCandidate.sourcePrimary;
    structuredCardSource = oddsCandidate.structuredCardSource;
    const corroborated = webCorroboratesOddsMainEvent(
      context,
      oddsCandidate.mainEventFighterA,
      oddsCandidate.mainEventFighterB
    );
    if (corroborated) {
      sourceSecondary = context.source || 'web_news';
    }
    compatibleSourceCount = corroborated ? 2 : 1;
  } else {
    if (!context?.eventName) {
      return { ok: false, error: 'event_not_found' };
    }
    const fights = Array.isArray(context.fights) ? context.fights : [];
    eventName = context.eventName;
    eventDate = toIsoDate(context.date);
    mainCard = fights.map((fight, index) => ({
      fightId: `fight_${index + 1}`,
      fighterA: fight.fighterA,
      fighterB: fight.fighterB,
    }));
    sourcePrimary = context.source || null;
    structuredCardSource = context.structuredCardSource === true;
    const declaredSourceCount = Number(context.compatibleSourceCount);
    compatibleSourceCount = Number.isFinite(declaredSourceCount)
      ? declaredSourceCount
      : Array.isArray(context.compatibleSources)
        ? context.compatibleSources.length
        : context.source
          ? 1
          : 0;
  }

  const monitoredFighters = extractUniqueFighters(mainCard);
  const candidate = {
    watchKey: 'next_event',
    eventId: buildEventId({ eventName, eventDate }),
    eventName,
    eventDateUtc: eventDate,
    eventStatus: 'scheduled',
    sourcePrimary,
    sourceSecondary,
    mainCard,
    monitoredFighters,
    lastReconciledAt: nowIso(evaluatedAt),
  };
  const verification = evaluateEventTruth({
    watchKey: 'next_event',
    candidate,
    verification: {
      compatibleSourceCount,
      structuredCardSource,
      liveSignalCount: Number(context?.liveSignalCount || 0),
      verifiedAt: nowIso(evaluatedAt),
    },
    now: evaluatedAt,
  });
  const snapshot = upsertEventWatchState({ ...candidate, verification }, 'next_event');

  return {
    ok: true,
    event: snapshot,
    verification,
  };
}

/**
 * Escanea noticias sólo cuando el evento mantiene verificación consumible vigente.
 *
 * @returns {Promise<object>} Resultado de inserción o bloqueo con razones.
 * @sideEffects Consulta RSS y puede insertar noticias mediante dependencias inyectadas.
 */
export async function scanFighterNews({
  getEventWatchState,
  fetchGoogleNewsRss,
  insertFighterNewsItems,
  fetchImpl,
  now = new Date(),
} = {}) {
  if (
    typeof getEventWatchState !== 'function' ||
    typeof fetchGoogleNewsRss !== 'function' ||
    typeof insertFighterNewsItems !== 'function'
  ) {
    return { ok: false, error: 'missing_dependencies' };
  }

  const event = getEventWatchState('next_event');
  if (!event?.eventId || !Array.isArray(event.monitoredFighters) || !event.monitoredFighters.length) {
    return { ok: false, error: 'no_event_to_scan' };
  }
  const consumption = evaluateEventConsumption({ eventState: event, now });
  if (!consumption.allowed) {
    return {
      ok: false,
      blocked: true,
      error: 'event_not_verified',
      reasons: consumption.reasons,
    };
  }

  const eventName = String(event.eventName || '').trim();
  const allItems = [];
  for (const fighterName of event.monitoredFighters) {
    const query = `${fighterName} UFC ${eventName} injury replacement weigh in`;
    const rssItems = await fetchGoogleNewsRss({
      query,
      days: EVENT_INTEL_NEWS_LOOKBACK_DAYS,
      fetchImpl,
    }).catch(() => []);

    const mapped = rssItems
      .slice(0, EVENT_INTEL_NEWS_MAX_PER_FIGHTER)
      .map((item) => mapNewsItem({ raw: item, fighterName, eventId: event.eventId }))
      .filter(Boolean);

    allItems.push(...mapped);
  }

  if (!allItems.length) {
    return { ok: true, insertedCount: 0, scannedFighters: event.monitoredFighters.length };
  }

  const result = insertFighterNewsItems(allItems);
  return {
    ok: true,
    insertedCount: Number(result?.insertedCount) || 0,
    scannedFighters: event.monitoredFighters.length,
  };
}

export function startEventIntelMonitor({
  buildWebContextForMessage,
  fetchGoogleNewsRss,
  getEventWatchState,
  upsertEventWatchState,
  insertFighterNewsItems,
  listUpcomingOddsEvents,
  fetchImpl = fetch,
} = {}) {
  if (
    typeof buildWebContextForMessage !== 'function' ||
    typeof fetchGoogleNewsRss !== 'function' ||
    typeof getEventWatchState !== 'function' ||
    typeof upsertEventWatchState !== 'function' ||
    typeof insertFighterNewsItems !== 'function'
  ) {
    return { stop: () => {} };
  }

  let discoverInFlight = false;
  let scanInFlight = false;
  let lastNewsScanAtMs = 0;

  const runDiscovery = async () => {
    if (discoverInFlight) return;
    discoverInFlight = true;
    try {
      const discovered = await discoverNextEvent({
        buildWebContextForMessage,
        upsertEventWatchState,
        listUpcomingOddsEvents,
        fetchImpl,
      });
      if (discovered?.ok) {
        const eventName = discovered?.event?.eventName || 'unknown_event';
        const eventDate = discovered?.event?.eventDateUtc || 'unknown_date';
        console.log(`[eventIntel] Next event reconciled: ${eventName} (${eventDate}).`);
      }
    } catch (error) {
      console.error('❌ eventIntel discovery job failed:', error);
    } finally {
      discoverInFlight = false;
    }
  };

  const runNewsScan = async ({ force = false } = {}) => {
    const event = getEventWatchState('next_event');
    const cadenceMs = recommendedNewsCadenceMs(event?.eventDateUtc || null);
    if (!force && Date.now() - lastNewsScanAtMs < cadenceMs) {
      return;
    }
    if (scanInFlight) return;
    scanInFlight = true;
    try {
      const scanned = await scanFighterNews({
        getEventWatchState,
        fetchGoogleNewsRss,
        insertFighterNewsItems,
        fetchImpl,
      });
      lastNewsScanAtMs = Date.now();
      if (scanned?.ok && Number(scanned.insertedCount) > 0) {
        console.log(
          `[eventIntel] News scan inserted ${scanned.insertedCount} item(s) for ${scanned.scannedFighters} fighter(s).`
        );
      }
    } catch (error) {
      console.error('❌ eventIntel news scan failed:', error);
    } finally {
      scanInFlight = false;
    }
  };

  const discoveryTimer = setInterval(() => {
    runDiscovery().catch((error) => {
      console.error('❌ eventIntel discovery interval failed:', error);
    });
  }, Math.max(15_000, EVENT_INTEL_DISCOVERY_INTERVAL_MS));

  const newsTimer = setInterval(() => {
    runNewsScan().catch((error) => {
      console.error('❌ eventIntel news interval failed:', error);
    });
  }, Math.max(15_000, EVENT_INTEL_NEWS_BASE_TICK_MS));

  runDiscovery()
    .then(() => runNewsScan({ force: true }))
    .catch((error) => {
      console.error('❌ eventIntel initial run failed:', error);
    });

  return {
    stop() {
      clearInterval(discoveryTimer);
      clearInterval(newsTimer);
    },
  };
}

export default {
  discoverNextEvent,
  scanFighterNews,
  startEventIntelMonitor,
};
