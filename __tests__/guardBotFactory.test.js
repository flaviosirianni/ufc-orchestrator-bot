import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

function writeExecutable(filePath, contents) {
  fs.writeFileSync(filePath, contents, { mode: 0o755 });
}

export async function runGuardBotFactoryTests() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-factory-guard-test-'));
  const fakeBin = path.join(tmpDir, 'bin');
  fs.mkdirSync(fakeBin, { recursive: true });
  const sudoLog = path.join(tmpDir, 'sudo.log');
  const logFile = path.join(tmpDir, 'guard.log');
  const stateFile = path.join(tmpDir, 'guard-state.json');
  const lockFile = path.join(tmpDir, 'guard.lock');
  const scriptPath = path.resolve('ops/scripts/guard-bot-factory.sh');

  writeExecutable(
    path.join(fakeBin, 'curl'),
    `#!/usr/bin/env bash
case "$*" in
  *3001*)
    cat <<'JSON'
{"ok":true,"runtime":{"telegram":{"degraded":false,"idleMs":600000,"pollingConflictCount":0,"lastUpdateAt":1000,"lastPollingErrorAt":2000,"lastErrorMessage":"EFATAL: AggregateError"}}}
JSON
    ;;
  *3000*|*3002*)
    cat <<'JSON'
{"ok":true,"runtime":{"telegram":{"degraded":false,"idleMs":0,"pollingConflictCount":0,"lastUpdateAt":2000,"lastPollingErrorAt":0,"lastErrorMessage":""}}}
JSON
    ;;
  *)
    exit 0
    ;;
esac
`
  );
  writeExecutable(
    path.join(fakeBin, 'sudo'),
    `#!/usr/bin/env bash
echo "$@" >> "${sudoLog}"
exit 0
`
  );

  execFileSync('bash', [scriptPath], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      GUARD_LOG_FILE: logFile,
      GUARD_STATE_FILE: stateFile,
      GUARD_LOCK_FILE: lockFile,
      RESTART_WINDOW_SEC: '0',
      STALE_IDLE_SEC: '300',
    },
  });

  assert.ok(fs.existsSync(stateFile), 'guard debe respetar GUARD_STATE_FILE');
  const sudoCalls = fs.existsSync(sudoLog) ? fs.readFileSync(sudoLog, 'utf8') : '';
  assert.match(
    sudoCalls,
    /systemctl restart bot-factory@nutrition/,
    'guard debe reiniciar nutrition cuando hay polling error stale sin conflicts nuevos'
  );

  console.log('All guard bot factory tests passed.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runGuardBotFactoryTests().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
