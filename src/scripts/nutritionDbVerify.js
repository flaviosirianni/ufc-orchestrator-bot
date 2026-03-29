import '../core/env.js';
import { verifyNutritionDb } from '../bots/nutrition/nutritionReliability.js';

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

function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = verifyNutritionDb({
    dbPath: args.db || process.env.DB_PATH || '',
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    process.exitCode = 1;
  }
}

main();

