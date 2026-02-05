import assert from 'node:assert/strict';
import { createBettingWizard } from '../src/agents/bettingWizard.js';
import { createConversationStore } from '../src/core/conversationStore.js';

function createSequentialFakeClient(responses = []) {
  const calls = [];
  let index = 0;

  return {
    calls,
    chat: {
      completions: {
        async create(payload) {
          calls.push(JSON.parse(JSON.stringify(payload)));
          const next = responses[index] ?? responses[responses.length - 1];
          index += 1;
          return next;
        },
      },
    },
  };
}

function toolCall(name, args, id = 'call_1') {
  return {
    id,
    type: 'function',
    function: {
      name,
      arguments: JSON.stringify(args || {}),
    },
  };
}

function completionWithTool(name, args) {
  return {
    choices: [
      {
        message: {
          content: '',
          tool_calls: [toolCall(name, args)],
        },
      },
    ],
  };
}

function completionWithText(text) {
  return {
    choices: [
      {
        message: {
          content: text,
        },
      },
    ],
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

    const fakeClient = createSequentialFakeClient([
      completionWithTool('get_fighter_history', {
        fighters: ['Mario Bautista', 'Vinicius Oliveira'],
        strict: true,
      }),
      completionWithText('Pick preliminar: Mario Bautista por decision.'),
    ]);

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

    assert.equal(result.reply, 'Pick preliminar: Mario Bautista por decision.');
    assert.deepEqual(capturedHistoryArgs.fighters, [
      'Mario Bautista',
      'Vinicius Oliveira',
    ]);
    assert.equal(capturedHistoryArgs.strict, true);
    assert.equal(fakeClient.calls.length, 2);
    assert.match(
      fakeClient.calls[0].messages[fakeClient.calls[0].messages.length - 1].content,
      /CONVERSATION_CONTEXT/
    );
  });

  tests.push(async () => {
    const conversationStore = createConversationStore();
    const fakeClient = createSequentialFakeClient([
      completionWithTool('resolve_event_card', {
        query: 'quien pelea en el evento que viene de la ufc',
      }),
      completionWithText('El proximo evento es UFC 312 y el main incluye Bautista vs Oliveira.'),
    ]);

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
            headlines: [],
            confidence: 'medium',
            contextText: 'Main card estimada...',
          };
        },
      },
    });

    const result = await wizard.handleMessage('quien pelea en el evento que viene de la ufc', {
      chatId: 'chat-2',
      originalMessage: 'quien pelea en el evento que viene de la ufc',
      resolution: {
        resolvedMessage: 'quien pelea en el evento que viene de la ufc',
      },
    });

    assert.equal(
      result.reply,
      'El proximo evento es UFC 312 y el main incluye Bautista vs Oliveira.'
    );
    const session = conversationStore.getSession('chat-2');
    assert.equal(session.lastCardFights.length, 2);
    assert.equal(session.lastEvent.eventName, 'UFC 312');
  });

  tests.push(async () => {
    const conversationStore = createConversationStore();
    const fakeClient = createSequentialFakeClient([
      completionWithText('El proximo evento es UFC 295...'),
    ]);

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
          return null;
        },
      },
    });

    const result = await wizard.handleMessage(
      'me decis quien pelea en el evento que viene de la ufc?',
      {
        chatId: 'chat-3',
        originalMessage: 'me decis quien pelea en el evento que viene de la ufc?',
        resolution: {
          resolvedMessage: 'me decis quien pelea en el evento que viene de la ufc?',
        },
      }
    );

    assert.match(result.reply, /No pude validar en vivo la cartelera/);
    assert.equal(fakeClient.calls.length, 1);
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
