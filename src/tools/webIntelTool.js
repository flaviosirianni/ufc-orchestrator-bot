import '../core/env.js';

const UPCOMING_EVENTS_URL = 'http://ufcstats.com/statistics/events/upcoming';
const MAIN_CARD_FIGHTS_COUNT = Number(process.env.MAIN_CARD_FIGHTS_COUNT ?? '5');
const WEB_NEWS_DAYS = Number(process.env.WEB_NEWS_DAYS ?? '3');
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
    /\b(main card|cartelera principal|evento|ufc)\b/.test(text) &&
    /\b(\d{1,2}[\/-]\d{1,2}|20\d{2}-\d{1,2}-\d{1,2}|\d{1,2}\s+de\s+[a-zñ]+)\b/.test(
      text
    )
  );
}

function stripHtmlTags(value = '') {
  return value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

export function parseUpcomingEventsHtml(html = '') {
  const rows = html.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  const events = [];

  for (const row of rows) {
    const urlMatch = row.match(/href="(http:\/\/ufcstats\.com\/event-details\/[^"]+)"/i);
    if (!urlMatch) continue;

    const link = urlMatch[1];
    const anchors = Array.from(
      row.matchAll(
        /<a[^>]*href="http:\/\/ufcstats\.com\/event-details\/[^"]+"[^>]*>([\s\S]*?)<\/a>/gi
      )
    );
    const name = stripHtmlTags(anchors[0]?.[1] || '');

    const dateMatch = row.match(
      /([A-Za-z]+)\s+(\d{1,2}),\s*(20\d{2})/
    );
    const dateRaw = dateMatch
      ? `${dateMatch[1]} ${dateMatch[2]}, ${dateMatch[3]}`
      : '';
    const parsedDate = dateRaw ? new Date(`${dateRaw} UTC`) : null;

    if (!name || !parsedDate || Number.isNaN(parsedDate.getTime())) {
      continue;
    }

    events.push({
      name,
      link,
      date: formatDate(parsedDate),
    });
  }

  return events;
}

export function parseEventFightsHtml(html = '') {
  const fighterAnchors = Array.from(
    html.matchAll(
      /<a[^>]*href="http:\/\/ufcstats\.com\/fighter-details\/[^"]+"[^>]*>([\s\S]*?)<\/a>/gi
    )
  )
    .map((match) => stripHtmlTags(match[1]))
    .filter(Boolean);

  const fights = [];
  for (let index = 0; index + 1 < fighterAnchors.length; index += 2) {
    fights.push({
      fighterA: fighterAnchors[index],
      fighterB: fighterAnchors[index + 1],
    });
  }

  return fights;
}

function pickMainCardFights(fights = [], count = MAIN_CARD_FIGHTS_COUNT) {
  return fights.slice(0, count);
}

async function fetchText(url, fetchImpl = fetch) {
  const response = await fetchImpl(url, {
    headers: {
      'User-Agent': 'ufc-orchestrator-bot/1.0',
      Accept: 'text/html,application/xml,text/xml;q=0.9,*/*;q=0.8',
    },
  });

  if (!response.ok) {
    throw new Error(`Request failed (${response.status}) for ${url}`);
  }

  return response.text();
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

async function fetchRecentNews({
  query,
  days = WEB_NEWS_DAYS,
  maxItems = WEB_NEWS_MAX_ITEMS,
  fetchImpl = fetch,
}) {
  const url =
    'https://news.google.com/rss/search?q=' +
    encodeURIComponent(`${query} when:${days}d`) +
    '&hl=en-US&gl=US&ceid=US:en';

  const xml = await fetchText(url, fetchImpl);
  return parseRssItems(xml).slice(0, maxItems);
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

  const normalizedDate = formatDate(targetDate);
  const upcomingHtml = await fetchText(UPCOMING_EVENTS_URL, fetchImpl);
  const events = parseUpcomingEventsHtml(upcomingHtml);
  const event = events.find((item) => item.date === normalizedDate);

  if (!event) {
    return {
      date: normalizedDate,
      eventName: null,
      fights: [],
      headlines: [],
      contextText: `No encontré un evento UFC para ${normalizedDate} en UFC Stats.`,
    };
  }

  const eventHtml = await fetchText(event.link, fetchImpl);
  const fights = pickMainCardFights(parseEventFightsHtml(eventHtml));

  const headlineQueries = [event.name];
  for (const fight of fights.slice(0, 2)) {
    headlineQueries.push(`${fight.fighterA} ${fight.fighterB} UFC`);
  }

  const newsBatches = await Promise.all(
    headlineQueries.map((query) =>
      fetchRecentNews({ query, fetchImpl }).catch(() => [])
    )
  );
  const headlines = dedupeHeadlines(newsBatches.flat()).slice(0, WEB_NEWS_MAX_ITEMS);

  const fightsText = fights.length
    ? fights.map((fight, index) => `${index + 1}. ${fight.fighterA} vs ${fight.fighterB}`).join('\n')
    : 'No pude extraer peleas del evento.';

  const contextText = [
    `Evento detectado: ${event.name}`,
    `Fecha: ${normalizedDate}`,
    'Main card estimada:',
    fightsText,
    'Noticias recientes para validar cambios de último momento:',
    buildNewsSummary(headlines),
  ].join('\n');

  return {
    date: normalizedDate,
    eventName: event.name,
    fights,
    headlines,
    contextText,
  };
}

export default {
  parseDateFromMessage,
  parseUpcomingEventsHtml,
  parseEventFightsHtml,
  buildWebContextForMessage,
  isMainCardLookupRequest,
};
