import '../core/env.js';
import { createUfcDbBackup } from '../bots/ufc/ufcReliability.js';

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

function toPositiveIntList(value, fallback = []) {
  const raw = String(value || '').trim();
  if (!raw) return [...fallback];
  const parsed = raw
    .split(',')
    .map((item) => toPositiveInt(item.trim(), 0))
    .filter((item) => item > 0);
  return parsed.length ? parsed : [...fallback];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await createUfcDbBackup({
    dbPath: args.db || process.env.DB_PATH || '',
    backupDir: args.backup_dir || process.env.UFC_DB_BACKUP_DIR || '',
    recentDays: toPositiveInt(
      args.recent_days || process.env.UFC_DB_BACKUP_RECENT_DAYS,
      5
    ),
    milestoneDays: toPositiveIntList(
      args.milestone_days || process.env.UFC_DB_BACKUP_MILESTONE_DAYS,
      [15, 30, 60, 90]
    ),
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

