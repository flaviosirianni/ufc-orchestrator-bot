import '../core/env.js';
import { createBillingDbBackup } from '../services/billing/reliability.js';

function parseArgs(argv = []) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || '').trim();
    if (!token.startsWith('--')) continue;
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

function toPositiveInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return Number(fallback) || 0;
  return Math.round(parsed);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await createBillingDbBackup({
    dbPath: args.db || process.env.BILLING_DB_PATH || '',
    backupDir: args.backup_dir || process.env.BILLING_DB_BACKUP_DIR || '',
    retentionDays: toPositiveInt(
      args.retention_days || process.env.BILLING_DB_BACKUP_RETENTION_DAYS,
      14
    ),
    verifyBackup:
      String(args.verify ?? process.env.BILLING_DB_BACKUP_VERIFY_RESTORE ?? 'true').toLowerCase() !==
      'false',
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
