import '../core/env.js';
import { addCredits } from '../core/sqliteStore.js';

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < args.length; i += 1) {
    const key = args[i];
    const value = args[i + 1];
    if (!key) continue;
    if (key === '--user') {
      out.userId = value;
      i += 1;
    } else if (key === '--credits') {
      out.credits = Number(value);
      i += 1;
    } else if (key === '--reason') {
      out.reason = value;
      i += 1;
    }
  }
  return out;
}

const { userId, credits, reason } = parseArgs();

if (!userId || !Number.isFinite(Number(credits))) {
  console.log('Uso: node src/scripts/addCredits.js --user <telegram_user_id> --credits <n>');
  process.exit(1);
}

const result = addCredits(String(userId), Number(credits), {
  reason: reason || 'manual_topup',
  metadata: { source: 'cli' },
});

if (result.ok) {
  console.log(`✅ Credits agregados: ${credits} para user ${userId}`);
} else {
  console.log('❌ No se pudieron agregar credits.');
  process.exit(1);
}
