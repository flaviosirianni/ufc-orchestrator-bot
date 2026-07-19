import fs from 'node:fs';
import path from 'node:path';
import { captureOperationalSnapshot } from '../bots/ufc/operationalSnapshot.js';

/**
 * Convierte flags CLI `--key value` en opciones sin evaluar shell ni contenido dinámico.
 *
 * @returns {Record<string, string|boolean>} Opciones normalizadas.
 * @sideEffects Ninguno.
 */
function parseArgs(argv = []) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || '').trim();
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next && !String(next).startsWith('--')) {
      options[key] = String(next);
      index += 1;
    } else {
      options[key] = true;
    }
  }
  return options;
}

/**
 * Persiste evidencia JSON mediante temp+rename sólo cuando el operador pide `--out`.
 *
 * @returns {string} Path final absoluto.
 * @sideEffects Crea directorio/archivo temporal y hace rename atómico.
 */
function writeJsonAtomic(outputPath = '', payload = {}) {
  const resolvedPath = path.resolve(String(outputPath || '').trim());
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  const tempPath = `${resolvedPath}.tmp-${process.pid}`;
  fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tempPath, resolvedPath);
  return resolvedPath;
}

/**
 * Ejecuta la captura read-only y emite el documento sanitizado por stdout o archivo explícito.
 *
 * @returns {Promise<void>} Se resuelve al completar la captura.
 * @throws {Error} Ante DB ausente o lectura operacional fallida.
 * @sideEffects Lee DB/runtime; opcionalmente escribe el `--out` solicitado e imprime JSON.
 */
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dbPath = String(args.db || process.env.DB_PATH || '').trim();
  if (!dbPath) {
    throw new Error('snapshot_db_path_required');
  }
  const snapshot = await captureOperationalSnapshot({
    dbPath,
    statsDbPath: String(args['stats-db'] || process.env.UFC_STATS_DB_PATH || '').trim(),
    moduleRoot: String(args['module-root'] || process.cwd()),
    service: String(args.service || 'bot-factory@ufc'),
    healthUrl: String(args['health-url'] || 'http://127.0.0.1:3000/health'),
    journalLines: Number(args['journal-lines'] || 500),
    gitSha: String(args['git-sha'] || process.env.GIT_SHA || '').trim(),
  });
  const outputPath = String(args.out || '').trim();
  const persistedPath = outputPath ? writeJsonAtomic(outputPath, snapshot) : '';
  console.log(
    JSON.stringify(
      persistedPath ? { ok: true, output_path: persistedPath, snapshot } : snapshot,
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(
    JSON.stringify({ ok: false, error: String(error?.message || 'snapshot_failed') }, null, 2)
  );
  process.exitCode = 1;
});
