import crypto from 'node:crypto';
import '../core/env.js';

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

function nowIso() {
  return new Date().toISOString();
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

async function discoverNextEvent({
  buildWebContextForMessage,
  upsertEventWatchState,
  fetchImpl,
} = {}) {
  if (typeof buildWebContextForMessage !== 'function' || typeof upsertEventWatchState !== 'function') {
    return { ok: false, error: 'missing_dependencies' };
  }

  const context = await buildWebContextForMessage(
    'cual es el proximo evento de ufc y su main card?',
    {
      force: true,
      fetchImpl,
      referenceDate: new Date(),
    }
  );

  if (!context?.eventName) {
    return { ok: false, error: 'event_not_found' };
  }

  const fights = Array.isArray(context.fights) ? context.fights : [];
  const monitoredFighters = extractUniqueFighters(fights);
  const eventDate = toIsoDate(context.date);
  const snapshot = upsertEventWatchState({
    watchKey: 'next_event',
    eventId: buildEventId({ eventName: context.eventName, eventDate }),
    eventName: context.eventName,
    eventDateUtc: eventDate,
    eventStatus: 'scheduled',
    sourcePrimary: context.source || null,
    sourceSecondary: null,
    mainCard: fights.map((fight, index) => ({
      fightId: `fight_${index + 1}`,
      fighterA: fight.fighterA,
      fighterB: fight.fighterB,
    })),
    monitoredFighters,
    lastReconciledAt: nowIso(),
  });

  return {
    ok: true,
    event: snapshot,
  };
}

async function scanFighterNews({
  getEventWatchState,
  fetchGoogleNewsRss,
  insertFighterNewsItems,
  fetchImpl,
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
  startEventIntelMonitor,
};
