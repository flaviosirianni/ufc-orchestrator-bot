import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initUfcStatsTool, getFreshnessMeta } from '../src/tools/ufcStatsTool.js';

function buildDb({ dbPath, rows, meta }) {
  fs.rmSync(dbPath, { force: true });
  const db = new Database(dbPath);
  db.exec(
    'CREATE TABLE fights (fight_id TEXT PRIMARY KEY, event_date TEXT, event_date_iso TEXT)'
  );
  db.exec('CREATE TABLE upcoming_fights (fight_id TEXT PRIMARY KEY)');
  const insert = db.prepare(
    'INSERT INTO fights (fight_id, event_date, event_date_iso) VALUES (?, ?, ?)'
  );
  for (const row of rows) {
    insert.run(row.id, row.eventDate, row.eventDateIso ?? null);
  }
  if (meta) {
    db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)');
    const insertMeta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
    for (const [key, value] of Object.entries(meta)) {
      insertMeta.run(key, value);
    }
  }
  db.close();
}

export async function runUfcStatsToolTests() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ufc-stats-tool-test-'));

  {
    // The real incident this guards against: textual event_date sorts "September" ahead of a
    // much more recent "April" (S > A alphabetically, regardless of year). event_date_iso must
    // be the source of truth for "latest fight" once it's populated.
    const dbPath = path.join(tmpDir, 'textual-sort.db');
    buildDb({
      dbPath,
      rows: [
        { id: 'old-but-textually-last', eventDate: 'September 28, 2024', eventDateIso: '2024-09-28' },
        { id: 'new-real-latest', eventDate: 'April 04, 2026', eventDateIso: '2026-04-04' },
      ],
    });

    initUfcStatsTool({ dbPath });
    const meta = getFreshnessMeta();

    assert.equal(meta.latestFightDate, '2026-04-04', 'debe usar event_date_iso, no el orden alfabetico de event_date');
  }

  {
    // Legacy DB with no meta table (pre-fix scraper output): must fall back to file mtime,
    // same behavior as before this change, not crash or report a bogus timestamp.
    const dbPath = path.join(tmpDir, 'legacy-no-meta.db');
    buildDb({ dbPath, rows: [{ id: 'f1', eventDate: 'March 07, 2026', eventDateIso: '2026-03-07' }] });

    initUfcStatsTool({ dbPath });
    const meta = getFreshnessMeta();

    assert.equal(meta.freshnessSource, 'file_mtime');
    assert.ok(meta.generatedAt, 'debe seguir reportando un generatedAt via mtime como fallback');
  }

  {
    // New-format DB with a meta table: generated_at must come from there (the actual moment
    // the scraper produced the artifact), not from the file's mtime (which can be skewed by
    // scp/rsync, atomic-rename semantics, or the deploy mechanism itself).
    const dbPath = path.join(tmpDir, 'with-meta.db');
    const embeddedGeneratedAt = '2026-08-01T03:00:00.000Z';
    buildDb({
      dbPath,
      rows: [{ id: 'f1', eventDate: 'March 07, 2026', eventDateIso: '2026-03-07' }],
      meta: { generated_at: embeddedGeneratedAt },
    });

    initUfcStatsTool({ dbPath });
    const meta = getFreshnessMeta();

    assert.equal(meta.generatedAt, embeddedGeneratedAt);
    assert.equal(meta.freshnessSource, 'meta_table');
  }

  console.log('All ufc stats tool tests passed.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runUfcStatsToolTests().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
