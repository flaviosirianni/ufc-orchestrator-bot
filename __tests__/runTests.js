import { runRouterChainTests } from './routerChain.test.js';
import { runToolsHandlersTests } from './toolsHandlers.test.js';
import { runWebIntelToolTests } from './webIntelTool.test.js';

async function main() {
  await runRouterChainTests();
  await runToolsHandlersTests();
  await runWebIntelToolTests();
  console.log('All test suites passed.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
