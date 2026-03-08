import '../core/env.js';

const ODDS_INTEL_SPORT_KEY =
  process.env.ODDS_API_MMA_SPORT_KEY || 'mma_mixed_martial_arts';
const ODDS_INTEL_ODDS_INTERVAL_MS = Number(
  process.env.ODDS_INTEL_ODDS_INTERVAL_MS ?? String(2 * 60 * 60 * 1000)
);
const ODDS_INTEL_EVENTS_INTERVAL_MS = Number(
  process.env.ODDS_INTEL_EVENTS_INTERVAL_MS ?? String(6 * 60 * 60 * 1000)
);
const ODDS_INTEL_SCORES_INTERVAL_MS = Number(
  process.env.ODDS_INTEL_SCORES_INTERVAL_MS ?? String(4 * 60 * 60 * 1000)
);
const ODDS_INTEL_MIN_REQUESTS_REMAINING = Number(
  process.env.ODDS_INTEL_MIN_REQUESTS_REMAINING ?? '20'
);
const ODDS_INTEL_REGIONS = process.env.ODDS_API_DEFAULT_REGIONS || 'us';
const ODDS_INTEL_MARKETS = process.env.ODDS_API_DEFAULT_MARKETS || 'h2h';
const ODDS_INTEL_ODDS_FORMAT = process.env.ODDS_API_DEFAULT_ODDS_FORMAT || 'decimal';
const ODDS_INTEL_DATE_FORMAT = process.env.ODDS_API_DEFAULT_DATE_FORMAT || 'iso';
const ODDS_INTEL_SCORES_DAYS_FROM = Number(process.env.ODDS_INTEL_SCORES_DAYS_FROM ?? '2');
const ODDS_INTEL_LOOKAHEAD_DAYS = Number(process.env.ODDS_INTEL_LOOKAHEAD_DAYS ?? '45');

function normalizeText(value = '') {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function toFightKey(a = '', b = '') {
  const left = normalizeText(a);
  const right = normalizeText(b);
  if (!left || !right) return '';
  return [left, right].sort().join('::');
}

function shiftIsoUtc(daysDelta = 0) {
  const date = new Date(Date.now() + Number(daysDelta || 0) * 86400000);
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function mapEventIndexRows(payload = [], sportKey = ODDS_INTEL_SPORT_KEY) {
  const events = Array.isArray(payload) ? payload : [];
  return events
    .map((item) => {
      const eventId = String(item?.id || '').trim();
      if (!eventId) return null;
      const homeTeam = String(item?.home_team || '').trim();
      const awayTeam = String(item?.away_team || '').trim();
      return {
        eventId,
        sportKey: String(item?.sport_key || sportKey || '').trim() || sportKey,
        eventName: homeTeam && awayTeam ? `${homeTeam} vs ${awayTeam}` : eventId,
        eventNormKey: toFightKey(homeTeam, awayTeam),
        commenceTime: item?.commence_time || null,
        homeTeam: homeTeam || null,
        awayTeam: awayTeam || null,
        completed: item?.completed === true,
        scores: Array.isArray(item?.scores) ? item.scores : null,
      };
    })
    .filter(Boolean);
}

function extractWatchKeys(eventWatchState = null) {
  const fights = Array.isArray(eventWatchState?.mainCard) ? eventWatchState.mainCard : [];
  const keys = new Set();
  for (const fight of fights) {
    const key = toFightKey(fight?.fighterA || '', fight?.fighterB || '');
    if (!key) continue;
    keys.add(key);
  }
  return keys;
}

function filterSnapshotsByWatch(snapshots = [], watchKeys = new Set()) {
  if (!(watchKeys instanceof Set) || !watchKeys.size) {
    return Array.isArray(snapshots) ? snapshots : [];
  }
  const rows = Array.isArray(snapshots) ? snapshots : [];
  return rows.filter((row) => {
    const key = toFightKey(row?.homeTeam || '', row?.awayTeam || '');
    return key && watchKeys.has(key);
  });
}

export function startOddsIntelMonitor({
  oddsApi,
  getLatestOddsApiQuotaState,
  upsertOddsEventsIndex,
  insertOddsMarketSnapshots,
  getEventWatchState,
} = {}) {
  if (
    !oddsApi ||
    typeof oddsApi.getOdds !== 'function' ||
    typeof oddsApi.getEvents !== 'function' ||
    typeof oddsApi.getScores !== 'function' ||
    typeof oddsApi.normalizeSnapshotsFromOddsPayload !== 'function' ||
    typeof upsertOddsEventsIndex !== 'function' ||
    typeof insertOddsMarketSnapshots !== 'function'
  ) {
    return { stop() {} };
  }

  let oddsInFlight = false;
  let eventsInFlight = false;
  let scoresInFlight = false;
  let lastRequestsRemaining = null;

  function hasQuotaForSync() {
    const storeQuota = getLatestOddsApiQuotaState?.();
    const remaining =
      storeQuota?.requestsRemaining ??
      (Number.isFinite(Number(lastRequestsRemaining)) ? Number(lastRequestsRemaining) : null);
    if (remaining === null || remaining === undefined) {
      return true;
    }
    return Number(remaining) > ODDS_INTEL_MIN_REQUESTS_REMAINING;
  }

  function rememberQuota(meta = {}) {
    if (meta?.requestsRemaining === null || meta?.requestsRemaining === undefined) return;
    if (Number.isFinite(Number(meta.requestsRemaining))) {
      lastRequestsRemaining = Number(meta.requestsRemaining);
    }
  }

  async function runEventsSync({ force = false } = {}) {
    if (eventsInFlight) return;
    if (!force && !hasQuotaForSync()) return;
    eventsInFlight = true;
    try {
      const result = await oddsApi.getEvents({
        sport: ODDS_INTEL_SPORT_KEY,
        dateFormat: ODDS_INTEL_DATE_FORMAT,
        commenceTimeFrom: shiftIsoUtc(-1),
        commenceTimeTo: shiftIsoUtc(ODDS_INTEL_LOOKAHEAD_DAYS),
        force,
      });
      rememberQuota(result?.meta);
      if (!result?.ok || !Array.isArray(result?.data)) return;
      const rows = mapEventIndexRows(result.data, ODDS_INTEL_SPORT_KEY);
      if (!rows.length) return;
      const upserted = upsertOddsEventsIndex(rows);
      console.log(
        `[oddsIntel] Events sync upserted ${upserted?.upsertedCount || 0} event row(s).`
      );
    } catch (error) {
      console.error('❌ oddsIntel events sync failed:', error);
    } finally {
      eventsInFlight = false;
    }
  }

  async function runOddsSync({ force = false } = {}) {
    if (oddsInFlight) return;
    if (!force && !hasQuotaForSync()) return;
    oddsInFlight = true;
    try {
      const eventWatchState =
        typeof getEventWatchState === 'function' ? getEventWatchState('next_event') : null;
      const watchKeys = extractWatchKeys(eventWatchState);

      const result = await oddsApi.getOdds({
        sport: ODDS_INTEL_SPORT_KEY,
        regions: ODDS_INTEL_REGIONS,
        markets: ODDS_INTEL_MARKETS,
        oddsFormat: ODDS_INTEL_ODDS_FORMAT,
        dateFormat: ODDS_INTEL_DATE_FORMAT,
        commenceTimeFrom: shiftIsoUtc(-1),
        commenceTimeTo: shiftIsoUtc(ODDS_INTEL_LOOKAHEAD_DAYS),
        force,
      });
      rememberQuota(result?.meta);
      if (!result?.ok || !Array.isArray(result?.data)) return;

      const allSnapshots = oddsApi.normalizeSnapshotsFromOddsPayload({
        sportKey: ODDS_INTEL_SPORT_KEY,
        payload: result.data,
      });
      const relevantSnapshots = filterSnapshotsByWatch(allSnapshots, watchKeys);
      const snapshotsToInsert = relevantSnapshots.length ? relevantSnapshots : allSnapshots;

      const eventsRows = mapEventIndexRows(result.data, ODDS_INTEL_SPORT_KEY);
      if (eventsRows.length) {
        upsertOddsEventsIndex(eventsRows, { markOddsSyncAt: true });
      }

      if (snapshotsToInsert.length) {
        const inserted = insertOddsMarketSnapshots(snapshotsToInsert);
        console.log(
          `[oddsIntel] Odds sync inserted ${inserted?.insertedCount || 0} market snapshot(s).`
        );
      }
    } catch (error) {
      console.error('❌ oddsIntel odds sync failed:', error);
    } finally {
      oddsInFlight = false;
    }
  }

  async function runScoresSync({ force = false } = {}) {
    if (scoresInFlight) return;
    if (!force && !hasQuotaForSync()) return;
    scoresInFlight = true;
    try {
      const result = await oddsApi.getScores({
        sport: ODDS_INTEL_SPORT_KEY,
        daysFrom: ODDS_INTEL_SCORES_DAYS_FROM,
        dateFormat: ODDS_INTEL_DATE_FORMAT,
        force,
      });
      rememberQuota(result?.meta);
      if (!result?.ok || !Array.isArray(result?.data)) return;
      const rows = mapEventIndexRows(result.data, ODDS_INTEL_SPORT_KEY);
      if (!rows.length) return;
      const upserted = upsertOddsEventsIndex(rows, { markScoresSyncAt: true });
      console.log(
        `[oddsIntel] Scores sync upserted ${upserted?.upsertedCount || 0} event row(s).`
      );
    } catch (error) {
      console.error('❌ oddsIntel scores sync failed:', error);
    } finally {
      scoresInFlight = false;
    }
  }

  const eventsTimer = setInterval(() => {
    runEventsSync().catch((error) => {
      console.error('❌ oddsIntel events interval failed:', error);
    });
  }, Math.max(15_000, ODDS_INTEL_EVENTS_INTERVAL_MS));

  const oddsTimer = setInterval(() => {
    runOddsSync().catch((error) => {
      console.error('❌ oddsIntel odds interval failed:', error);
    });
  }, Math.max(15_000, ODDS_INTEL_ODDS_INTERVAL_MS));

  const scoresTimer = setInterval(() => {
    runScoresSync().catch((error) => {
      console.error('❌ oddsIntel scores interval failed:', error);
    });
  }, Math.max(15_000, ODDS_INTEL_SCORES_INTERVAL_MS));

  runEventsSync({ force: true })
    .then(() => runOddsSync({ force: true }))
    .then(() => runScoresSync({ force: true }))
    .catch((error) => {
      console.error('❌ oddsIntel initial sync failed:', error);
    });

  return {
    stop() {
      clearInterval(eventsTimer);
      clearInterval(oddsTimer);
      clearInterval(scoresTimer);
    },
  };
}

export default {
  startOddsIntelMonitor,
};
