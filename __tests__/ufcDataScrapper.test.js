import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

function writeExecutable(filePath, contents) {
  fs.writeFileSync(filePath, contents, { mode: 0o755 });
}

function createFightsDb(dbPath, rows) {
  fs.rmSync(dbPath, { force: true });
  const values = rows
    .map(({ id, dateIso }) => `('${id}','${dateIso}')`)
    .join(',');
  const sql = `CREATE TABLE fights (fight_id TEXT PRIMARY KEY, event_date_iso TEXT);${
    rows.length ? `INSERT INTO fights VALUES ${values};` : ''
  }`;
  execFileSync('sqlite3', [dbPath, sql]);
}

function countFights(dbPath) {
  return Number(
    execFileSync('sqlite3', [dbPath, 'SELECT COUNT(*) FROM fights;']).toString().trim()
  );
}

// Fake `.venv/bin/python` standing in for the real scraper: `run_ufc.py` calls are no-ops,
// `convert_to_sqlite.py --output X` builds a real candidate SQLite DB at X so the script's
// sqlite3-based validation runs against real data instead of mocked output.
function writeFakePython(fakePyPath, { candidateRows }) {
  const candidateRowsSql = candidateRows
    .map(({ id, dateIso }) => `('${id}','${dateIso}')`)
    .join(',');
  writeExecutable(
    fakePyPath,
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "convert_to_sqlite.py" ]]; then
  out=""
  for ((i=1; i<=$#; i++)); do
    if [[ "\${!i}" == "--output" ]]; then
      j=$((i+1))
      out="\${!j}"
    fi
  done
  sqlite3 "$out" "CREATE TABLE fights (fight_id TEXT PRIMARY KEY, event_date_iso TEXT);${
    candidateRows.length ? `INSERT INTO fights VALUES ${candidateRowsSql};` : ''
  }"
fi
exit 0
`
  );
}

function runScraperScript({ tmpDir, env: extraEnv }) {
  const scriptPath = path.resolve('ops/scripts/run-ufc-data-scrapper.sh');
  return execFileSync('bash', [scriptPath], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      PATH: `${path.join(tmpDir, 'bin')}:${process.env.PATH}`,
      SCRAPER_DIR: tmpDir,
      SCRAPER_LOG_FILE: path.join(tmpDir, 'scrapper.log'),
      SCRAPER_LOCK_FILE: path.join(tmpDir, 'scrapper.lock'),
      HEALTH_WAIT_SEC: '5',
      ...extraEnv,
    },
  });
}

function setupTmpDir(prefix) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(tmpDir, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, '.venv', 'bin'), { recursive: true });
  return tmpDir;
}

export async function runUfcDataScrapperTests() {
  {
    // Happy path: candidate has more fights than live, passes validation -> swap + restart +
    // health check all succeed -> live DB replaced, one-generation backup kept.
    const tmpDir = setupTmpDir('ufc-scrapper-happy-');
    const liveDb = path.join(tmpDir, 'ufc_stats.db');
    createFightsDb(liveDb, [{ id: 'f1', dateIso: '2026-03-01' }, { id: 'f2', dateIso: '2026-03-08' }]);
    writeFakePython(path.join(tmpDir, '.venv', 'bin', 'python'), {
      candidateRows: [
        { id: 'f1', dateIso: '2026-03-01' },
        { id: 'f2', dateIso: '2026-03-08' },
        { id: 'f3', dateIso: '2026-03-15' },
      ],
    });
    writeExecutable(path.join(tmpDir, 'bin', 'sudo'), `#!/usr/bin/env bash\nexit 0\n`);
    writeExecutable(path.join(tmpDir, 'bin', 'curl'), `#!/usr/bin/env bash\nexit 0\n`);

    runScraperScript({ tmpDir, env: { LIVE_DB: liveDb } });

    assert.equal(countFights(liveDb), 3, 'live DB debe reflejar el candidato validado');
    assert.ok(fs.existsSync(`${liveDb}.bak`), 'debe quedar un backup de la generacion anterior');
    assert.equal(countFights(`${liveDb}.bak`), 2, 'el backup debe ser el contenido live previo');
    assert.ok(!fs.existsSync(`${liveDb}.candidate`), 'no debe quedar archivo candidato residual');
  }

  {
    // Candidate regresses (fewer fights than live) -> must abort before touching the live DB.
    const tmpDir = setupTmpDir('ufc-scrapper-regression-');
    const liveDb = path.join(tmpDir, 'ufc_stats.db');
    createFightsDb(liveDb, [
      { id: 'f1', dateIso: '2026-03-01' },
      { id: 'f2', dateIso: '2026-03-08' },
      { id: 'f3', dateIso: '2026-03-15' },
    ]);
    writeFakePython(path.join(tmpDir, '.venv', 'bin', 'python'), {
      candidateRows: [{ id: 'f1', dateIso: '2026-03-01' }],
    });
    const sudoLog = path.join(tmpDir, 'sudo.log');
    writeExecutable(path.join(tmpDir, 'bin', 'sudo'), `#!/usr/bin/env bash\necho called >> "${sudoLog}"\nexit 0\n`);
    writeExecutable(path.join(tmpDir, 'bin', 'curl'), `#!/usr/bin/env bash\nexit 0\n`);

    assert.throws(() => runScraperScript({ tmpDir, env: { LIVE_DB: liveDb } }));

    assert.equal(countFights(liveDb), 3, 'la DB live no debe tocarse ante una regresion de conteo');
    assert.ok(!fs.existsSync(`${liveDb}.bak`), 'no debe crearse backup si nunca se llego a swapear');
    assert.ok(!fs.existsSync(sudoLog), 'no debe reiniciarse el bot si la validacion fallo');
  }

  {
    // Swap succeeds but /health never comes back -> must roll back to the pre-swap content.
    const tmpDir = setupTmpDir('ufc-scrapper-rollback-');
    const liveDb = path.join(tmpDir, 'ufc_stats.db');
    createFightsDb(liveDb, [{ id: 'f1', dateIso: '2026-03-01' }]);
    writeFakePython(path.join(tmpDir, '.venv', 'bin', 'python'), {
      candidateRows: [
        { id: 'f1', dateIso: '2026-03-01' },
        { id: 'f2', dateIso: '2026-03-08' },
      ],
    });
    const sudoLog = path.join(tmpDir, 'sudo.log');
    writeExecutable(path.join(tmpDir, 'bin', 'sudo'), `#!/usr/bin/env bash\necho called >> "${sudoLog}"\nexit 0\n`);
    // curl always fails: /health never comes up post-swap.
    writeExecutable(path.join(tmpDir, 'bin', 'curl'), `#!/usr/bin/env bash\nexit 1\n`);

    assert.throws(() => runScraperScript({ tmpDir, env: { LIVE_DB: liveDb } }));

    assert.equal(countFights(liveDb), 1, 'debe revertirse al contenido previo al swap');
    assert.ok(!fs.existsSync(`${liveDb}.bak`), 'el backup debe consumirse durante el rollback');
    const sudoCalls = fs.readFileSync(sudoLog, 'utf8').trim().split('\n');
    assert.equal(sudoCalls.length, 2, 'debe reiniciar el bot dos veces: swap inicial y rollback');
  }

  console.log('All ufc data scrapper script tests passed.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runUfcDataScrapperTests().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
