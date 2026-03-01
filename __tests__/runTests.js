import { runRouterChainTests } from './routerChain.test.js';
import { runToolsHandlersTests } from './toolsHandlers.test.js';
import { runWebIntelToolTests } from './webIntelTool.test.js';
import { runConversationStoreTests } from './conversationStore.test.js';
import { runBettingWizardTests } from './bettingWizard.test.js';
import { runHistoryScraperTests } from './historyScraper.test.js';
import { runMessageFormatterTests } from './messageFormatter.test.js';
import { runAutoSettlementTests } from './autoSettlement.test.js';

async function main() {
  await runRouterChainTests();
  await runConversationStoreTests();
  await runToolsHandlersTests();
  await runWebIntelToolTests();
  await runHistoryScraperTests();
  await runAutoSettlementTests();
  await runBettingWizardTests();
  await runMessageFormatterTests();
  console.log('All test suites passed.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
