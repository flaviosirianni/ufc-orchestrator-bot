import assert from 'node:assert/strict';
import { createRouterChain } from '../src/core/routerChain.js';
import { createConversationStore } from '../src/core/conversationStore.js';

export async function runRouterChainTests() {
  const tests = [];

  tests.push(async () => {
    const router = createRouterChain({
      bettingWizard: {
        async handleMessage(message) {
          return `BW:${message}`;
        },
      },
      sheetOps: { async handleMessage() { return 'SO'; } },
      fightsScalper: { async handleMessage() { return 'FS'; } },
      chain: {
        async invoke() {
          return { content: 'sheetOps' };
        },
      },
    });

    const response = await router.routeMessage('Need fight insights');
    assert.equal(response, 'BW:Need fight insights');
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
    });

    const response = await router.routeMessage('read Fight History!A:E');
    assert.equal(response, 'SO:read Fight History!A:E');
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
    });

    const response = await router.routeMessage('mostrame historial de Bautista');
    assert.equal(response, 'FS:mostrame historial de Bautista');
  });

  tests.push(async () => {
    const conversationStore = createConversationStore();
    conversationStore.setLastCard('chat-1', {
      eventName: 'UFC 312',
      date: '2026-02-07',
      fights: [
        { fighterA: 'Mario Bautista', fighterB: 'Vinicius Oliveira' },
        { fighterA: 'Fighter C', fighterB: 'Fighter D' },
      ],
    });

    let receivedMessage = null;
    const router = createRouterChain({
      conversationStore,
      bettingWizard: {
        async handleMessage(message, context) {
          receivedMessage = message;
          return { reply: 'ok', metadata: { resolvedFight: context.resolution.resolvedFight } };
        },
      },
      sheetOps: { async handleMessage() { return 'SO'; } },
      fightsScalper: { async handleMessage() { return 'FS'; } },
    });

    const response = await router.routeMessage({
      chatId: 'chat-1',
      message: 'que opinas de la pelea numero 1?',
    });

    assert.equal(response, 'ok');
    assert.match(receivedMessage, /Mario Bautista vs Vinicius Oliveira/);
  });

  tests.push(async () => {
    const conversationStore = createConversationStore();
    const router = createRouterChain({
      conversationStore,
      bettingWizard: {
        async handleMessage(message) {
          return `BW:${message}`;
        },
      },
      sheetOps: { async handleMessage() { return 'SO'; } },
      fightsScalper: { async handleMessage() { return 'FS'; } },
    });

    await router.routeMessage({ chatId: 'chat-2', message: 'hola, quien pelea el 7 de febrero' });
    const turns = conversationStore.getRecentTurns('chat-2', 2);
    assert.equal(turns.length, 2);
    assert.equal(turns[0].role, 'user');
    assert.equal(turns[1].role, 'assistant');
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
