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
    assert.equal(response.text, 'BW:Need fight insights');
    assert.equal(response.replies, null);
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
    assert.equal(response.text, 'SO:read Fight History!A:E');
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
    assert.equal(response.text, 'FS:mostrame historial de Bautista');
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

    assert.equal(response.text, 'ok');
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

  tests.push(async () => {
    const router = createRouterChain({
      bettingWizard: {
        async handleMessage(message) {
          return `BW:${message}`;
        },
      },
      sheetOps: { async handleMessage() { return 'SO'; } },
      fightsScalper: {
        async handleMessage(message) {
          return `FS:${message}`;
        },
      },
    });

    const response = await router.routeMessage({
      chatId: 'chat-guided-history-1',
      message: 'mostrame mi historial de apuestas del ledger',
      guidedAction: 'ledger_list_history',
    });
    assert.equal(response.text, 'BW:mostrame mi historial de apuestas del ledger');
  });

  tests.push(async () => {
    const bettingWizard = {
      async handleMessage() {
        return {
          replies: [
            {
              text: 'Pelea 1: Prochazka vs Ulberg',
              replyMarkup: {
                inline_keyboard: [[{ text: '📝 Registrar', callback_data: 'qa:record_bet_for:fight_1' }]],
              },
            },
            {
              text: 'Pelea 2: Dern vs Robertson',
              replyMarkup: {
                inline_keyboard: [[{ text: '📝 Registrar', callback_data: 'qa:record_bet_for:fight_2' }]],
              },
            },
          ],
          metadata: {},
        };
      },
    };
    const router = createRouterChain({
      bettingWizard,
      conversationStore: createConversationStore(),
    });

    // Note: routerChain's parseRouteInput sets `metadata: input` (the whole
    // object), so guidedAction/user/chat must be top-level fields on the
    // input object -- not nested under a `metadata:` sub-key -- to match
    // how metadata.guidedAction/metadata.user/metadata.chat are actually
    // read inside routeMessage.
    const result = await router.routeMessage({
      chatId: 'chat-multi-1',
      message: 'proyecciones para el evento',
      guidedAction: 'ledger_list_pending',
      user: { id: '1' },
      chat: { id: 'chat-multi-1' },
    });

    assert.ok(Array.isArray(result.replies));
    assert.equal(result.replies.length, 2);
    assert.equal(result.replies[0].text, 'Pelea 1: Prochazka vs Ulberg');
    assert.equal(
      result.replies[0].replyMarkup.inline_keyboard[0][0].callback_data,
      'qa:record_bet_for:fight_1'
    );
    // The joined single-string `text` fallback should still be populated
    // for any caller that only reads `.text` (e.g. routeSyntheticAction).
    assert.ok(result.text.includes('Pelea 1: Prochazka vs Ulberg'));
    assert.ok(result.text.includes('Pelea 2: Dern vs Robertson'));
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
