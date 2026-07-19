import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Ejecuta un proceso síncrono para construir y comprobar el fixture Git.
 *
 * @returns {string} Salida estándar sin espacios externos.
 * @throws {Error} Si el proceso termina con código distinto de cero.
 * @sideEffects Crea procesos hijo; los comandos del test sólo escriben bajo un directorio temporal.
 */
function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  }).trim();
}

/**
 * Verifica que el quality pack sea invocable y que su instalador soporte worktrees reales.
 *
 * @returns {Promise<void>} Se resuelve cuando todas las aserciones pasan.
 * @throws {AssertionError|Error} Ante contrato inválido, gate fallido o error de Git.
 * @sideEffects Crea repositorios y worktrees efímeros bajo el directorio temporal del sistema.
 */
export async function runQualityPackTests() {
  const packageJson = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'));
  assert.equal(
    packageJson.scripts?.['quality:gate'],
    'bash ./scripts/quality-gate.sh',
    'package.json debe exponer el quality gate canónico'
  );
  assert.equal(
    packageJson.scripts?.['hooks:install'],
    'bash ./scripts/install-git-hooks.sh',
    'package.json debe exponer la instalación versionada de hooks'
  );
  assert.match(
    run('bash', ['scripts/quality-gate.sh'], { cwd: path.resolve('.') }),
    /CHECK_QUALITY_PACK=ok/,
    'el quality gate debe validar el pack versionado completo'
  );

  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ufc-quality-pack-'));
  const sourceRepo = path.join(fixtureRoot, 'source');
  const worktree = path.join(fixtureRoot, 'worktree');
  fs.mkdirSync(path.join(sourceRepo, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(sourceRepo, '.githooks'), { recursive: true });
  fs.copyFileSync(
    path.resolve('scripts/install-git-hooks.sh'),
    path.join(sourceRepo, 'scripts/install-git-hooks.sh')
  );
  fs.copyFileSync(
    path.resolve('.githooks/pre-push'),
    path.join(sourceRepo, '.githooks/pre-push')
  );
  fs.chmodSync(path.join(sourceRepo, 'scripts/install-git-hooks.sh'), 0o755);
  fs.chmodSync(path.join(sourceRepo, '.githooks/pre-push'), 0o755);

  run('git', ['init', '-q'], { cwd: sourceRepo });
  run('git', ['config', 'user.email', 'quality-pack@example.invalid'], {
    cwd: sourceRepo,
  });
  run('git', ['config', 'user.name', 'Quality Pack Test'], { cwd: sourceRepo });
  run('git', ['add', '.'], { cwd: sourceRepo });
  run('git', ['commit', '-qm', 'fixture'], { cwd: sourceRepo });
  run('git', ['worktree', 'add', '-qb', 'quality-pack-worktree', worktree], {
    cwd: sourceRepo,
  });

  assert.equal(
    fs.statSync(path.join(worktree, '.git')).isFile(),
    true,
    'el fixture debe reproducir un worktree real con .git como archivo'
  );

  run('bash', ['scripts/install-git-hooks.sh'], { cwd: worktree });

  assert.equal(
    run('git', ['config', '--get', 'core.hooksPath'], { cwd: worktree }),
    '.githooks',
    'el instalador debe configurar el hooksPath versionado también desde worktrees'
  );
  assert.equal(
    fs.statSync(path.join(worktree, '.githooks', 'pre-push')).mode & 0o111,
    0o111,
    'el pre-push versionado debe quedar ejecutable'
  );

  console.log('All quality pack tests passed.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runQualityPackTests().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
