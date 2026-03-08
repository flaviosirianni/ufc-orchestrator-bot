import crypto from 'node:crypto';
import '../core/env.js';

const ODDS_API_BASE_URL = process.env.ODDS_API_BASE_URL || 'https://api.the-odds-api.com/v4';
const ODDS_API_KEY = process.env.ODDS_API_KEY || process.env.THE_ODDS_API_KEY || '';
const ODDS_API_TIMEOUT_MS = Number(process.env.ODDS_API_TIMEOUT_MS ?? '12000');
const ODDS_API_MMA_SPORT_KEY =
  process.env.ODDS_API_MMA_SPORT_KEY || 'mma_mixed_martial_arts';
const ODDS_API_DEFAULT_REGIONS = process.env.ODDS_API_DEFAULT_REGIONS || 'us';
const ODDS_API_DEFAULT_MARKETS = process.env.ODDS_API_DEFAULT_MARKETS || 'h2h';
const ODDS_API_DEFAULT_ODDS_FORMAT =
  process.env.ODDS_API_DEFAULT_ODDS_FORMAT || 'decimal';
const ODDS_API_DEFAULT_DATE_FORMAT = process.env.ODDS_API_DEFAULT_DATE_FORMAT || 'iso';

const CACHE_TTLS_MS = {
  sports: Number(process.env.ODDS_API_CACHE_TTL_SPORTS_MS ?? String(24 * 60 * 60 * 1000)),
  odds: Number(process.env.ODDS_API_CACHE_TTL_ODDS_MS ?? String(20 * 60 * 1000)),
  scores: Number(process.env.ODDS_API_CACHE_TTL_SCORES_MS ?? String(5 * 60 * 1000)),
  events: Number(process.env.ODDS_API_CACHE_TTL_EVENTS_MS ?? String(60 * 60 * 1000)),
  event_odds: Number(process.env.ODDS_API_CACHE_TTL_EVENT_ODDS_MS ?? String(10 * 60 * 1000)),
  event_markets: Number(
    process.env.ODDS_API_CACHE_TTL_EVENT_MARKETS_MS ?? String(20 * 60 * 1000)
  ),
  participants: Number(
    process.env.ODDS_API_CACHE_TTL_PARTICIPANTS_MS ?? String(24 * 60 * 60 * 1000)
  ),
  historical_odds: Number(
    process.env.ODDS_API_CACHE_TTL_HISTORICAL_ODDS_MS ?? String(7 * 24 * 60 * 60 * 1000)
  ),
  historical_events: Number(
    process.env.ODDS_API_CACHE_TTL_HISTORICAL_EVENTS_MS ?? String(7 * 24 * 60 * 60 * 1000)
  ),
  historical_event_odds: Number(
    process.env.ODDS_API_CACHE_TTL_HISTORICAL_EVENT_ODDS_MS ??
      String(7 * 24 * 60 * 60 * 1000)
  ),
};

function nowIso() {
  return new Date().toISOString();
}

function normalizeText(value = '') {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function toNormKey(a = '', b = '') {
  const left = normalizeText(a);
  const right = normalizeText(b);
  if (!left || !right) return '';
  return [left, right].sort().join('::');
}

function stableStringify(value) {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (typeof value !== 'object') {
    return JSON.stringify(value);
  }
  const keys = Object.keys(value).sort();
  const fields = keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
  return `{${fields.join(',')}}`;
}

function normalizeParams(raw = {}) {
  const out = {};
  for (const [key, value] of Object.entries(raw || {})) {
    if (value === undefined || value === null || value === '') continue;
    out[key] = value;
  }
  return out;
}

function normalizeOddsApiDateTime(value = null) {
  if (value === undefined || value === null || value === '') return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(raw)) return raw;

  const parsedMs = Date.parse(raw);
  if (!Number.isFinite(parsedMs)) return raw;
  return new Date(parsedMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function buildCacheKey(pathname = '', params = {}) {
  const normalizedPath = String(pathname || '').trim().replace(/\/+/g, '/');
  const normalizedParams = normalizeParams(params);
  const payload = `${normalizedPath}?${stableStringify(normalizedParams)}`;
  return crypto.createHash('sha256').update(payload).digest('hex');
}

function buildUrl(baseUrl, path, params = {}) {
  const base = String(baseUrl || ODDS_API_BASE_URL).trim().replace(/\/+$/, '');
  const cleanPath = String(path || '').trim().replace(/^\/+/, '');
  const url = new URL(`${base}/${cleanPath}`);
  for (const [key, value] of Object.entries(normalizeParams(params))) {
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function parseIntegerHeader(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function parseUsageHeaders(headers) {
  if (!headers || typeof headers.get !== 'function') {
    return {
      requestsRemaining: null,
      requestsUsed: null,
      requestsLast: null,
    };
  }

  return {
    requestsRemaining: parseIntegerHeader(headers.get('x-requests-remaining')),
    requestsUsed: parseIntegerHeader(headers.get('x-requests-used')),
    requestsLast: parseIntegerHeader(headers.get('x-requests-last')),
  };
}

function parseJsonOrThrow(text = '', context = '') {
  try {
    return text ? JSON.parse(text) : null;
  } catch (error) {
    throw new Error(`Invalid JSON payload for ${context}: ${error.message}`);
  }
}

function normalizeOutcomePrice(outcomes = [], target = '') {
  const winner = outcomes.find(
    (item) => normalizeText(item?.name || '') === normalizeText(target)
  );
  if (winner && Number.isFinite(Number(winner.price))) {
    return Number(winner.price);
  }
  return null;
}

function inferCounterpartyPrice(outcomes = [], target = '', fallbackName = '') {
  const targetNorm = normalizeText(target);
  const fallbackNorm = normalizeText(fallbackName);

  const counterpart =
    outcomes.find((item) => normalizeText(item?.name || '') === fallbackNorm) ||
    outcomes.find((item) => normalizeText(item?.name || '') !== targetNorm);
  if (counterpart && Number.isFinite(Number(counterpart.price))) {
    return Number(counterpart.price);
  }
  return null;
}

function buildDedupeKey(parts = []) {
  return crypto
    .createHash('sha256')
    .update(parts.map((item) => String(item || '')).join('::'))
    .digest('hex');
}

function normalizeSnapshotsFromOddsPayload({
  sportKey = '',
  payload = [],
  fetchedAt = nowIso(),
} = {}) {
  const events = Array.isArray(payload) ? payload : [];
  const snapshots = [];

  for (const event of events) {
    const eventId = String(event?.id || '').trim();
    if (!eventId) continue;

    const homeTeam = String(event?.home_team || '').trim();
    const awayTeam = String(event?.away_team || '').trim();
    const eventName = homeTeam && awayTeam ? `${homeTeam} vs ${awayTeam}` : eventId;
    const eventNormKey = toNormKey(homeTeam, awayTeam);
    const commenceTime = event?.commence_time || null;

    const bookmakers = Array.isArray(event?.bookmakers) ? event.bookmakers : [];
    for (const bookmaker of bookmakers) {
      const bookmakerKey = String(bookmaker?.key || '').trim();
      const bookmakerTitle = String(bookmaker?.title || '').trim();
      const bookmakerLastUpdate = bookmaker?.last_update || null;
      const markets = Array.isArray(bookmaker?.markets) ? bookmaker.markets : [];

      for (const market of markets) {
        const marketKey = String(market?.key || '').trim();
        if (!marketKey) continue;
        const marketLastUpdate = market?.last_update || bookmakerLastUpdate || null;
        const outcomes = Array.isArray(market?.outcomes) ? market.outcomes : [];

        const outcomeAName = homeTeam || outcomes[0]?.name || '';
        const outcomeBName = awayTeam || outcomes[1]?.name || '';
        const outcomeAPrice = normalizeOutcomePrice(outcomes, outcomeAName);
        const outcomeBPrice =
          normalizeOutcomePrice(outcomes, outcomeBName) ??
          inferCounterpartyPrice(outcomes, outcomeAName, outcomeBName);
        const drawPrice = normalizeOutcomePrice(outcomes, 'Draw');

        snapshots.push({
          provider: 'the_odds_api',
          sportKey: String(sportKey || event?.sport_key || '').trim(),
          eventId,
          eventName,
          eventNormKey,
          commenceTime,
          homeTeam: homeTeam || null,
          awayTeam: awayTeam || null,
          fighterANorm: normalizeText(homeTeam),
          fighterBNorm: normalizeText(awayTeam),
          bookmakerKey: bookmakerKey || null,
          bookmakerTitle: bookmakerTitle || null,
          marketKey,
          outcomeAName: outcomeAName || null,
          outcomeAPrice,
          outcomeBName: outcomeBName || null,
          outcomeBPrice,
          drawPrice,
          sourceLastUpdate: marketLastUpdate,
          fetchedAt,
          payloadJson: JSON.stringify({
            event_id: eventId,
            bookmaker: bookmaker,
            market: market,
          }),
          dedupeKey: buildDedupeKey([
            'the_odds_api',
            eventId,
            bookmakerKey,
            marketKey,
            marketLastUpdate,
            outcomeAName,
            outcomeAPrice,
            outcomeBName,
            outcomeBPrice,
            drawPrice,
          ]),
        });
      }
    }
  }

  return snapshots;
}

async function fetchJsonWithTimeout(url, { fetchImpl = fetch, timeoutMs = ODDS_API_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs));

  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        'User-Agent': 'ufc-orchestrator-bot/1.0',
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    const text = await response.text();
    const payload = parseJsonOrThrow(text, url);
    return { response, payload };
  } finally {
    clearTimeout(timeout);
  }
}

export function createOddsApiTool({
  apiKey = ODDS_API_KEY,
  baseUrl = ODDS_API_BASE_URL,
  fetchImpl = fetch,
  store = {},
} = {}) {
  const {
    getOddsApiCacheEntry,
    upsertOddsApiCacheEntry,
    logOddsApiUsage,
  } = store || {};

  async function request({
    path = '',
    params = {},
    ttlMs = 0,
    force = false,
    cacheNamespace = 'odds_api',
  } = {}) {
    const cleanApiKey = String(apiKey || '').trim();
    if (!cleanApiKey) {
      return {
        ok: false,
        error: 'odds_api_key_missing',
        data: null,
        meta: { cached: false },
      };
    }

    const cleanPath = String(path || '').trim();
    const cleanParams = normalizeParams(params);
    const cacheKey = buildCacheKey(`${cacheNamespace}:${cleanPath}`, cleanParams);
    const now = Date.now();

    if (!force && ttlMs > 0 && typeof getOddsApiCacheEntry === 'function') {
      const cached = getOddsApiCacheEntry(cacheKey);
      if (cached?.responseJson && cached?.expiresAt) {
        const expiresMs = Date.parse(String(cached.expiresAt));
        if (Number.isFinite(expiresMs) && expiresMs > now) {
          return {
            ok: true,
            data: cached.responseJson,
            meta: {
              cached: true,
              cacheKey,
              fetchedAt: cached.fetchedAt || null,
              expiresAt: cached.expiresAt || null,
              requestsRemaining: cached.requestsRemaining ?? null,
              requestsUsed: cached.requestsUsed ?? null,
              requestsLast: cached.requestsLast ?? null,
            },
          };
        }
      }
    }

    const url = buildUrl(baseUrl, cleanPath, {
      ...cleanParams,
      apiKey: cleanApiKey,
    });

    const { response, payload } = await fetchJsonWithTimeout(url, { fetchImpl });
    const usage = parseUsageHeaders(response.headers);

    if (typeof logOddsApiUsage === 'function') {
      logOddsApiUsage({
        endpoint: cleanPath,
        cacheKey,
        statusCode: response.status,
        requestsRemaining: usage.requestsRemaining,
        requestsUsed: usage.requestsUsed,
        requestsLast: usage.requestsLast,
        metadata: {
          params: cleanParams,
        },
      });
    }

    if (!response.ok) {
      return {
        ok: false,
        error: `odds_api_request_failed_${response.status}`,
        data: payload,
        meta: {
          cached: false,
          statusCode: response.status,
          url,
          ...usage,
        },
      };
    }

    if (ttlMs > 0 && typeof upsertOddsApiCacheEntry === 'function') {
      const fetchedAt = nowIso();
      const expiresAt = new Date(Date.now() + Math.max(1000, ttlMs)).toISOString();
      upsertOddsApiCacheEntry({
        cacheKey,
        endpoint: cleanPath,
        params: cleanParams,
        responseJson: payload,
        statusCode: response.status,
        fetchedAt,
        expiresAt,
        requestsRemaining: usage.requestsRemaining,
        requestsUsed: usage.requestsUsed,
        requestsLast: usage.requestsLast,
      });
    }

    return {
      ok: true,
      data: payload,
      meta: {
        cached: false,
        statusCode: response.status,
        url,
        ...usage,
      },
    };
  }

  return {
    request,
    getSports({
      all = true,
      force = false,
      ttlMs = CACHE_TTLS_MS.sports,
    } = {}) {
      return request({
        path: 'sports',
        params: { all: all ? 'true' : undefined },
        force,
        ttlMs,
        cacheNamespace: 'sports',
      });
    },
    getOdds({
      sport = ODDS_API_MMA_SPORT_KEY,
      regions = ODDS_API_DEFAULT_REGIONS,
      markets = ODDS_API_DEFAULT_MARKETS,
      bookmakers = null,
      oddsFormat = ODDS_API_DEFAULT_ODDS_FORMAT,
      dateFormat = ODDS_API_DEFAULT_DATE_FORMAT,
      eventIds = null,
      commenceTimeFrom = null,
      commenceTimeTo = null,
      force = false,
      ttlMs = CACHE_TTLS_MS.odds,
    } = {}) {
      return request({
        path: `sports/${sport}/odds`,
        params: {
          regions,
          markets,
          bookmakers,
          oddsFormat,
          dateFormat,
          eventIds,
          commenceTimeFrom: normalizeOddsApiDateTime(commenceTimeFrom),
          commenceTimeTo: normalizeOddsApiDateTime(commenceTimeTo),
        },
        force,
        ttlMs,
        cacheNamespace: 'odds',
      });
    },
    getScores({
      sport = ODDS_API_MMA_SPORT_KEY,
      daysFrom = 3,
      dateFormat = ODDS_API_DEFAULT_DATE_FORMAT,
      eventIds = null,
      force = false,
      ttlMs = CACHE_TTLS_MS.scores,
    } = {}) {
      return request({
        path: `sports/${sport}/scores`,
        params: {
          daysFrom,
          dateFormat,
          eventIds,
        },
        force,
        ttlMs,
        cacheNamespace: 'scores',
      });
    },
    getEvents({
      sport = ODDS_API_MMA_SPORT_KEY,
      dateFormat = ODDS_API_DEFAULT_DATE_FORMAT,
      commenceTimeFrom = null,
      commenceTimeTo = null,
      force = false,
      ttlMs = CACHE_TTLS_MS.events,
    } = {}) {
      return request({
        path: `sports/${sport}/events`,
        params: {
          dateFormat,
          commenceTimeFrom: normalizeOddsApiDateTime(commenceTimeFrom),
          commenceTimeTo: normalizeOddsApiDateTime(commenceTimeTo),
        },
        force,
        ttlMs,
        cacheNamespace: 'events',
      });
    },
    getEventOdds({
      sport = ODDS_API_MMA_SPORT_KEY,
      eventId = '',
      regions = ODDS_API_DEFAULT_REGIONS,
      markets = ODDS_API_DEFAULT_MARKETS,
      bookmakers = null,
      oddsFormat = ODDS_API_DEFAULT_ODDS_FORMAT,
      dateFormat = ODDS_API_DEFAULT_DATE_FORMAT,
      force = false,
      ttlMs = CACHE_TTLS_MS.event_odds,
    } = {}) {
      const cleanEventId = String(eventId || '').trim();
      if (!cleanEventId) {
        return Promise.resolve({ ok: false, error: 'event_id_required', data: null, meta: {} });
      }
      return request({
        path: `sports/${sport}/events/${cleanEventId}/odds`,
        params: {
          regions,
          markets,
          bookmakers,
          oddsFormat,
          dateFormat,
        },
        force,
        ttlMs,
        cacheNamespace: 'event_odds',
      });
    },
    getEventMarkets({
      sport = ODDS_API_MMA_SPORT_KEY,
      eventId = '',
      regions = ODDS_API_DEFAULT_REGIONS,
      bookmakers = null,
      force = false,
      ttlMs = CACHE_TTLS_MS.event_markets,
    } = {}) {
      const cleanEventId = String(eventId || '').trim();
      if (!cleanEventId) {
        return Promise.resolve({ ok: false, error: 'event_id_required', data: null, meta: {} });
      }
      return request({
        path: `sports/${sport}/events/${cleanEventId}/markets`,
        params: {
          regions,
          bookmakers,
        },
        force,
        ttlMs,
        cacheNamespace: 'event_markets',
      });
    },
    getParticipants({
      sport = ODDS_API_MMA_SPORT_KEY,
      force = false,
      ttlMs = CACHE_TTLS_MS.participants,
    } = {}) {
      return request({
        path: `sports/${sport}/participants`,
        params: {},
        force,
        ttlMs,
        cacheNamespace: 'participants',
      });
    },
    getHistoricalOdds({
      sport = ODDS_API_MMA_SPORT_KEY,
      date,
      regions = ODDS_API_DEFAULT_REGIONS,
      markets = ODDS_API_DEFAULT_MARKETS,
      bookmakers = null,
      oddsFormat = ODDS_API_DEFAULT_ODDS_FORMAT,
      dateFormat = ODDS_API_DEFAULT_DATE_FORMAT,
      force = false,
      ttlMs = CACHE_TTLS_MS.historical_odds,
    } = {}) {
      return request({
        path: `historical/sports/${sport}/odds`,
        params: {
          date: normalizeOddsApiDateTime(date),
          regions,
          markets,
          bookmakers,
          oddsFormat,
          dateFormat,
        },
        force,
        ttlMs,
        cacheNamespace: 'historical_odds',
      });
    },
    getHistoricalEvents({
      sport = ODDS_API_MMA_SPORT_KEY,
      date,
      dateFormat = ODDS_API_DEFAULT_DATE_FORMAT,
      force = false,
      ttlMs = CACHE_TTLS_MS.historical_events,
    } = {}) {
      return request({
        path: `historical/sports/${sport}/events`,
        params: {
          date: normalizeOddsApiDateTime(date),
          dateFormat,
        },
        force,
        ttlMs,
        cacheNamespace: 'historical_events',
      });
    },
    getHistoricalEventOdds({
      sport = ODDS_API_MMA_SPORT_KEY,
      eventId = '',
      date,
      regions = ODDS_API_DEFAULT_REGIONS,
      markets = ODDS_API_DEFAULT_MARKETS,
      bookmakers = null,
      oddsFormat = ODDS_API_DEFAULT_ODDS_FORMAT,
      dateFormat = ODDS_API_DEFAULT_DATE_FORMAT,
      force = false,
      ttlMs = CACHE_TTLS_MS.historical_event_odds,
    } = {}) {
      const cleanEventId = String(eventId || '').trim();
      if (!cleanEventId) {
        return Promise.resolve({ ok: false, error: 'event_id_required', data: null, meta: {} });
      }
      return request({
        path: `historical/sports/${sport}/events/${cleanEventId}/odds`,
        params: {
          date: normalizeOddsApiDateTime(date),
          regions,
          markets,
          bookmakers,
          oddsFormat,
          dateFormat,
        },
        force,
        ttlMs,
        cacheNamespace: 'historical_event_odds',
      });
    },
    normalizeSnapshotsFromOddsPayload,
  };
}

export {
  ODDS_API_BASE_URL,
  ODDS_API_MMA_SPORT_KEY,
  ODDS_API_DEFAULT_REGIONS,
  ODDS_API_DEFAULT_MARKETS,
  ODDS_API_DEFAULT_ODDS_FORMAT,
  ODDS_API_DEFAULT_DATE_FORMAT,
  CACHE_TTLS_MS as ODDS_API_CACHE_TTLS_MS,
  normalizeSnapshotsFromOddsPayload,
};

export default {
  createOddsApiTool,
  normalizeSnapshotsFromOddsPayload,
};
