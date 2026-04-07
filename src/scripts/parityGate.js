import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function parseArgs(argv = []) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || '').trim();
    if (!token.startsWith('--')) continue;

    if (token.startsWith('--no-')) {
      options[token.slice(5)] = false;
      continue;
    }

    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !String(next).startsWith('--')) {
      options[key] = next;
      i += 1;
      continue;
    }
    options[key] = true;
  }
  return options;
}

function asString(value, fallback = '') {
  const normalized = String(value ?? '').trim();
  return normalized || fallback;
}

function asBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (value == null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(normalized);
}

function resolvePathFromCwd(rawPath = '') {
  const value = asString(rawPath);
  if (!value) return '';
  if (path.isAbsolute(value)) return value;
  return path.resolve(process.cwd(), value);
}

function parseEnvLine(line = '') {
  const trimmed = String(line || '').trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const separator = trimmed.indexOf('=');
  if (separator === -1) return null;
  const key = trimmed.slice(0, separator).trim();
  if (!key) return null;
  const value = trimmed.slice(separator + 1).trim();
  return [key, value];
}

function parseEnvText(contents = '') {
  const result = {};
  String(contents || '')
    .split('\n')
    .map(parseEnvLine)
    .filter(Boolean)
    .forEach(([key, value]) => {
      result[key] = value;
    });
  return result;
}

function resolveDefaultEnvFile(botId = 'nutrition') {
  const candidates = [`.env.${botId}`, `.env.${botId}.local`, '.env'];
  for (const candidate of candidates) {
    const resolved = resolvePathFromCwd(candidate);
    if (fs.existsSync(resolved)) {
      return resolved;
    }
  }
  return resolvePathFromCwd(candidates[0]);
}

function expandEnvValue(raw = '') {
  const value = asString(raw);
  if (!value) return '';
  return value
    .replace(/^\$HOME\b/, process.env.HOME || '')
    .replace(/^\$\{HOME\}/, process.env.HOME || '');
}

function runCommand(command = '', args = [], { env = process.env, inherit = true } = {}) {
  const startedAt = Date.now();
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env,
    encoding: 'utf8',
    stdio: inherit ? 'inherit' : 'pipe',
  });

  return {
    ok: result.status === 0,
    status: result.status ?? null,
    signal: result.signal ?? null,
    duration_ms: Date.now() - startedAt,
    stdout: inherit ? '' : asString(result.stdout),
    stderr: inherit ? '' : asString(result.stderr),
  };
}

function runCapture(command = '', args = []) {
  return runCommand(command, args, { inherit: false });
}

function commandSummary(command = '', args = []) {
  return [command, ...args].join(' ');
}

function runMatrixCommand({ name = '', command = '', args = [], env = process.env } = {}) {
  console.log(`\n[parity-gate] running: ${commandSummary(command, args)}`);
  const execResult = runCommand(command, args, { env, inherit: true });
  return {
    name,
    command: commandSummary(command, args),
    ok: execResult.ok,
    status: execResult.status,
    duration_ms: execResult.duration_ms,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const botId = asString(args.bot, 'nutrition');
  const envFile = resolvePathFromCwd(asString(args['env-file']) || resolveDefaultEnvFile(botId));
  const server = asString(args.server, 'ufc-oci');
  const liveRepoDir = asString(args['server-repo-dir'], '/home/ubuntu/apps/bot-factory');
  const liveEnvFile = asString(args['live-env-file'], `/etc/bot-factory/${botId}.env`);
  const withSmoke = asBoolean(args['with-smoke'], false);
  const enforceLiveTokenDiff = asBoolean(args['enforce-live-token-diff'], true);

  const sharedEnv = { ...process.env };
  const nutritionEnv = {
    ...process.env,
    BOT_ID: botId,
    ENV_FILE: envFile,
  };

  const summary = {
    bot: botId,
    env_file: envFile,
    server,
    server_repo_dir: liveRepoDir,
    with_smoke: withSmoke,
    checked_at: new Date().toISOString(),
    steps: [],
    ok: true,
  };

  if (!fs.existsSync(envFile)) {
    summary.steps.push({
      name: 'env-file',
      ok: false,
      message: `No existe env file: ${envFile}`,
    });
    summary.ok = false;
    console.log(JSON.stringify(summary, null, 2));
    process.exitCode = 1;
    return;
  }

  console.log('[parity-gate] step 1/3: code parity checks');
  const localHead = runCapture('git', ['rev-parse', 'HEAD']);
  const originMain = runCapture('git', ['rev-parse', 'origin/main']);
  const mergeBaseOrigin = runCapture('git', ['merge-base', 'HEAD', 'origin/main']);
  const serverHead = runCapture('ssh', [
    server,
    `cd ${liveRepoDir} && git rev-parse HEAD`,
  ]);

  let mergeBaseServer = { ok: false, stdout: '', status: null };
  if (serverHead.ok) {
    const serverHeadSha = asString(serverHead.stdout);
    mergeBaseServer = runCapture('git', ['merge-base', 'HEAD', serverHeadSha]);
  }

  const localHeadSha = asString(localHead.stdout);
  const originMainSha = asString(originMain.stdout);
  const mergeBaseOriginSha = asString(mergeBaseOrigin.stdout);
  const serverHeadSha = asString(serverHead.stdout);
  const mergeBaseServerSha = asString(mergeBaseServer.stdout);

  const codeParityErrors = [];
  if (!localHead.ok) {
    codeParityErrors.push('No se pudo leer HEAD local.');
  }
  if (!originMain.ok) {
    codeParityErrors.push('No se pudo resolver origin/main local.');
  }
  if (!mergeBaseOrigin.ok) {
    codeParityErrors.push('No se pudo calcular merge-base con origin/main.');
  }
  if (originMain.ok && mergeBaseOrigin.ok && mergeBaseOriginSha !== originMainSha) {
    codeParityErrors.push('HEAD local no esta basado en origin/main actual.');
  }
  if (!serverHead.ok) {
    codeParityErrors.push(`No se pudo leer HEAD deployado en server (${server}).`);
  }
  if (serverHead.ok && !mergeBaseServer.ok) {
    codeParityErrors.push('No se pudo calcular merge-base con HEAD deployado.');
  }
  if (serverHead.ok && mergeBaseServer.ok && mergeBaseServerSha !== serverHeadSha) {
    codeParityErrors.push('HEAD local no contiene la referencia deployada en server.');
  }

  const codeParityOk = codeParityErrors.length === 0;
  summary.steps.push({
    name: 'code_parity',
    ok: codeParityOk,
    local_head: localHeadSha,
    origin_main: originMainSha,
    server_head: serverHeadSha,
    merge_base_origin_main: mergeBaseOriginSha,
    merge_base_server_head: mergeBaseServerSha,
    errors: codeParityErrors,
  });
  if (!codeParityOk) {
    summary.ok = false;
  }

  console.log('[parity-gate] step 2/3: env parity doctor');
  const doctorArgs = [
    'src/scripts/envParityDoctor.js',
    '--bot',
    botId,
    '--env-file',
    envFile,
    '--server',
    server,
    '--live-env-file',
    liveEnvFile,
  ];
  if (enforceLiveTokenDiff) {
    doctorArgs.push('--enforce-live-token-diff');
  }
  const envDoctorExec = runCommand('node', doctorArgs, { env: nutritionEnv, inherit: false });
  let envDoctorPayload = null;
  if (envDoctorExec.stdout) {
    try {
      envDoctorPayload = JSON.parse(envDoctorExec.stdout);
    } catch {
      envDoctorPayload = null;
    }
  }
  const envDoctorOk = envDoctorExec.ok && !!envDoctorPayload?.ok;
  summary.steps.push({
    name: 'env_parity',
    ok: envDoctorOk,
    command: commandSummary('node', doctorArgs),
    status: envDoctorExec.status,
    payload: envDoctorPayload,
    stderr: envDoctorExec.stderr || '',
  });
  if (!envDoctorOk) {
    summary.ok = false;
  }

  console.log('[parity-gate] step 3/3: prod-like test matrix');
  const envMap = parseEnvText(fs.readFileSync(envFile, 'utf8'));
  const dbPath = expandEnvValue(envMap.DB_PATH || '');
  const testResults = [];
  const matrix = [
    { name: 'npm_test', command: 'npm', args: ['test'], env: sharedEnv },
    {
      name: 'nutrition_domain_test',
      command: 'node',
      args: ['__tests__/nutritionDomain.test.js'],
      env: nutritionEnv,
    },
    { name: 'nutrition_baseline', command: 'npm', args: ['run', 'nutrition:baseline'], env: nutritionEnv },
    {
      name: 'nutrition_db_verify',
      command: 'npm',
      args: ['run', 'nutrition:db:verify', '--', '--db', dbPath],
      env: nutritionEnv,
    },
  ];

  for (const entry of matrix) {
    const result = runMatrixCommand({
      name: entry.name,
      command: entry.command,
      args: entry.args,
      env: entry.env || sharedEnv,
    });
    testResults.push(result);
    if (!result.ok) {
      break;
    }
  }

  if (withSmoke && testResults.every((result) => result.ok)) {
    const smokeResult = runMatrixCommand({
      name: 'nutrition_ops_smoke',
      command: 'npm',
      args: ['run', 'nutrition:smoke'],
      env: nutritionEnv,
    });
    testResults.push(smokeResult);
  }

  const matrixOk = testResults.length > 0 && testResults.every((result) => result.ok);
  summary.steps.push({
    name: 'test_matrix',
    ok: matrixOk,
    db_path: dbPath,
    results: testResults,
  });
  if (!matrixOk) {
    summary.ok = false;
  }

  console.log('\n[parity-gate] summary');
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok) {
    process.exitCode = 1;
  }
}

main();
