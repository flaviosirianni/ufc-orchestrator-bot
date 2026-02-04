import '../core/env.js';

const MAIN_CARD_FIGHTS_COUNT = Number(process.env.MAIN_CARD_FIGHTS_COUNT ?? '5');
const WEB_NEWS_DAYS = Number(process.env.WEB_NEWS_DAYS ?? '3');
const WEB_EVENT_LOOKUP_DAYS = Number(process.env.WEB_EVENT_LOOKUP_DAYS ?? '120');
const WEB_NEWS_MAX_ITEMS = Number(process.env.WEB_NEWS_MAX_ITEMS ?? '6');

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
    const key = `${fight.fighterA.toLowerCase()}::${fight.fighterB.toLowerCase()}`;
    const rev = `${fight.fighterB.toLowerCase()}::${fight.fighterA.toLowerCase()}`;
    if (seen.has(key) || seen.has(rev)) continue;
    seen.add(key);
    out.push(fight);
  }

  return out;
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

export async function buildWebContextForMessage(
  message = '',
  { fetchImpl = fetch, referenceDate = new Date() } = {}
) {
  if (!isMainCardLookupRequest(message)) {
    return null;
  }

  const targetDate = parseDateFromMessage(message, { referenceDate });
  if (!targetDate) {
    return null;
  }

  const date = formatDate(targetDate);
  const queries = buildEventLookupQueries(targetDate);

  const lookupBatches = await Promise.all(
    queries.map((query) =>
      fetchGoogleNewsRss({
        query,
        days: WEB_EVENT_LOOKUP_DAYS,
        fetchImpl,
      }).catch(() => [])
    )
  );

  const lookupHeadlines = dedupeHeadlines(lookupBatches.flat());
  const eventName = mostFrequent(
    lookupHeadlines.map((item) => extractEventNameFromTitle(item.title))
  );

  const fightCandidates = dedupeFights(
    lookupHeadlines.flatMap((item) => extractFightPairsFromTitle(item.title))
  ).slice(0, MAIN_CARD_FIGHTS_COUNT);

  const recentNewsQuery = eventName || `UFC ${date}`;
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
    `Fecha solicitada: ${date}`,
    `Evento estimado (fuentes web): ${eventName || 'No identificado con certeza'}`,
    'Main card estimada desde fuentes web:',
    fightsText,
    'Titulares recientes para validar cambios de último momento:',
    buildNewsSummary(recentHeadlines),
  ].join('\n');

  return {
    date,
    eventName,
    fights: fightCandidates,
    headlines: recentHeadlines,
    contextText,
  };
}

export default {
  parseDateFromMessage,
  isMainCardLookupRequest,
  buildWebContextForMessage,
};
