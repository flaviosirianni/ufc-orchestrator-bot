import { execFileSync } from 'node:child_process';

const SUITES = [
  { modulePath: './routerChain.test.js', exportName: 'runRouterChainTests' },
  { modulePath: './conversationStore.test.js', exportName: 'runConversationStoreTests' },
  { modulePath: './toolsHandlers.test.js', exportName: 'runToolsHandlersTests' },
  { modulePath: './webIntelTool.test.js', exportName: 'runWebIntelToolTests' },
  { modulePath: './oddsApiTool.test.js', exportName: 'runOddsApiToolTests' },
  { modulePath: './betScoringEngine.test.js', exportName: 'runBetScoringEngineTests' },
  { modulePath: './historyScraper.test.js', exportName: 'runHistoryScraperTests' },
  { modulePath: './autoSettlement.test.js', exportName: 'runAutoSettlementTests' },
  { modulePath: './sqliteStoreComposite.test.js', exportName: 'runSqliteStoreCompositeTests' },
  { modulePath: './bettingWizard.test.js', exportName: 'runBettingWizardTests' },
  { modulePath: './telegramBot.test.js', exportName: 'runTelegramBotTests' },
  { modulePath: './messageFormatter.test.js', exportName: 'runMessageFormatterTests' },
  { modulePath: './manifest.test.js', exportName: 'runManifestTests' },
  { modulePath: './policyGuard.test.js', exportName: 'runPolicyGuardTests' },
  { modulePath: './billingStore.test.js', exportName: 'runBillingStoreTests' },
];

async function runSuite({ modulePath = '', exportName = '' } = {}) {
  const mod = await import(modulePath);
  const runner = mod?.[exportName];
  if (typeof runner !== 'function') {
    throw new Error(`Suite inválida: ${modulePath} no exporta ${exportName}.`);
  }
  await runner();
}

async function main() {
  for (const suite of SUITES) {
    await runSuite(suite);
  }
  execFileSync(process.execPath, ['__tests__/nutritionDomain.test.js'], {
    stdio: 'inherit',
    env: {
      ...process.env,
      DB_PATH:
        process.env.DB_PATH ||
        `/tmp/ufc-orchestrator-nutrition-tests-${Date.now()}.db`,
    },
  });
  console.log('All test suites passed.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
