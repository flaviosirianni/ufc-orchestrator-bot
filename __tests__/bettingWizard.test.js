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

  tests.push(async () => {
    const conversationStore = createConversationStore();
    const fakeClient = createSequentialFakeClient([
      responseWithFunctionCall('mutate_user_bets', {
        operation: 'archive',
        fight: 'Anthony Hernandez vs Sean Strickland',
      }, 'call_mut_1'),
      responseWithText('Necesito confirmacion antes de archivar esas apuestas.'),
    ]);

    let previewCalls = 0;
    let applyCalls = 0;

    const wizard = createBettingWizard({
      conversationStore,
      client: fakeClient,
      fightsScalper: {
        async getFighterHistory() {
          return { fighters: [], rows: [] };
        },
      },
      userStore: {
        previewBetMutation() {
          previewCalls += 1;
          return {
            ok: true,
            operation: 'archive',
            requiresConfirmation: true,
            candidates: [
              {
                id: 101,
                eventName: 'UFC FN',
                fight: 'Anthony Hernandez vs Sean Strickland',
                pick: 'Under 4.5',
                result: 'pending',
              },
            ],
          };
        },
        applyBetMutation() {
          applyCalls += 1;
          return {
            ok: true,
            operation: 'archive',
            affectedCount: 1,
            receipts: [],
          };
        },
      },
    });

    const result = await wizard.handleMessage('borra esas apuestas pendientes', {
      chatId: 'chat-mut-1',
      userId: 'u-1',
      originalMessage: 'borra esas apuestas pendientes',
      resolution: {
        resolvedMessage: 'borra esas apuestas pendientes',
      },
    });

    assert.match(result.reply, /Necesito confirmacion/);
    assert.equal(previewCalls, 1);
    assert.equal(applyCalls, 0);
  });

  tests.push(async () => {
    const conversationStore = createConversationStore();
    const calls = [];
    let callIndex = 0;
    let capturedToken = '';
    let applyCalls = 0;

    const fakeClient = {
      calls,
      responses: {
        async create(payload) {
          calls.push(JSON.parse(JSON.stringify(payload)));
          callIndex += 1;

          if (callIndex === 1) {
            return responseWithFunctionCall('mutate_user_bets', {
              operation: 'settle',
              result: 'loss',
              fight: 'Anthony Hernandez vs Sean Strickland',
            }, 'call_mut_preview');
          }

          if (callIndex === 2) {
            const output = payload.input?.[0]?.output;
            capturedToken = JSON.parse(output || '{}').confirmationToken || '';
            return responseWithText('Perfecto, confirmame y lo aplico.');
          }

          if (callIndex === 3) {
            return responseWithFunctionCall('mutate_user_bets', {
              operation: 'settle',
              result: 'loss',
              fight: 'Anthony Hernandez vs Sean Strickland',
              confirm: true,
              confirmationToken: capturedToken,
            }, 'call_mut_apply');
          }

          return responseWithText('Listo, ya quedo aplicado.');
        },
      },
    };

    const wizard = createBettingWizard({
      conversationStore,
      client: fakeClient,
      fightsScalper: {
        async getFighterHistory() {
          return { fighters: [], rows: [] };
        },
      },
      userStore: {
        previewBetMutation() {
          return {
            ok: true,
            operation: 'settle',
            requiresConfirmation: true,
            result: 'loss',
            candidates: [
              {
                id: 300,
                eventName: 'UFC FN',
                fight: 'Anthony Hernandez vs Sean Strickland',
                pick: 'Under 4.5',
                result: 'pending',
              },
            ],
          };
        },
        applyBetMutation() {
          applyCalls += 1;
          return {
            ok: true,
            operation: 'settle',
            affectedCount: 1,
            receipts: [
              {
                action: 'settle',
                betId: 300,
                newResult: 'loss',
              },
            ],
          };
        },
      },
    });

    await wizard.handleMessage('marcalas como perdidas', {
      chatId: 'chat-mut-2',
      userId: 'u-2',
      originalMessage: 'marcalas como perdidas',
      resolution: {
        resolvedMessage: 'marcalas como perdidas',
      },
    });

    const result = await wizard.handleMessage('confirmo', {
      chatId: 'chat-mut-2',
      userId: 'u-2',
      originalMessage: 'confirmo',
      resolution: {
        resolvedMessage: 'confirmo',
      },
    });

    assert.match(result.reply, /Confirmación aplicada/);
    assert.ok(capturedToken);
    assert.equal(applyCalls, 1);
    assert.equal(calls.length, 2);
  });

  tests.push(async () => {
    const conversationStore = createConversationStore();
    const fakeClient = createSequentialFakeClient([
      responseWithFunctionCall('record_user_bet', {
        fight: 'Anthony Hernandez vs Sean Strickland',
        pick: 'Under 4.5',
        result: 'LOST',
      }, 'call_legacy_settle'),
      responseWithText('Necesito confirmacion para cerrar esa apuesta.'),
    ]);

    let previewCalls = 0;
    let createCalls = 0;

    const wizard = createBettingWizard({
      conversationStore,
      client: fakeClient,
      fightsScalper: {
        async getFighterHistory() {
          return { fighters: [], rows: [] };
        },
      },
      userStore: {
        addBetRecord() {
          createCalls += 1;
          return null;
        },
        previewBetMutation() {
          previewCalls += 1;
          return {
            ok: true,
            operation: 'settle',
            requiresConfirmation: true,
            result: 'loss',
            candidates: [{ id: 44, result: 'pending' }],
          };
        },
        applyBetMutation() {
          return { ok: true, operation: 'settle', affectedCount: 1, receipts: [] };
        },
      },
    });

    const result = await wizard.handleMessage('anotala como perdida', {
      chatId: 'chat-mut-3',
      userId: 'u-3',
      originalMessage: 'anotala como perdida',
      resolution: {
        resolvedMessage: 'anotala como perdida',
      },
    });

    assert.match(result.reply, /Necesito confirmacion/);
    assert.equal(previewCalls, 1);
    assert.equal(createCalls, 0);
  });

  tests.push(async () => {
    const conversationStore = createConversationStore();
    const fakeClient = createSequentialFakeClient([
      responseWithFunctionCall('mutate_user_bets', {
        operation: 'archive',
        fight: 'A vs B',
      }, 'call_multi_preview_1'),
      responseWithText('Preview archive listo'),
      responseWithFunctionCall('mutate_user_bets', {
        operation: 'settle',
        result: 'loss',
        fight: 'A vs B',
      }, 'call_multi_preview_2'),
      responseWithText('Preview settle listo'),
    ]);

    let previewCalls = 0;
    let applyCalls = 0;

    const wizard = createBettingWizard({
      conversationStore,
      client: fakeClient,
      fightsScalper: {
        async getFighterHistory() {
          return { fighters: [], rows: [] };
        },
      },
      userStore: {
        previewBetMutation(_userId, payload = {}) {
          previewCalls += 1;
          const operation = String(payload.operation || '');
          if (operation === 'archive') {
            return {
              ok: true,
              operation: 'archive',
              requiresConfirmation: true,
              candidates: [{ id: 11, result: 'pending' }],
            };
          }
          return {
            ok: true,
            operation: 'settle',
            result: 'loss',
            requiresConfirmation: true,
            candidates: [{ id: 22, result: 'pending' }],
          };
        },
        applyBetMutation(_userId, payload = {}) {
          applyCalls += 1;
          return {
            ok: true,
            operation: payload.operation || null,
            affectedCount: 1,
            receipts: [
              {
                betId: payload.operation === 'archive' ? 11 : 22,
                previousResult: payload.operation === 'archive' ? 'pending' : 'pending',
                newResult: payload.operation === 'archive' ? 'pending' : 'loss',
              },
            ],
          };
        },
      },
    });

    await wizard.handleMessage('previsualiza archivado', {
      chatId: 'chat-mut-4',
      userId: 'u-4',
      originalMessage: 'previsualiza archivado',
      resolution: {
        resolvedMessage: 'previsualiza archivado',
      },
    });

    await wizard.handleMessage('previsualiza cierre', {
      chatId: 'chat-mut-4',
      userId: 'u-4',
      originalMessage: 'previsualiza cierre',
      resolution: {
        resolvedMessage: 'previsualiza cierre',
      },
    });

    const result = await wizard.handleMessage('CONFIRMO', {
      chatId: 'chat-mut-4',
      userId: 'u-4',
      originalMessage: 'CONFIRMO',
      resolution: {
        resolvedMessage: 'CONFIRMO',
      },
    });

    assert.match(result.reply, /Confirmación aplicada/);
    assert.equal(previewCalls, 2);
    assert.equal(applyCalls, 2);
    // `CONFIRMO` should be handled deterministically without another model round.
    assert.equal(fakeClient.calls.length, 4);
  });

  tests.push(async () => {
    const conversationStore = createConversationStore();
    const fakeClient = createSequentialFakeClient([
      responseWithFunctionCall('mutate_user_bets', {
        operation: 'archive',
        fight: 'A vs B',
      }, 'call_multi_preview_3'),
      responseWithText('Preview archive listo'),
      responseWithFunctionCall('mutate_user_bets', {
        operation: 'settle',
        result: 'loss',
        fight: 'A vs B',
      }, 'call_multi_preview_4'),
      responseWithText('Preview settle listo'),
    ]);

    let applyCalls = 0;

    const wizard = createBettingWizard({
      conversationStore,
      client: fakeClient,
      fightsScalper: {
        async getFighterHistory() {
          return { fighters: [], rows: [] };
        },
      },
      userStore: {
        previewBetMutation(_userId, payload = {}) {
          const operation = String(payload.operation || '');
          if (operation === 'archive') {
            return {
              ok: true,
              operation: 'archive',
              requiresConfirmation: true,
              candidates: [{ id: 31, result: 'pending' }],
            };
          }
          return {
            ok: true,
            operation: 'settle',
            result: 'loss',
            requiresConfirmation: true,
            candidates: [{ id: 32, result: 'pending' }],
          };
        },
        applyBetMutation(_userId, payload = {}) {
          applyCalls += 1;
          return {
            ok: true,
            operation: payload.operation || null,
            affectedCount: 1,
            receipts: [{ betId: payload.operation === 'archive' ? 31 : 32 }],
          };
        },
      },
    });

    await wizard.handleMessage('previsualiza archivado 2', {
      chatId: 'chat-mut-5',
      userId: 'u-5',
      originalMessage: 'previsualiza archivado 2',
      resolution: {
        resolvedMessage: 'previsualiza archivado 2',
      },
    });

    await wizard.handleMessage('previsualiza cierre 2', {
      chatId: 'chat-mut-5',
      userId: 'u-5',
      originalMessage: 'previsualiza cierre 2',
      resolution: {
        resolvedMessage: 'previsualiza cierre 2',
      },
    });

    const result = await wizard.handleMessage(
      '- CONFIRMO ARCHIVAR 31\n- CONFIRMO LOST 32',
      {
        chatId: 'chat-mut-5',
        userId: 'u-5',
        originalMessage: '- CONFIRMO ARCHIVAR 31\n- CONFIRMO LOST 32',
        resolution: {
          resolvedMessage: '- CONFIRMO ARCHIVAR 31\n- CONFIRMO LOST 32',
        },
      }
    );

    assert.match(result.reply, /Confirmación aplicada/);
    assert.equal(applyCalls, 2);
    // Confirmation should be handled locally.
    assert.equal(fakeClient.calls.length, 4);
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
