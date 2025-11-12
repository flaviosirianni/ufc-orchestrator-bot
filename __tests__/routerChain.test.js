import assert from 'node:assert/strict';
import { createRouterChain, determineIntent, ROUTES } from '../src/core/routerChain.js';


async function runTests() {
  const tests = [];

  tests.push(async () => {
    const intent = determineIntent('please update the fights card');
    assert.equal(intent, ROUTES.UPDATE, 'update intent should be detected');
  });

  tests.push(async () => {
    const intent = determineIntent('any bet ideas for the weekend?');
    assert.equal(intent, ROUTES.BET, 'bet intent should be detected');
  });

  tests.push(async () => {
    const calls = [];
    const bettingWizard = {
      async generateBettingStrategy(options) {
        calls.push(options);
        return 'analysis result';
      },
    };

    const router = createRouterChain({
      sheetOps: {},
      fightsScalper: {},
      bettingWizard,
    });

    const response = await router.routeMessage('analyze the main event');
    assert.equal(response, 'analysis result', 'router should return betting wizard response');
    assert.deepEqual(calls[0], {
      message: 'analyze the main event',
      sheetId: process.env.SHEET_ID,
      range: 'Fights!A:E',
    });
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
