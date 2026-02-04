import { runRouterChainTests } from './routerChain.test.js';
import { runToolsHandlersTests } from './toolsHandlers.test.js';

async function main() {
  await runRouterChainTests();
  await runToolsHandlersTests();
  console.log('All test suites passed.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
