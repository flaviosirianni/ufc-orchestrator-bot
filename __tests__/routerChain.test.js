import assert from 'node:assert/strict';
import { createRouterChain } from '../src/core/routerChain.js';

async function runTests() {
  const tests = [];

  tests.push(async () => {
    const invokedWith = [];
    const router = createRouterChain({
      bettingWizard: {
        async handleMessage(message) {
          return `BW:${message}`;
        },
      },
      sheetOps: {
        async handleMessage() {
          return 'SheetOps';
        },
      },
      fightsScalper: {
        async handleMessage() {
          return 'FightsScalper';
        },
      },
      chain: {
        async invoke({ input }) {
          invokedWith.push(input);
          return { content: 'bettingWizard' };
        },
      },
    });

    const response = await router.routeMessage('Need fight insights');
    assert.equal(response, 'BW:Need fight insights');
    assert.equal(invokedWith[0], 'Need fight insights');
  });

  tests.push(async () => {
    const router = createRouterChain({
      chain: {
        async invoke() {
          return { content: 'unknownAgent' };
        },
      },
    });

    const response = await router.routeMessage('??');
    assert.equal(response, "I'm not sure which agent to use for that.");
  });

  for (const test of tests) {
    await test();
  }

  console.log('All routerChain tests passed.');
}

runTests().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
