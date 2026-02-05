import assert from 'node:assert/strict';
import {
  parseDateFromMessage,
  isMainCardLookupRequest,
  isUpcomingEventLookupRequest,
  isCalendarLookupRequest,
  buildWebContextForMessage,
} from '../src/tools/webIntelTool.js';

function fakeResponse(text) {
  return {
    ok: true,
    async text() {
      return text;
    },
  };
}

function buildNewsItem({ title, link, pubDate }) {
  return `
    <item>
      <title>${title}</title>
      <link>${link}</link>
      <pubDate>${pubDate}</pubDate>
    </item>
  `;
}

function wrapRss(items) {
  return `<rss><channel>${items.join('')}</channel></rss>`;
}

export async function runWebIntelToolTests() {
  const tests = [];

  tests.push(async () => {
    const date = parseDateFromMessage('main card del 7 de febrero', {
      referenceDate: new Date(Date.UTC(2026, 1, 4)),
    });
    assert.equal(date.toISOString().slice(0, 10), '2026-02-07');
  });

  tests.push(async () => {
    assert.equal(
      isMainCardLookupRequest('podes analizar el main card del 7 de febrero?'),
      true
    );
    assert.equal(
      isMainCardLookupRequest('hola, quiero saber quien pelea el 7 de febrero'),
      true
    );
    assert.equal(
      isUpcomingEventLookupRequest('me decis quien pelea en el evento que viene de la ufc?'),
      true
    );
    assert.equal(
      isCalendarLookupRequest('me decis quien pelea en el evento que viene de la ufc?'),
      true
    );
    assert.equal(isMainCardLookupRequest('quiero una estrategia conservadora'), false);
  });

  tests.push(async () => {
    const lookupRss = wrapRss([
      buildNewsItem({
        title: 'UFC 312 main card for February 7, 2026: Alex Pereira vs Magomed Ankalaev preview',
        link: 'https://example.com/a',
        pubDate: 'Wed, 04 Feb 2026 10:00:00 GMT',
      }),
      buildNewsItem({
        title: 'UFC 312: Islam Makhachev vs Arman Tsarukyan prediction',
        link: 'https://example.com/b',
        pubDate: 'Wed, 04 Feb 2026 09:00:00 GMT',
      }),
      buildNewsItem({
        title: 'UFC 312 features Max Holloway vs Ilia Topuria in co-main',
        link: 'https://example.com/c',
        pubDate: 'Tue, 03 Feb 2026 08:00:00 GMT',
      }),
    ]);
    const recentRss = wrapRss([
      buildNewsItem({
        title: 'Late replacement rumor ahead of UFC 312 weigh-ins',
        link: 'https://example.com/news-1',
        pubDate: 'Thu, 05 Feb 2026 12:00:00 GMT',
      }),
    ]);

    const mockFetch = async (url) => {
      if (!url.includes('news.google.com')) {
        throw new Error(`unexpected url ${url}`);
      }

      if (url.includes('injuries') || url.includes('replacement') || url.includes('weigh-in')) {
        return fakeResponse(recentRss);
      }

      return fakeResponse(lookupRss);
    };

    const result = await buildWebContextForMessage(
      'analiza el main card del 7 de febrero',
      {
        fetchImpl: mockFetch,
        referenceDate: new Date(Date.UTC(2026, 1, 4)),
      }
    );

    assert.equal(result.eventName, 'UFC 312');
    assert.equal(result.fights.length, 3);
    assert.match(result.contextText, /Main card estimada desde fuentes web/);
    assert.match(result.contextText, /Titulares recientes/);
  });

  tests.push(async () => {
    const lookupRss = wrapRss([
      buildNewsItem({
        title: 'Next UFC event: UFC 312 set for February 7, 2026',
        link: 'https://example.com/event',
        pubDate: 'Wed, 04 Feb 2026 10:00:00 GMT',
      }),
      buildNewsItem({
        title: 'UFC 312 main card: Mario Bautista vs Vinicius Oliveira',
        link: 'https://example.com/f1',
        pubDate: 'Wed, 04 Feb 2026 09:00:00 GMT',
      }),
      buildNewsItem({
        title: 'UFC 312 co-main: Umar Nurmagomedov vs Mike Davis',
        link: 'https://example.com/f2',
        pubDate: 'Wed, 04 Feb 2026 08:00:00 GMT',
      }),
    ]);
    const recentRss = wrapRss([
      buildNewsItem({
        title: 'No injuries reported before UFC 312',
        link: 'https://example.com/news-2',
        pubDate: 'Thu, 05 Feb 2026 12:00:00 GMT',
      }),
    ]);

    const mockFetch = async (url) => {
      if (!url.includes('news.google.com')) {
        throw new Error(`unexpected url ${url}`);
      }
      if (url.includes('injuries') || url.includes('replacement') || url.includes('weigh-in')) {
        return fakeResponse(recentRss);
      }
      return fakeResponse(lookupRss);
    };

    const result = await buildWebContextForMessage(
      'me decis quien pelea en el evento que viene de la ufc?',
      {
        fetchImpl: mockFetch,
        referenceDate: new Date(Date.UTC(2026, 1, 4)),
      }
    );

    assert.equal(result.eventName, 'UFC 312');
    assert.equal(result.date, '2026-02-07');
    assert.match(result.contextText, /Solicitud: próximo evento UFC/);
  });

  tests.push(async () => {
    const ufcRss = wrapRss([
      buildNewsItem({
        title: 'UFC 312 scheduled for February 7, 2026',
        link: 'https://www.ufc.com/news/ufc-312-date',
        pubDate: 'Wed, 04 Feb 2026 10:00:00 GMT',
      }),
      buildNewsItem({
        title: 'UFC 312 main card: Mario Bautista vs Vinicius Oliveira',
        link: 'https://www.ufc.com/news/ufc-312-main',
        pubDate: 'Wed, 04 Feb 2026 09:00:00 GMT',
      }),
      buildNewsItem({
        title: 'UFC 312 feature: Bautista vs Oliveira preview',
        link: 'https://www.ufc.com/news/ufc-312-preview',
        pubDate: 'Wed, 04 Feb 2026 08:00:00 GMT',
      }),
    ]);
    const espnRss = wrapRss([
      buildNewsItem({
        title: 'UFC 324 set for February 21, 2026',
        link: 'https://www.espn.com/mma/story/_/id/1',
        pubDate: 'Wed, 04 Feb 2026 10:00:00 GMT',
      }),
      buildNewsItem({
        title: 'UFC 324 main card: Strickland vs Hernandez',
        link: 'https://www.espn.com/mma/story/_/id/2',
        pubDate: 'Wed, 04 Feb 2026 09:00:00 GMT',
      }),
    ]);
    const recentRss = wrapRss([]);

    const mockFetch = async (url) => {
      if (url.includes('site%3Aufc.com')) {
        return fakeResponse(ufcRss);
      }
      if (url.includes('site%3Aespn.com')) {
        return fakeResponse(espnRss);
      }
      if (url.includes('injuries') || url.includes('replacement') || url.includes('weigh-in')) {
        return fakeResponse(recentRss);
      }
      return fakeResponse(wrapRss([]));
    };

    const result = await buildWebContextForMessage(
      'quien pelea en el evento que viene de la ufc?',
      {
        fetchImpl: mockFetch,
        referenceDate: new Date(Date.UTC(2026, 1, 4)),
      }
    );

    assert.equal(result.eventName, 'UFC 312');
    assert.equal(result.date, '2026-02-07');
    assert.equal(result.source, 'ufc.com');
    assert.equal(result.fights.length, 1);
    assert.equal(result.fights[0].fighterA, 'Mario Bautista');
    assert.equal(result.fights[0].fighterB, 'Vinicius Oliveira');
  });

  tests.push(async () => {
    const noDateRss = wrapRss([
      buildNewsItem({
        title: 'UFC 325 main card announced',
        link: 'https://www.ufc.com/news/ufc-325-main',
        pubDate: 'Wed, 04 Feb 2026 10:00:00 GMT',
      }),
      buildNewsItem({
        title: 'UFC 325: Volkanovski vs Lopes preview',
        link: 'https://www.ufc.com/news/ufc-325-preview',
        pubDate: 'Wed, 04 Feb 2026 09:00:00 GMT',
      }),
    ]);

    const mockFetch = async () => fakeResponse(noDateRss);

    const result = await buildWebContextForMessage(
      'quien pelea el 7 de febrero',
      {
        fetchImpl: mockFetch,
        referenceDate: new Date(Date.UTC(2026, 1, 4)),
      }
    );

    assert.equal(result, null);
  });

  for (const test of tests) {
    await test();
  }

  console.log('All webIntelTool tests passed.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runWebIntelToolTests().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
