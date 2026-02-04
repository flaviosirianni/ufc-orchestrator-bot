import assert from 'node:assert/strict';
import {
  parseDateFromMessage,
  isMainCardLookupRequest,
  parseUpcomingEventsHtml,
  parseEventFightsHtml,
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
    assert.equal(isMainCardLookupRequest('quiero una estrategia conservadora'), false);
  });

  tests.push(async () => {
    const html = `
      <table><tbody>
      <tr>
        <td><a href="http://ufcstats.com/event-details/abc123">UFC Test Event</a></td>
        <td>February 07, 2026</td>
      </tr>
      </tbody></table>
    `;
    const events = parseUpcomingEventsHtml(html);
    assert.equal(events.length, 1);
    assert.equal(events[0].name, 'UFC Test Event');
    assert.equal(events[0].date, '2026-02-07');
  });

  tests.push(async () => {
    const html = `
      <a href="http://ufcstats.com/fighter-details/a">Alex Pereira</a>
      <a href="http://ufcstats.com/fighter-details/b">Magomed Ankalaev</a>
      <a href="http://ufcstats.com/fighter-details/c">Islam Makhachev</a>
      <a href="http://ufcstats.com/fighter-details/d">Arman Tsarukyan</a>
    `;
    const fights = parseEventFightsHtml(html);
    assert.equal(fights.length, 2);
    assert.equal(fights[0].fighterA, 'Alex Pereira');
    assert.equal(fights[0].fighterB, 'Magomed Ankalaev');
  });

  tests.push(async () => {
    const upcomingHtml = `
      <table><tbody>
      <tr>
        <td><a href="http://ufcstats.com/event-details/abc123">UFC Test Event</a></td>
        <td>February 07, 2026</td>
      </tr>
      </tbody></table>
    `;
    const eventHtml = `
      <a href="http://ufcstats.com/fighter-details/a">A One</a>
      <a href="http://ufcstats.com/fighter-details/b">B One</a>
      <a href="http://ufcstats.com/fighter-details/c">A Two</a>
      <a href="http://ufcstats.com/fighter-details/d">B Two</a>
      <a href="http://ufcstats.com/fighter-details/e">A Three</a>
      <a href="http://ufcstats.com/fighter-details/f">B Three</a>
      <a href="http://ufcstats.com/fighter-details/g">A Four</a>
      <a href="http://ufcstats.com/fighter-details/h">B Four</a>
      <a href="http://ufcstats.com/fighter-details/i">A Five</a>
      <a href="http://ufcstats.com/fighter-details/j">B Five</a>
    `;
    const rss = `
      <rss><channel>
        <item>
          <title>Late replacement rumor</title>
          <link>https://example.com/news-1</link>
          <pubDate>Wed, 04 Feb 2026 10:00:00 GMT</pubDate>
        </item>
      </channel></rss>
    `;

    const mockFetch = async (url) => {
      if (url.includes('/statistics/events/upcoming')) return fakeResponse(upcomingHtml);
      if (url.includes('/event-details/abc123')) return fakeResponse(eventHtml);
      if (url.includes('news.google.com')) return fakeResponse(rss);
      throw new Error(`unexpected url ${url}`);
    };

    const result = await buildWebContextForMessage(
      'analiza el main card del 7 de febrero',
      {
        fetchImpl: mockFetch,
        referenceDate: new Date(Date.UTC(2026, 1, 4)),
      }
    );

    assert.equal(result.eventName, 'UFC Test Event');
    assert.equal(result.fights.length, 5);
    assert.match(result.contextText, /Main card estimada/);
    assert.match(result.contextText, /Noticias recientes/);
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
