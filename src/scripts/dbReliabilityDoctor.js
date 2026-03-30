import '../core/env.js';
import { verifyUfcDb, createUfcDbBackup } from '../bots/ufc/ufcReliability.js';
import {
  verifyNutritionDb,
  createNutritionDbBackup,
} from '../bots/nutrition/nutritionReliability.js';
import {
  verifyBillingDb,
  createBillingDbBackup,
} from '../services/billing/reliability.js';

function parseArgs(argv = []) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || '').trim();
    if (!token.startsWith('--')) continue;
    const [rawKey, rawInlineValue] = token.slice(2).split('=', 2);
    const key = String(rawKey || '').trim();
    if (!key) continue;
    if (rawInlineValue !== undefined) {
      options[key] = rawInlineValue;
      continue;
    }
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

function parseBoolean(value, fallback = true) {
  if (value === undefined || value === null || value === '') return Boolean(fallback);
  return String(value).toLowerCase() !== 'false';
}

function resolveDomainDbPath({
  explicitArg = '',
  explicitEnv = '',
  botId = '',
  fallbackEnv = '',
  currentBotId = '',
} = {}) {
  const fromArg = String(explicitArg || '').trim();
  if (fromArg) return fromArg;
  const fromEnv = String(explicitEnv || '').trim();
  if (fromEnv) return fromEnv;
  if (String(currentBotId || '').trim() === String(botId || '').trim()) {
    return String(fallbackEnv || '').trim();
  }
  return '';
}

async function runTarget({
  name = '',
  dbPath = '',
  verifyFn = null,
  backupFn = null,
  backupDir = '',
  withBackup = true,
} = {}) {
  const normalizedDbPath = String(dbPath || '').trim();
  if (!normalizedDbPath) {
    return {
      target: name,
      skipped: true,
      reason: 'missing_db_path',
    };
  }

  const verification = verifyFn({ dbPath: normalizedDbPath });
  const result = {
    target: name,
    skipped: false,
    dbPath: normalizedDbPath,
    verification,
  };

  if (withBackup) {
    result.backup = await backupFn({
      dbPath: normalizedDbPath,
      backupDir: String(backupDir || '').trim(),
    });
  } else {
    result.backup = {
      ok: true,
      skipped: true,
    };
  }

  result.ok = Boolean(verification?.ok) && Boolean(result.backup?.ok);
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const withBackup = parseBoolean(args.with_backup ?? args.backup, true);
  const botId = String(process.env.BOT_ID || '').trim();

  const targets = [
    {
      name: 'ufc',
      dbPath: resolveDomainDbPath({
        explicitArg: args.ufc_db,
        explicitEnv: process.env.UFC_DB_PATH,
        botId: 'ufc',
        fallbackEnv: process.env.DB_PATH,
        currentBotId: botId,
      }),
      backupDir: args.ufc_backup_dir || process.env.UFC_DB_BACKUP_DIR || '',
      verifyFn: verifyUfcDb,
      backupFn: createUfcDbBackup,
    },
    {
      name: 'nutrition',
      dbPath: resolveDomainDbPath({
        explicitArg: args.nutrition_db,
        explicitEnv: process.env.NUTRITION_DB_PATH,
        botId: 'nutrition',
        fallbackEnv: process.env.DB_PATH,
        currentBotId: botId,
      }),
      backupDir: args.nutrition_backup_dir || process.env.NUTRITION_DB_BACKUP_DIR || '',
      verifyFn: verifyNutritionDb,
      backupFn: createNutritionDbBackup,
    },
    {
      name: 'billing',
      dbPath: args.billing_db || process.env.BILLING_DB_PATH || '',
      backupDir: args.billing_backup_dir || process.env.BILLING_DB_BACKUP_DIR || '',
      verifyFn: verifyBillingDb,
      backupFn: createBillingDbBackup,
    },
  ];

  const reports = [];
  for (const target of targets) {
    reports.push(
      await runTarget({
        name: target.name,
        dbPath: target.dbPath,
        verifyFn: target.verifyFn,
        backupFn: target.backupFn,
        backupDir: target.backupDir,
        withBackup,
      })
    );
  }

  const hasFailures = reports.some(
    (report) => !report.skipped && (!report.verification?.ok || !report.backup?.ok)
  );
  const output = {
    ok: !hasFailures,
    withBackup,
    reports,
    checkedAt: new Date().toISOString(),
  };

  console.log(JSON.stringify(output, null, 2));
  if (!output.ok) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
