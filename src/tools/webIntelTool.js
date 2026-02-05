import '../core/env.js';

const MAIN_CARD_FIGHTS_COUNT = Number(process.env.MAIN_CARD_FIGHTS_COUNT ?? '5');
const WEB_NEWS_DAYS = Number(process.env.WEB_NEWS_DAYS ?? '3');
const WEB_EVENT_LOOKUP_DAYS = Number(process.env.WEB_EVENT_LOOKUP_DAYS ?? '120');
const WEB_NEXT_EVENT_LOOKUP_DAYS = Number(
  process.env.WEB_NEXT_EVENT_LOOKUP_DAYS ?? '45'
);
const WEB_NEWS_MAX_ITEMS = Number(process.env.WEB_NEWS_MAX_ITEMS ?? '6');
const TARGET_DATE_TOLERANCE_DAYS = Number(
  process.env.WEB_TARGET_DATE_TOLERANCE_DAYS ?? '14'
);

const SOURCE_PRIORITY = [
  { id: 'ufc', label: 'ufc.com', siteDomain: 'ufc.com' },
  { id: 'espn', label: 'espn.com', siteDomain: 'espn.com' },
  { id: 'open_web', label: 'open-web', siteDomain: null },
];

const MONTHS_ES = {
  enero: 1,
  febrero: 2,
  marzo: 3,
  abril: 4,
  mayo: 5,
  junio: 6,
  julio: 7,
  agosto: 8,
  septiembre: 9,
  setiembre: 9,
  octubre: 10,
  noviembre: 11,
  diciembre: 12,
};

const MONTHS_EN = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const MONTH_ALIASES_EN = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

function pad2(value) {
  return String(value).padStart(2, '0');
}

export function formatDate(date) {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(
    date.getUTCDate()
  )}`;
}

function normalizeString(value = '') {
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function toDateIso(value) {
  if (!value) {
    return null;
  }

  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value;
  }

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return formatDate(date);
}

function dateDiffDays(isoA, isoB) {
  if (!isoA || !isoB) {
    return Number.POSITIVE_INFINITY;
  }
  const msA = Date.parse(`${isoA}T00:00:00Z`);
  const msB = Date.parse(`${isoB}T00:00:00Z`);
  if (Number.isNaN(msA) || Number.isNaN(msB)) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.round((msA - msB) / 86400000);
}

function inferYear(month, day, referenceDate, explicitYear) {
  if (explicitYear) {
    return explicitYear;
  }

  const year = referenceDate.getUTCFullYear();
  const candidate = Date.UTC(year, month - 1, day);
  if (candidate < referenceDate.getTime() - 24 * 60 * 60 * 1000) {
    return year + 1;
  }
  return year;
}

export function parseDateFromMessage(message = '', { referenceDate = new Date() } = {}) {
  const text = normalizeString(message);

  const isoMatch = text.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/);
  if (isoMatch) {
    const year = Number(isoMatch[1]);
    const month = Number(isoMatch[2]);
    const day = Number(isoMatch[3]);
    return new Date(Date.UTC(year, month - 1, day));
  }

  const slashMatch = text.match(/\b(\d{1,2})[\/-](\d{1,2})(?:[\/-](20\d{2}))?\b/);
  if (slashMatch) {
    const day = Number(slashMatch[1]);
    const month = Number(slashMatch[2]);
    const year = inferYear(month, day, referenceDate, Number(slashMatch[3] || 0));
    return new Date(Date.UTC(year, month - 1, day));
  }

  const esMatch = text.match(
    /\b(\d{1,2})\s+de\s+([a-zñ]+)(?:\s+de\s+(20\d{2}))?\b/
  );
  if (esMatch) {
    const day = Number(esMatch[1]);
    const monthName = normalizeString(esMatch[2]);
    const month = MONTHS_ES[monthName];
    if (month) {
      const year = inferYear(month, day, referenceDate, Number(esMatch[3] || 0));
      return new Date(Date.UTC(year, month - 1, day));
    }
  }

  return null;
}

export function isMainCardLookupRequest(message = '') {
  const text = normalizeString(message);
  return (
    /\b(main card|cartelera principal|cartelera|evento|ufc|quien pelea|quienes pelean)\b/.test(
      text
    ) &&
    /\b(\d{1,2}[\/-]\d{1,2}|20\d{2}-\d{1,2}-\d{1,2}|\d{1,2}\s+de\s+[a-zñ]+)\b/.test(
      text
    )
  );
}

export function isUpcomingEventLookupRequest(message = '') {
  const text = normalizeString(message);
  return (
    /\b(ufc|evento|cartelera|main card|main event|quien pelea|quienes pelean)\b/.test(text) &&
    /\b(proximo|proxima|que viene|next|upcoming|siguiente)\b/.test(text)
  );
}

export function isCalendarLookupRequest(message = '') {
  return isMainCardLookupRequest(message) || isUpcomingEventLookupRequest(message);
}

function stripHtmlTags(value = '') {
  return value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function getSourceFromLink(link = '') {
  try {
    const url = new URL(link);
    return url.hostname.replace(/^www\./, '');
  } catch {
    return 'unknown';
  }
}

function parseRssItems(xml = '') {
  const itemBlocks = xml.match(/<item>([\s\S]*?)<\/item>/gi) || [];
  const items = [];

  for (const block of itemBlocks) {
    const title = stripHtmlTags(block.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || '');
    const link = stripHtmlTags(block.match(/<link>([\s\S]*?)<\/link>/i)?.[1] || '');
    const pubDateRaw = stripHtmlTags(
      block.match(/<pubDate>([\s\S]*?)<\/pubDate>/i)?.[1] || ''
    );
    const pubDate = pubDateRaw ? new Date(pubDateRaw) : null;

    if (!title || !link) continue;

    items.push({
      title,
      link,
      source: getSourceFromLink(link),
      publishedAt:
        pubDate && !Number.isNaN(pubDate.getTime())
          ? pubDate.toISOString()
          : null,
    });
  }

  return items;
}

function dedupeHeadlines(items = []) {
  const seen = new Set();
  const deduped = [];

  for (const item of items) {
    const key = `${item.title}::${item.link}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }

  deduped.sort((a, b) => (b.publishedAt || '').localeCompare(a.publishedAt || ''));
  return deduped;
}

async function fetchText(url, fetchImpl = fetch) {
  const response = await fetchImpl(url, {
    headers: {
      'User-Agent': 'ufc-orchestrator-bot/1.0',
      Accept: 'application/rss+xml,application/xml,text/xml;q=0.9,*/*;q=0.8',
    },
  });

  if (!response.ok) {
    throw new Error(`Request failed (${response.status}) for ${url}`);
  }

  return response.text();
}

async function fetchGoogleNewsRss({ query, days, fetchImpl = fetch }) {
  const url =
    'https://news.google.com/rss/search?q=' +
    encodeURIComponent(`${query} when:${days}d`) +
    '&hl=en-US&gl=US&ceid=US:en';

  const xml = await fetchText(url, fetchImpl);
  return parseRssItems(xml);
}

function extractEventNameFromTitle(title = '') {
  const eventMatch = title.match(
    /(UFC\s\d{2,3}|UFC Fight Night[^:|\-–]*|UFC on [A-Za-z0-9\s]+)/i
  );
  return eventMatch ? eventMatch[0].trim() : null;
}

function normalizeFighterName(name = '') {
  return name
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\b([a-z])/g, (m) => m.toUpperCase());
}

function extractFightPairsFromTitle(title = '') {
  const regex =
    /([A-Z][a-z]+(?:\s[A-Z][a-z]+){0,2})\s(?:vs\.?|v\.?)\s([A-Z][a-z]+(?:\s[A-Z][a-z]+){0,2})/g;
  const fights = [];
  let match = regex.exec(title);
  while (match) {
    fights.push({
      fighterA: normalizeFighterName(match[1]),
      fighterB: normalizeFighterName(match[2]),
    });
    match = regex.exec(title);
  }
  return fights;
}

function dedupeFights(fights = []) {
  const seen = new Set();
  const out = [];

  for (const fight of fights) {
    const fighterA = normalizeString(fight.fighterA);
    const fighterB = normalizeString(fight.fighterB);
    const key = `${fighterA}::${fighterB}`;
    const rev = `${fighterB}::${fighterA}`;

    const aLast = fighterA.split(/\s+/).filter(Boolean).slice(-1)[0] || fighterA;
    const bLast = fighterB.split(/\s+/).filter(Boolean).slice(-1)[0] || fighterB;
    const surnameKey = `${aLast}::${bLast}`;
    const surnameRev = `${bLast}::${aLast}`;

    if (
      seen.has(key) ||
      seen.has(rev) ||
      seen.has(surnameKey) ||
      seen.has(surnameRev)
    ) {
      continue;
    }

    seen.add(key);
    seen.add(surnameKey);
    out.push(fight);
  }

  return out;
}

async function fetchFightCandidatesFromQueries({
  queries = [],
  source = null,
  days,
  fetchImpl,
}) {
  if (!queries.length) {
    return [];
  }

  const headlines = await fetchHeadlinesForQueries({
    queries,
    source,
    days,
    fetchImpl,
  });
  return dedupeFights(
    headlines.flatMap((item) => extractFightPairsFromTitle(item.title))
  );
}

function buildNewsSummary(headlines = []) {
  if (!headlines.length) {
    return 'No encontré titulares relevantes de última hora.';
  }

  return headlines
    .map((item) => {
      const ts = item.publishedAt ? item.publishedAt.slice(0, 10) : 'unknown-date';
      return `- [${ts}] ${item.title} (${item.source}) ${item.link}`;
    })
    .join('\n');
}

function buildEventLookupQueries(targetDate) {
  const year = targetDate.getUTCFullYear();
  const month = targetDate.getUTCMonth();
  const day = targetDate.getUTCDate();
  const monthName = MONTHS_EN[month];
  const iso = formatDate(targetDate);

  return [
    `UFC ${monthName} ${day} ${year} main card`,
    `UFC ${monthName} ${day} ${year} who fights`,
    `UFC ${iso} main card`,
    `UFC ${iso} who fights`,
    `UFC Fight Night ${monthName} ${day} ${year}`,
  ];
}

function buildUpcomingEventQueries(referenceDate) {
  const year = referenceDate.getUTCFullYear();
  const month = MONTHS_EN[referenceDate.getUTCMonth()];
  return [
    'next UFC event main card',
    'upcoming UFC event main card',
    'UFC next event who fights',
    `UFC ${year} next event`,
    `UFC ${month} ${year} upcoming card`,
  ];
}

function buildGenericEventQueries(query = '', referenceDate = new Date()) {
  const cleaned = String(query || '').trim();
  const queries = [];

  if (cleaned) {
    queries.push(`${cleaned} UFC main card`);
    queries.push(`${cleaned} UFC fight card`);
    queries.push(`${cleaned} UFC who fights`);
  }

  return [...queries, ...buildUpcomingEventQueries(referenceDate)];
}

function applySourceScope(query = '', source = {}) {
  if (!source?.siteDomain) {
    return query;
  }
  return `${query} site:${source.siteDomain}`;
}

async function fetchHeadlinesForQueries({
  queries = [],
  source,
  days,
  fetchImpl,
}) {
  if (!queries.length) {
    return [];
  }

  const scopedQueries = queries.map((query) => applySourceScope(query, source));
  const batches = await Promise.all(
    scopedQueries.map((query) =>
      fetchGoogleNewsRss({
        query,
        days,
        fetchImpl,
      }).catch(() => [])
    )
  );

  return dedupeHeadlines(batches.flat());
}

function collectEventCandidates(headlines = [], referenceDate = new Date()) {
  const map = new Map();

  for (const item of headlines) {
    const eventName = extractEventNameFromTitle(item.title);
    if (!eventName) {
      continue;
    }

    const key = normalizeString(eventName);
    if (!map.has(key)) {
      map.set(key, {
        key,
        eventName,
        count: 0,
        dates: [],
        headlines: [],
      });
    }

    const candidate = map.get(key);
    candidate.count += 1;
    candidate.headlines.push(item);

    const date = parseEventDateFromText(item.title, referenceDate);
    if (date) {
      candidate.dates.push(date);
    }
  }

  return Array.from(map.values());
}

function sortIsoAsc(values = []) {
  return values.slice().sort((a, b) => a.localeCompare(b));
}

function pickEventForDate(candidates = [], targetDateIso) {
  if (!candidates.length) {
    return null;
  }

  const withDates = candidates
    .map((candidate) => {
      const sorted = sortIsoAsc(candidate.dates);
      if (!sorted.length) {
        return null;
      }

      let best = sorted[0];
      let bestDiff = Math.abs(dateDiffDays(best, targetDateIso));
      for (const date of sorted.slice(1)) {
        const diff = Math.abs(dateDiffDays(date, targetDateIso));
        if (diff < bestDiff) {
          best = date;
          bestDiff = diff;
        }
      }

      return {
        ...candidate,
        selectedDate: best,
        selectedDiffDays: bestDiff,
      };
    })
    .filter(Boolean)
    .sort((a, b) => {
      if (a.selectedDiffDays !== b.selectedDiffDays) {
        return a.selectedDiffDays - b.selectedDiffDays;
      }
      if (a.count !== b.count) {
        return b.count - a.count;
      }
      return a.eventName.localeCompare(b.eventName);
    });

  if (withDates.length) {
    return withDates[0];
  }

  return null;
}

function pickUpcomingEvent(candidates = [], referenceDateIso) {
  if (!candidates.length) {
    return null;
  }

  const future = candidates
    .flatMap((candidate) =>
      candidate.dates
        .filter((date) => date >= referenceDateIso)
        .map((date) => ({
          ...candidate,
          selectedDate: date,
          selectedDiffDays: Math.abs(dateDiffDays(date, referenceDateIso)),
        }))
    )
    .sort((a, b) => {
      if (a.selectedDate !== b.selectedDate) {
        return a.selectedDate.localeCompare(b.selectedDate);
      }
      if (a.count !== b.count) {
        return b.count - a.count;
      }
      return a.eventName.localeCompare(b.eventName);
    });

  if (future.length) {
    return future[0];
  }

  return candidates
    .slice()
    .sort((a, b) => {
      if (a.count !== b.count) {
        return b.count - a.count;
      }
      return a.eventName.localeCompare(b.eventName);
    })[0];
}

function pickEventCandidate({
  candidates = [],
  targetDateIso = null,
  referenceDateIso,
}) {
  if (targetDateIso) {
    return pickEventForDate(candidates, targetDateIso);
  }
  return pickUpcomingEvent(candidates, referenceDateIso);
}

function isCandidateAcceptable({
  candidate,
  targetDateIso = null,
  referenceDateIso,
}) {
  if (!candidate) {
    return false;
  }

  if (targetDateIso) {
    if (!candidate.selectedDate) {
      return false;
    }
    return Math.abs(dateDiffDays(candidate.selectedDate, targetDateIso)) <= TARGET_DATE_TOLERANCE_DAYS;
  }

  if (!targetDateIso && candidate.selectedDate) {
    return candidate.selectedDate >= referenceDateIso;
  }

  return true;
}

function parseEventDateFromText(text = '', referenceDate = new Date()) {
  const normalized = String(text || '').replace(/\./g, '');
  const monthPattern =
    /\b([A-Za-z]{3,9})\s+(\d{1,2})(?:,?\s*(20\d{2}))?\b/i;
  const monthMatch = normalized.match(monthPattern);
  if (monthMatch) {
    const monthRaw = normalizeString(monthMatch[1]);
    const month = MONTH_ALIASES_EN[monthRaw];
    if (month) {
      const day = Number(monthMatch[2]);
      const explicitYear = Number(monthMatch[3] || 0);
      const year = explicitYear || inferYear(month, day, referenceDate, 0);
      return formatDate(new Date(Date.UTC(year, month - 1, day)));
    }
  }

  const slashMatch = text.match(/\b(\d{1,2})[\/-](\d{1,2})(?:[\/-](20\d{2}))?\b/);
  if (slashMatch) {
    const day = Number(slashMatch[1]);
    const month = Number(slashMatch[2]);
    const year = inferYear(
      month,
      day,
      referenceDate,
      Number(slashMatch[3] || 0)
    );
    return formatDate(new Date(Date.UTC(year, month - 1, day)));
  }

  return null;
}

function mostFrequent(values = []) {
  const counts = new Map();
  for (const value of values) {
    if (!value) continue;
    counts.set(value, (counts.get(value) || 0) + 1);
  }

  let winner = null;
  let winnerCount = -1;
  for (const [value, count] of counts.entries()) {
    if (count > winnerCount) {
      winner = value;
      winnerCount = count;
    }
  }

  return winner;
}

function findSourceById(sourceId = '') {
  return SOURCE_PRIORITY.find((source) => source.id === sourceId) || null;
}

function buildEventCardFromHeadlines(headlines = []) {
  return dedupeFights(
    headlines.flatMap((item) => extractFightPairsFromTitle(item.title))
  );
}

function pickSourceResult({
  source,
  headlines,
  targetDateIso = null,
  referenceDateIso,
  referenceDate,
}) {
  if (!headlines.length) {
    return null;
  }

  const candidates = collectEventCandidates(headlines, referenceDate);
  const selected = pickEventCandidate({
    candidates,
    targetDateIso,
    referenceDateIso,
  });

  if (!isCandidateAcceptable({ candidate: selected, targetDateIso, referenceDateIso })) {
    return null;
  }

  const selectedHeadlines =
    selected?.headlines?.length ? selected.headlines : headlines;

  const eventName =
    selected?.eventName ||
    mostFrequent(headlines.map((item) => extractEventNameFromTitle(item.title)));
  const eventDate =
    selected?.selectedDate ||
    mostFrequent(
      headlines.map((item) => parseEventDateFromText(item.title, referenceDate))
    ) ||
    targetDateIso;

  return {
    source,
    headlines,
    selectedHeadlines,
    eventName,
    eventDate,
  };
}

export async function buildWebContextForMessage(
  message = '',
  { fetchImpl = fetch, referenceDate = new Date(), force = false } = {}
) {
  const isDateLookup = isMainCardLookupRequest(message);
  const isUpcomingLookup = isUpcomingEventLookupRequest(message);

  if (!force && !isDateLookup && !isUpcomingLookup) {
    return null;
  }

  const targetDate = isDateLookup
    ? parseDateFromMessage(message, { referenceDate })
    : null;
  const targetDateIso = toDateIso(targetDate);
  const referenceDateIso = formatDate(referenceDate);
  const queries = targetDate
    ? buildEventLookupQueries(targetDate)
    : isUpcomingLookup
      ? buildUpcomingEventQueries(referenceDate)
      : buildGenericEventQueries(message, referenceDate);
  const lookupDays = targetDate ? WEB_EVENT_LOOKUP_DAYS : WEB_NEXT_EVENT_LOOKUP_DAYS;

  let selectedResult = null;
  for (const source of SOURCE_PRIORITY) {
    const headlines = await fetchHeadlinesForQueries({
      queries,
      source,
      days: lookupDays,
      fetchImpl,
    });
    if (!headlines.length) {
      continue;
    }

    const sourceResult = pickSourceResult({
      source,
      headlines,
      targetDateIso,
      referenceDateIso,
      referenceDate,
    });
    if (!sourceResult) {
      continue;
    }

    selectedResult = sourceResult;
    break;
  }

  if (!selectedResult) {
    return null;
  }

  const {
    source,
    headlines: lookupHeadlines,
    selectedHeadlines,
    eventName,
    eventDate,
  } = selectedResult;

  let fightCandidates = buildEventCardFromHeadlines(selectedHeadlines);

  if (fightCandidates.length < MAIN_CARD_FIGHTS_COUNT) {
    const supplementalQueries = [
      `${eventName || `UFC ${eventDate || targetDateIso || referenceDateIso}`} main card fights`,
      `${eventName || `UFC ${eventDate || targetDateIso || referenceDateIso}`} full fight card`,
      `${eventName || `UFC ${eventDate || targetDateIso || referenceDateIso}`} matchup breakdown`,
    ];

    const supplementalCandidates = await fetchFightCandidatesFromQueries({
      queries: supplementalQueries,
      source: findSourceById(source.id) || source,
      days: lookupDays,
      fetchImpl,
    });
    fightCandidates = dedupeFights([...fightCandidates, ...supplementalCandidates]);
  }

  fightCandidates = fightCandidates.slice(0, MAIN_CARD_FIGHTS_COUNT);

  const recentNewsQuery = eventName || (eventDate ? `UFC ${eventDate}` : 'UFC next event');
  const recentHeadlines = dedupeHeadlines(
    await fetchGoogleNewsRss({
      query: `${recentNewsQuery} injuries replacement weigh-in`,
      days: WEB_NEWS_DAYS,
      fetchImpl,
    }).catch(() => [])
  ).slice(0, WEB_NEWS_MAX_ITEMS);

  const fightsText = fightCandidates.length
    ? fightCandidates
        .map((fight, index) => `${index + 1}. ${fight.fighterA} vs ${fight.fighterB}`)
        .join('\n')
    : 'No pude inferir cruces exactos desde titulares; usar supuestos y aclararlo.';

  const contextText = [
    targetDate
      ? `Fecha solicitada: ${targetDateIso}`
      : `Solicitud: próximo evento UFC desde ${formatDate(referenceDate)}`,
    `Fecha estimada del evento: ${eventDate || 'No identificada con certeza'}`,
    `Evento estimado (fuentes web): ${eventName || 'No identificado con certeza'}`,
    `Fuente prioritaria usada: ${source.label}`,
    'Main card estimada desde fuentes web:',
    fightsText,
    'Titulares recientes para validar cambios de último momento:',
    buildNewsSummary(recentHeadlines),
  ].join('\n');

  return {
    date: eventDate,
    eventName,
    fights: fightCandidates,
    headlines: recentHeadlines,
    source: source.label,
    confidence: fightCandidates.length >= MAIN_CARD_FIGHTS_COUNT ? 'medium' : 'low',
    contextText,
  };
}

export default {
  parseDateFromMessage,
  isMainCardLookupRequest,
  isUpcomingEventLookupRequest,
  isCalendarLookupRequest,
  buildWebContextForMessage,
};
