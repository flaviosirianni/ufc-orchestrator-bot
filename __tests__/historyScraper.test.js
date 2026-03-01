import assert from 'node:assert/strict';
import {
  parseCompletedEventsFromHtml,
  listMissingCompletedEvents,
} from '../src/agents/historyScraper.js';

export async function runHistoryScraperTests() {
  const tests = [];

  tests.push(async () => {
    const html = `
      <table>
        <tr>
          <td><a href="http://ufcstats.com/event-details/aaa">UFC 326: Event A</a></td>
          <td>February 07, 2026</td>
        </tr>
        <tr>
          <td><a href="/event-details/bbb">UFC Fight Night: Event B &amp; More</a></td>
          <td>February 21, 2026</td>
        </tr>
        <tr>
          <td><a href="/event-details/bbb">UFC Fight Night: Event B &amp; More</a></td>
          <td>February 21, 2026</td>
        </tr>
      </table>
    `;

    const events = parseCompletedEventsFromHtml(html, {
      baseUrl: 'https://www.ufcstats.com/statistics/events/completed?page=all',
    });

    assert.equal(events.length, 2);
    assert.equal(events[0].eventDate, '2026-02-07');
    assert.equal(events[0].eventName, 'UFC 326: Event A');
    assert.equal(events[0].eventUrl, 'http://ufcstats.com/event-details/aaa');
    assert.equal(events[1].eventDate, '2026-02-21');
    assert.equal(events[1].eventName, 'UFC Fight Night: Event B & More');
    assert.equal(events[1].eventUrl, 'https://www.ufcstats.com/event-details/bbb');
  });

  tests.push(async () => {
    const missing = listMissingCompletedEvents({
      events: [
        { eventDate: '2026-02-01', eventName: 'UFC 325', eventUrl: 'u1' },
        { eventDate: '2026-02-07', eventName: 'UFC 326', eventUrl: 'u2' },
        { eventDate: '2026-02-21', eventName: 'UFC FN', eventUrl: 'u3' },
        { eventDate: '2026-03-01', eventName: 'Future Event', eventUrl: 'u4' },
      ],
      sinceDate: '2026-02-01',
      untilDate: '2026-02-22',
      maxEvents: 10,
    });

    assert.deepEqual(
      missing.map((item) => item.eventDate),
      ['2026-02-07', '2026-02-21']
    );
  });

  tests.push(async () => {
    const missing = listMissingCompletedEvents({
      events: [
        { eventDate: '2026-02-07', eventName: 'UFC 326', eventUrl: 'u2' },
        { eventDate: '2026-02-21', eventName: 'UFC FN', eventUrl: 'u3' },
      ],
      sinceDate: '2026-01-01',
      untilDate: '2026-02-22',
      maxEvents: 1,
    });

    assert.equal(missing.length, 1);
    assert.equal(missing[0].eventDate, '2026-02-07');
  });

  for (const test of tests) {
    await test();
  }

  console.log('All historyScraper tests passed.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runHistoryScraperTests().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

