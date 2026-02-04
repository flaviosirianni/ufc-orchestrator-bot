import assert from 'node:assert/strict';
import {
  parseDateFromMessage,
  isMainCardLookupRequest,
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
    assert.equal(isMainCardLookupRequest('quiero una estrategia conservadora'), false);
  });

  tests.push(async () => {
    const lookupRss = wrapRss([
      buildNewsItem({
        title: 'UFC 312 main card: Alex Pereira vs Magomed Ankalaev preview',
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
