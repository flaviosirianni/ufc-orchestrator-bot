import assert from 'node:assert/strict';
import { createRouterChain } from '../src/core/routerChain.js';

export async function runRouterChainTests() {
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
      bettingWizard: { async handleMessage() { return 'BW'; } },
      sheetOps: {
        async handleMessage(message) {
          return `SO:${message}`;
        },
      },
      fightsScalper: { async handleMessage() { return 'FS'; } },
      chain: {
        async invoke() {
          return { content: 'sheetOps' };
        },
      },
    });

    const response = await router.routeMessage('read Fights!A:E');
    assert.equal(response, 'SO:read Fights!A:E');
  });

  tests.push(async () => {
    const router = createRouterChain({
      bettingWizard: { async handleMessage() { return 'BW'; } },
      sheetOps: { async handleMessage() { return 'SO'; } },
      fightsScalper: {
        async handleMessage(message) {
          return `FS:${message}`;
        },
      },
      chain: {
        async invoke() {
          return { content: 'fightsScalper' };
        },
      },
    });

    const response = await router.routeMessage('Pereira vs Ankalaev');
    assert.equal(response, 'FS:Pereira vs Ankalaev');
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

if (import.meta.url === `file://${process.argv[1]}`) {
  runRouterChainTests().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
