import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Escribe un ejecutable de fixture para aislar Git, SSH, Node o npm en pruebas de paridad.
 *
 * @returns {void}
 * @sideEffects Crea un archivo ejecutable bajo un directorio temporal.
 */
function writeExecutable(filePath, contents) {
  fs.writeFileSync(filePath, contents, { mode: 0o755 });
}

/**
 * Ejecuta un script Node del repositorio capturando salida y estado.
 *
 * @returns {import('node:child_process').SpawnSyncReturns<string>} Resultado síncrono.
 * @sideEffects Crea un proceso hijo; el script puede escribir únicamente en sus fixtures.
 */
function runNode(scriptPath, args = [], env = process.env) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: path.resolve('.'),
    env,
    encoding: 'utf8',
  });
}

/**
 * Verifica paths seguros, diferencia de token y selección de matriz prod-like por bot.
 *
 * @returns {Promise<void>} Se resuelve cuando los contratos UFC y legacy Nutrition pasan.
 * @throws {AssertionError|Error} Ante safety incompleto o matriz hardcodeada al bot equivocado.
 * @sideEffects Crea y elimina envs, perfiles, binarios y logs de prueba temporales.
 */
export async function runParityScriptsTests() {
  const packageJson = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'));
  assert.equal(
    packageJson.scripts?.['parity:env:ufc'],
    'node src/scripts/envParityDoctor.js --bot ufc --env-file .env.ufc --server ufc-oci --enforce-live-token-diff'
  );
  assert.equal(
    packageJson.scripts?.['qa:parity:ufc'],
    'node src/scripts/parityGate.js --bot ufc --env-file .env.ufc --server ufc-oci --enforce-live-token-diff'
  );
  assert.equal(packageJson.scripts?.['prepush:ufc'], 'npm run qa:parity:ufc');

  const ufcRequiredKeys = JSON.parse(
    fs.readFileSync(path.resolve('ops/parity/ufc.required-keys.json'), 'utf8')
  );
  assert.ok(ufcRequiredKeys.required_keys.includes('TELEGRAM_BOT_TOKEN'));
  assert.ok(ufcRequiredKeys.required_keys.includes('UFC_STATS_DB_PATH'));
  const ufcSafety = JSON.parse(
    fs.readFileSync(path.resolve('ops/parity/ufc.local-safety.json'), 'utf8')
  );
  assert.deepEqual(
    ufcSafety.path_rules.map((rule) => rule.env_key),
    ['DB_PATH', 'UFC_STATS_DB_PATH']
  );
  const ufcEnvExample = fs.readFileSync(path.resolve('.env.ufc.local.example'), 'utf8');
  assert.match(ufcEnvExample, /^BOT_ID=ufc$/m);
  assert.match(ufcEnvExample, /^UFC_STATS_DB_PATH=/m);
  assert.doesNotMatch(ufcEnvExample, /\/home\/ubuntu\//);

  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ufc-parity-scripts-'));
  const parityDir = path.join(fixtureRoot, 'parity');
  const fakeBin = path.join(fixtureRoot, 'bin');
  const envFile = path.join(fixtureRoot, '.env.ufc');
  const commandLog = path.join(fixtureRoot, 'commands.log');
  fs.mkdirSync(parityDir, { recursive: true });
  fs.mkdirSync(fakeBin, { recursive: true });

  try {
    fs.writeFileSync(
      path.join(parityDir, 'ufc.required-keys.json'),
      JSON.stringify({ bot: 'ufc', required_keys: ['BOT_ID', 'DB_PATH', 'UFC_STATS_DB_PATH'] })
    );
    fs.writeFileSync(
      path.join(parityDir, 'ufc.invariants.json'),
      JSON.stringify({ bot: 'ufc', invariants: { BOT_ID: 'ufc' } })
    );
    fs.writeFileSync(
      path.join(parityDir, 'ufc.local-safety.json'),
      JSON.stringify({
        bot: 'ufc',
        path_rules: [
          { env_key: 'DB_PATH', required: true, forbidden_prefixes: ['/home/ubuntu/'] },
          {
            env_key: 'UFC_STATS_DB_PATH',
            required: true,
            forbidden_prefixes: ['/home/ubuntu/'],
          },
        ],
        token_diff: {
          local_env_key: 'TELEGRAM_BOT_TOKEN',
          live_env_key: 'TELEGRAM_BOT_TOKEN',
        },
      })
    );
    fs.writeFileSync(
      envFile,
      [
        'BOT_ID=ufc',
        'DB_PATH=/private/tmp/ufc-local/bot.db',
        'UFC_STATS_DB_PATH=/home/ubuntu/ufc-orchestrator-data/ufc_stats.db',
        'TELEGRAM_BOT_TOKEN=local-test-token',
      ].join('\n')
    );

    const unsafePathResult = runNode('src/scripts/envParityDoctor.js', [
      '--bot',
      'ufc',
      '--env-file',
      envFile,
      '--parity-dir',
      parityDir,
      '--no-enforce-live-token-diff',
    ]);
    assert.equal(unsafePathResult.status, 1, 'un path UFC productivo debe bloquear el gate local');
    const unsafePayload = JSON.parse(unsafePathResult.stdout);
    assert.ok(
      unsafePayload.safety_violations.some(
        (entry) =>
          entry.type === 'path_forbidden_prefix' &&
          entry.key === 'UFC_STATS_DB_PATH'
      ),
      'UFC_STATS_DB_PATH debe evaluarse además de DB_PATH'
    );

    fs.writeFileSync(
      envFile,
      [
        'BOT_ID=ufc',
        'DB_PATH=/private/tmp/ufc-local/bot.db',
        'UFC_STATS_DB_PATH=/private/tmp/ufc-local/ufc_stats.db',
        'TELEGRAM_BOT_TOKEN=same-token',
      ].join('\n')
    );
    writeExecutable(
      path.join(fakeBin, 'ssh'),
      '#!/usr/bin/env bash\nprintf "%s\\n" "same-token"\n'
    );
    const tokenResult = runNode(
      'src/scripts/envParityDoctor.js',
      [
        '--bot',
        'ufc',
        '--env-file',
        envFile,
        '--parity-dir',
        parityDir,
        '--server',
        'fake-server',
        '--enforce-live-token-diff',
      ],
      { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` }
    );
    assert.equal(tokenResult.status, 1, 'el token UFC local no puede coincidir con live');
    const tokenPayload = JSON.parse(tokenResult.stdout);
    assert.ok(
      tokenPayload.safety_violations.some((entry) => entry.type === 'token_matches_live')
    );

    const sha = '1111111111111111111111111111111111111111';
    writeExecutable(path.join(fakeBin, 'git'), `#!/usr/bin/env bash\nprintf "%s\\n" "${sha}"\n`);
    writeExecutable(path.join(fakeBin, 'ssh'), `#!/usr/bin/env bash\nprintf "%s\\n" "${sha}"\n`);
    writeExecutable(
      path.join(fakeBin, 'node'),
      '#!/usr/bin/env bash\nprintf "%s\\n" "{\\"ok\\":true}"\n'
    );
    writeExecutable(
      path.join(fakeBin, 'npm'),
      '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$PARITY_TEST_LOG"\n'
    );

    const gateResult = runNode(
      'src/scripts/parityGate.js',
      ['--bot', 'ufc', '--env-file', envFile, '--server', 'fake-server'],
      {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        PARITY_TEST_LOG: commandLog,
      }
    );
    assert.equal(gateResult.status, 0, gateResult.stderr || gateResult.stdout);
    const commands = fs.readFileSync(commandLog, 'utf8');
    assert.match(commands, /^test$/m, 'UFC debe conservar la suite completa compartida');
    assert.match(
      commands,
      /run ufc:db:verify -- --db \/private\/tmp\/ufc-local\/bot\.db/,
      'la matriz UFC debe ejecutar su verificador DB y no comandos Nutrition'
    );
    assert.doesNotMatch(commands, /nutrition:/, 'la matriz UFC no debe ejecutar gates Nutrition');

    console.log('All parity scripts tests passed.');
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runParityScriptsTests().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
