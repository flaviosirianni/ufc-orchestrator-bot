import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_CORPUS = path.resolve(
  process.cwd(),
  'src',
  'bots',
  'nutrition',
  'replayCorpus',
  'april_2026.json'
);

function loadCorpus(filePath = DEFAULT_CORPUS) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [];
}

function toPercent(value = 0) {
  return `${(Number(value || 0) * 100).toFixed(1)}%`;
}

async function runBaseline(corpus = []) {
  if (!String(process.env.DB_PATH || '').trim()) {
    process.env.DB_PATH = path.resolve('/tmp', 'nutrition_replay_baseline.db');
  }
  fs.mkdirSync(path.dirname(process.env.DB_PATH), { recursive: true });

  const { parseIntakePayload } = await import('../bots/nutrition/nutritionDomain.js');
  const { __testEvaluateParsedItemsAlignment, __testPlanNutritionAction } = await import(
    '../bots/nutrition/runtime.js'
  );

  const metrics = {
    total: corpus.length,
    parseFailCount: 0,
    semanticMismatchCount: 0,
    modifyTargetMissCount: 0,
    noResponseIncidentCount: 0,
    intentMismatchCount: 0,
  };
  const failures = [];

  for (const sample of corpus) {
    const id = String(sample?.id || '').trim() || `case_${failures.length + 1}`;
    const message = String(sample?.message || '').trim();
    const expectedIntent = String(sample?.expected?.intent || '').trim();
    const shouldParse = Boolean(sample?.expected?.shouldParse);
    const plan = __testPlanNutritionAction({
      rawMessage: message,
      hasMedia: false,
      userTimeZone: 'America/Argentina/Buenos_Aires',
    });

    if (expectedIntent && plan.intent !== expectedIntent) {
      metrics.intentMismatchCount += 1;
      if (expectedIntent === 'modify_intake' || expectedIntent === 'delete_intake') {
        metrics.modifyTargetMissCount += 1;
      }
      failures.push({
        id,
        kind: 'intent_mismatch',
        expectedIntent,
        detectedIntent: plan.intent,
        message,
      });
    }

    if (shouldParse) {
      const parsed = parseIntakePayload({
        rawMessage: message,
        userTimeZone: 'America/Argentina/Buenos_Aires',
      });
      if (!parsed?.ok) {
        metrics.parseFailCount += 1;
        failures.push({
          id,
          kind: 'parse_fail',
          error: parsed?.error || 'unknown',
          message,
        });
      } else {
        const alignment = __testEvaluateParsedItemsAlignment(message, parsed.items || []);
        if (!alignment?.aligned) {
          metrics.semanticMismatchCount += 1;
          failures.push({
            id,
            kind: 'semantic_mismatch',
            score: alignment?.score ?? null,
            reason: alignment?.reason || '',
            message,
          });
        }
      }
    }
  }

  const denominator = Math.max(metrics.total, 1);
  return {
    metrics: {
      total_cases: metrics.total,
      parse_fail_rate: toPercent(metrics.parseFailCount / denominator),
      semantic_mismatch_rate: toPercent(metrics.semanticMismatchCount / denominator),
      modify_target_miss_rate: toPercent(metrics.modifyTargetMissCount / denominator),
      no_response_incidents: metrics.noResponseIncidentCount,
      intent_mismatch_rate: toPercent(metrics.intentMismatchCount / denominator),
    },
    failures,
  };
}

async function main() {
  const corpusPath = process.argv[2] ? path.resolve(process.cwd(), process.argv[2]) : DEFAULT_CORPUS;
  const corpus = loadCorpus(corpusPath);
  const report = await runBaseline(corpus);
  console.log(JSON.stringify(report, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
