import assert from 'node:assert/strict';
import { createBettingWizard } from '../src/agents/bettingWizard.js';
import { createConversationStore } from '../src/core/conversationStore.js';

function createFakeOpenAIClient() {
  const calls = [];
  return {
    calls,
    chat: {
      completions: {
        async create(payload) {
          calls.push(payload);
          return {
            choices: [
              {
                message: {
                  content: 'Pick preliminar: Mario Bautista por decisión.',
                },
              },
            ],
          };
        },
      },
    },
  };
}

export async function runBettingWizardTests() {
  const tests = [];

  tests.push(async () => {
    const conversationStore = createConversationStore();
    conversationStore.setLastCard('chat-1', {
      eventName: 'UFC 312',
      date: '2026-02-07',
      fights: [{ fighterA: 'Mario Bautista', fighterB: 'Vinicius Oliveira' }],
    });

    const fakeClient = createFakeOpenAIClient();
    let capturedHistoryArgs = null;

    const wizard = createBettingWizard({
      conversationStore,
      client: fakeClient,
      fightsScalper: {
        async getFighterHistory(args) {
          capturedHistoryArgs = args;
          return {
            fighters: ['Mario Bautista', 'Vinicius Oliveira'],
            rows: [
              ['2025-07-19', 'UFC 318', 'Vinicius Oliveira', 'Kyler Phillips'],
              ['2025-06-07', 'UFC 316', 'Mario Bautista', 'Patchy Mix'],
            ],
          };
        },
        getFightHistoryCacheStatus() {
          return { rowCount: 400 };
        },
      },
      webIntel: {
        async buildWebContextForMessage() {
          return null;
        },
      },
    });

    const resolution = conversationStore.resolveMessage(
      'chat-1',
      'que opinas de la pelea numero 1?'
    );

    const result = await wizard.handleMessage(resolution.resolvedMessage, {
      chatId: 'chat-1',
      originalMessage: 'que opinas de la pelea numero 1?',
      resolution,
    });

    assert.equal(result.reply, 'Pick preliminar: Mario Bautista por decisión.');
    assert.deepEqual(capturedHistoryArgs.fighters, [
      'Mario Bautista',
      'Vinicius Oliveira',
    ]);
    assert.equal(capturedHistoryArgs.strict, true);
    assert.equal(fakeClient.calls.length, 1);
    assert.match(
      fakeClient.calls[0].messages[fakeClient.calls[0].messages.length - 1].content,
      /CONVERSATION_CONTEXT/
    );
  });

  tests.push(async () => {
    const conversationStore = createConversationStore();
    const fakeClient = createFakeOpenAIClient();

    const wizard = createBettingWizard({
      conversationStore,
      client: fakeClient,
      fightsScalper: {
        async getFighterHistory() {
          return { fighters: [], rows: [] };
        },
        getFightHistoryCacheStatus() {
          return { rowCount: 100 };
        },
      },
      webIntel: {
        async buildWebContextForMessage() {
          return {
            date: '2026-02-07',
            eventName: 'UFC 312',
            fights: [
              { fighterA: 'Mario Bautista', fighterB: 'Vinicius Oliveira' },
              { fighterA: 'Umar Nurmagomedov', fighterB: 'Mike Davis' },
            ],
            contextText: 'Main card estimada...',
          };
        },
      },
    });

    const result = await wizard.handleMessage('quien pelea el 7 de febrero', {
      chatId: 'chat-2',
      originalMessage: 'quien pelea el 7 de febrero',
      resolution: {
        resolvedMessage: 'quien pelea el 7 de febrero',
      },
    });

    assert.equal(result.reply, 'Pick preliminar: Mario Bautista por decisión.');
    const session = conversationStore.getSession('chat-2');
    assert.equal(session.lastCardFights.length, 2);
    assert.equal(session.lastEvent.eventName, 'UFC 312');
  });

  for (const test of tests) {
    await test();
  }

  console.log('All bettingWizard tests passed.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runBettingWizardTests().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
