import assert from 'node:assert/strict';
import { createBettingWizard } from '../src/agents/bettingWizard.js';
import { createConversationStore } from '../src/core/conversationStore.js';

function createSequentialFakeClient(responses = []) {
  const calls = [];
  let index = 0;

  return {
    calls,
    responses: {
      async create(payload) {
        calls.push(JSON.parse(JSON.stringify(payload)));
        const next = responses[index] ?? responses[responses.length - 1];
        index += 1;
        return next;
      },
    },
  };
}

function responseWithFunctionCall(name, args, callId = 'call_1') {
  return {
    id: `resp_${callId}`,
    output_text: '',
    output: [
      {
        type: 'function_call',
        name,
        call_id: callId,
        arguments: JSON.stringify(args || {}),
      },
    ],
  };
}

function responseWithText(text, { includeWebSearch = false, withCitation = false } = {}) {
  const message = {
    type: 'message',
    role: 'assistant',
    content: [
      {
        type: 'output_text',
        text,
        annotations: withCitation
          ? [
              {
                type: 'url_citation',
                title: 'UFC Events',
                url: 'https://www.ufc.com/events',
              },
            ]
          : [],
      },
    ],
  };

  const output = includeWebSearch
    ? [
        {
          type: 'web_search_call',
          id: 'ws_1',
          status: 'completed',
          action: {
            type: 'search',
            query: 'ufc next event',
            sources: [
              {
                type: 'url',
                title: 'UFC Events',
                url: 'https://www.ufc.com/events',
              },
            ],
          },
        },
        message,
      ]
    : [message];

  return {
    id: 'resp_text',
    output_text: text,
    output,
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
      responseWithFunctionCall('get_fighter_history', {
        fighters: ['Mario Bautista', 'Vinicius Oliveira'],
        strict: true,
      }),
      responseWithText('Pick preliminar: Mario Bautista por decision.'),
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

    assert.match(result.reply, /Pick preliminar/);
    assert.deepEqual(capturedHistoryArgs.fighters, [
      'Mario Bautista',
      'Vinicius Oliveira',
    ]);
    assert.equal(capturedHistoryArgs.strict, true);
    assert.equal(fakeClient.calls.length, 2);
    assert.match(fakeClient.calls[0].input, /CONVERSATION_CONTEXT/);
  });

  tests.push(async () => {
    const conversationStore = createConversationStore();
    const fakeClient = createSequentialFakeClient([
      responseWithFunctionCall('set_event_card', {
        eventName: 'UFC 312',
        date: '2026-02-07',
        fights: [
          { fighterA: 'Mario Bautista', fighterB: 'Vinicius Oliveira' },
          { fighterA: 'Umar Nurmagomedov', fighterB: 'Mike Davis' },
        ],
      }, 'call_card'),
      responseWithText('El proximo evento es UFC 312.', {
        includeWebSearch: true,
        withCitation: true,
      }),
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
    });

    const result = await wizard.handleMessage('quien pelea en el evento que viene de la ufc', {
      chatId: 'chat-2',
      originalMessage: 'quien pelea en el evento que viene de la ufc',
      resolution: {
        resolvedMessage: 'quien pelea en el evento que viene de la ufc',
      },
    });

    assert.match(result.reply, /El proximo evento es UFC 312/);
    assert.doesNotMatch(result.reply, /Fuentes:/);
    const session = conversationStore.getSession('chat-2');
    assert.equal(session.lastCardFights.length, 2);
    assert.equal(session.lastEvent.eventName, 'UFC 312');
  });

  tests.push(async () => {
    const conversationStore = createConversationStore();
    const fakeClient = createSequentialFakeClient([
      responseWithText('El proximo evento es UFC 312.', {
        includeWebSearch: true,
        withCitation: true,
      }),
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
    });

    const result = await wizard.handleMessage(
      'cual es el proximo evento de ufc? pasame las fuentes',
      {
        chatId: 'chat-2b',
        originalMessage: 'cual es el proximo evento de ufc? pasame las fuentes',
        resolution: {
          resolvedMessage: 'cual es el proximo evento de ufc? pasame las fuentes',
        },
      }
    );

    assert.match(result.reply, /El proximo evento es UFC 312/);
    assert.match(result.reply, /Fuentes:/);
  });

  tests.push(async () => {
    const conversationStore = createConversationStore();
    const fakeClient = createSequentialFakeClient([
      responseWithText('El proximo evento es UFC 295...'),
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
