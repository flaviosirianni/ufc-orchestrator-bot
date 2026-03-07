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
      responseWithText('El ultimo evento fue UFC 324.'),
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

    const result = await wizard.handleMessage('decime cual fue el ultimo evento de la ufc', {
      chatId: 'chat-3b',
      originalMessage: 'decime cual fue el ultimo evento de la ufc',
      resolution: {
        resolvedMessage: 'decime cual fue el ultimo evento de la ufc',
      },
    });

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

  tests.push(async () => {
    const conversationStore = createConversationStore();
    const fakeClient = createSequentialFakeClient([responseWithText('no debería usarse')]);

    const wizard = createBettingWizard({
      conversationStore,
      client: fakeClient,
      fightsScalper: {
        async getFighterHistory() {
          return { fighters: [], rows: [] };
        },
      },
      userStore: {
        undoLastBetMutation() {
          return {
            ok: true,
            undoneMutationId: 501,
            undoneAction: 'settle',
            receipt: {
              betId: 44,
              eventName: 'UFC FN',
              fight: 'A vs B',
              pick: 'Under 2.5',
              previousResult: 'loss',
              newResult: 'pending',
            },
          };
        },
      },
    });

    const result = await wizard.handleMessage('deshace la ultima accion', {
      chatId: 'chat-undo-1',
      userId: 'u-undo-1',
      originalMessage: 'deshace la ultima accion',
      resolution: {
        resolvedMessage: 'deshace la ultima accion',
      },
    });

    assert.match(result.reply, /Reversion aplicada/);
    assert.equal(fakeClient.calls.length, 0);
  });

  tests.push(async () => {
    const conversationStore = createConversationStore();
    const fakeClient = createSequentialFakeClient([
      responseWithFunctionCall(
        'mutate_user_bets',
        {
          operation: 'settle',
          result: 'loss',
        },
        'call_ambiguous_settle'
      ),
      responseWithText('Necesito bet_id para evitar errores.'),
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
        listUserBets() {
          return [{ id: 99, fight: 'A vs B', result: 'pending' }];
        },
        previewBetMutation() {
          previewCalls += 1;
          return { ok: true, operation: 'settle', candidates: [] };
        },
        applyBetMutation() {
          applyCalls += 1;
          return { ok: true, operation: 'settle', affectedCount: 1, receipts: [] };
        },
      },
    });

    const result = await wizard.handleMessage('marcala perdida, la anterior', {
      chatId: 'chat-amb-1',
      userId: 'u-amb-1',
      originalMessage: 'marcala perdida, la anterior',
      resolution: {
        resolvedMessage: 'marcala perdida, la anterior',
      },
    });

    assert.match(result.reply, /bet_id/i);
    assert.equal(previewCalls, 0);
    assert.equal(applyCalls, 0);
  });

  tests.push(async () => {
    const conversationStore = createConversationStore();
    const fakeClient = createSequentialFakeClient([responseWithText('Pick principal: Over 2.5 @1.90.')]);

    const wizard = createBettingWizard({
      conversationStore,
      client: fakeClient,
      fightsScalper: {
        async getFighterHistory() {
          return { fighters: [], rows: [] };
        },
      },
    });

    const result = await wizard.handleMessage('dame un pick para esta pelea', {
      chatId: 'chat-rationale-1',
      originalMessage: 'dame un pick para esta pelea',
      resolution: {
        resolvedMessage: 'dame un pick para esta pelea',
      },
    });

    assert.match(result.reply, /Fundamento de la elección/);
  });

  tests.push(async () => {
    const conversationStore = createConversationStore();
    const fakeClient = createSequentialFakeClient([
      responseWithText('Pick principal: Alex Pereira ganador.'),
    ]);

    const wizard = createBettingWizard({
      conversationStore,
      client: fakeClient,
      fightsScalper: {
        async getFighterHistory() {
          return { fighters: [], rows: [] };
        },
      },
    });

    const result = await wizard.handleMessage('dame un pick para esta pelea', {
      chatId: 'chat-quality-gate-1',
      originalMessage: 'dame un pick para esta pelea',
      resolution: {
        resolvedMessage: 'dame un pick para esta pelea',
      },
    });

    assert.match(result.reply, /Control de calidad/i);
    assert.match(result.reply, /NO_BET/i);
  });

  tests.push(async () => {
    const conversationStore = createConversationStore();
    const fakeClient = createSequentialFakeClient([
      responseWithText('No hay evento de UFC ahora mismo.', { includeWebSearch: true }),
    ]);

    const wizard = createBettingWizard({
      conversationStore,
      client: fakeClient,
      fightsScalper: {
        async getFighterHistory() {
          return { fighters: [], rows: [] };
        },
      },
    });

    const result = await wizard.handleMessage('hay evento de ufc ahora en vivo?', {
      chatId: 'chat-timeguard-1',
      originalMessage: 'hay evento de ufc ahora en vivo?',
      resolution: {
        resolvedMessage: 'hay evento de ufc ahora en vivo?',
      },
    });

    assert.match(result.reply, /Referencia temporal usada/);
  });

  tests.push(async () => {
    const conversationStore = createConversationStore();
    const fakeClient = createSequentialFakeClient([responseWithText('todo bien')]);

    const wizard = createBettingWizard({
      conversationStore,
      client: fakeClient,
      fightsScalper: {
        async getFighterHistory() {
          return { fighters: [], rows: [] };
        },
      },
      userStore: {
        getUserProfile() {
          return {
            bankroll: null,
            unitSize: null,
            riskProfile: null,
            currency: null,
            timezone: 'America/New_York',
            notes: '',
          };
        },
      },
    });

    await wizard.handleMessage('hola', {
      chatId: 'chat-tz-1',
      userId: 'u-tz-1',
      originalMessage: 'hola',
      resolution: {
        resolvedMessage: 'hola',
      },
    });

    assert.equal(
      fakeClient.calls[0]?.tools?.[0]?.user_location?.timezone,
      'America/New_York'
    );
  });

  tests.push(async () => {
    const conversationStore = createConversationStore();
    const fakeClient = createSequentialFakeClient([responseWithText('no debería ejecutarse')]);

    const wizard = createBettingWizard({
      conversationStore,
      client: fakeClient,
      fightsScalper: {
        async getFighterHistory() {
          return { fighters: [], rows: [] };
        },
      },
      userStore: {
        listUserBets() {
          return [
            {
              id: 33,
              eventName: 'UFC Fight Night: Moreno vs. Kavanagh (2026-02-28)',
              fight: 'Daniel Zellhuber vs King Green',
              result: 'pending',
            },
            {
              id: 34,
              eventName: 'UFC Fight Night: Moreno vs. Kavanagh (2026-02-28)',
              fight: 'Daniel Zellhuber vs King Green',
              result: 'pending',
            },
            {
              id: 35,
              eventName: 'UFC Fight Night: Moreno vs. Kavanagh (2026-02-28)',
              fight: 'Marlon Vera vs David Martinez',
              result: 'pending',
            },
          ];
        },
      },
    });

    const result = await wizard.handleMessage('que pelea viene ahora en el evento?', {
      chatId: 'chat-live-1',
      userId: 'u-live-1',
      originalMessage: 'que pelea viene ahora en el evento?',
      resolution: {
        resolvedMessage: 'que pelea viene ahora en el evento?',
      },
    });

    assert.match(result.reply, /Daniel Zellhuber vs King Green/);
    assert.match(result.reply, /2 apuesta\(s\) pending/);
    assert.equal(fakeClient.calls.length, 0);
  });

  tests.push(async () => {
    const conversationStore = createConversationStore();
    const fakeClient = createSequentialFakeClient([responseWithText('no debería ejecutarse')]);

    const wizard = createBettingWizard({
      conversationStore,
      client: fakeClient,
      fightsScalper: {
        async getFighterHistory() {
          return { fighters: [], rows: [] };
        },
      },
      userStore: {
        listUserBets() {
          return [
            {
              id: 40,
              eventName: 'UFC FN',
              fight: 'Fight A vs Fight B',
              result: 'pending',
            },
            {
              id: 41,
              eventName: 'UFC FN',
              fight: 'Fight C vs Fight D',
              result: 'pending',
            },
          ];
        },
      },
    });

    const result = await wizard.handleMessage('que pelea sigue ahora en el evento?', {
      chatId: 'chat-live-2',
      userId: 'u-live-2',
      originalMessage: 'que pelea sigue ahora en el evento?',
      resolution: {
        resolvedMessage: 'que pelea sigue ahora en el evento?',
      },
    });

    assert.match(result.reply, /más de una pelea candidata/i);
    assert.match(result.reply, /1\./);
    assert.equal(fakeClient.calls.length, 0);
  });

  tests.push(async () => {
    const conversationStore = createConversationStore();
    const fakeClient = createSequentialFakeClient([
      responseWithText(
        'Pick principal\n- Stake: **1.0u** (=$400 ARS)\n- Cuota: @2.90'
      ),
    ]);

    const wizard = createBettingWizard({
      conversationStore,
      client: fakeClient,
      fightsScalper: {
        async getFighterHistory() {
          return { fighters: [], rows: [] };
        },
      },
      userStore: {
        getUserProfile() {
          return {
            unitSize: 400,
            minStakeAmount: 2000,
            minUnitsPerBet: 2.5,
          };
        },
      },
    });

    const result = await wizard.handleMessage('dame un pick con stake', {
      chatId: 'chat-stake-cal-1',
      userId: 'u-stake-cal-1',
      originalMessage: 'dame un pick con stake',
      resolution: {
        resolvedMessage: 'dame un pick con stake',
      },
    });

    assert.match(result.reply, /5u/);
    assert.match(result.reply, /\$2\.000 ARS/);
    assert.match(result.reply, /Nota de staking/);
  });

  tests.push(async () => {
    const conversationStore = createConversationStore();
    const fakeClient = createSequentialFakeClient([
      responseWithText('Pick principal\n- Stake: 4u (=$2400 ARS)\n- Cuota: @2.10'),
    ]);

    const wizard = createBettingWizard({
      conversationStore,
      client: fakeClient,
      fightsScalper: {
        async getFighterHistory() {
          return { fighters: [], rows: [] };
        },
      },
      userStore: {
        getUserProfile() {
          return {
            bankroll: 120000,
            unitSize: 600,
            riskProfile: 'moderado',
            targetEventUtilizationPct: 35,
            minStakeAmount: 2000,
            minUnitsPerBet: 2.5,
            currency: 'ARS',
          };
        },
      },
    });

    const result = await wizard.handleMessage('dame un pick con stake', {
      chatId: 'chat-stake-budget-1',
      userId: 'u-stake-budget-1',
      originalMessage: 'dame un pick con stake',
      resolution: {
        resolvedMessage: 'dame un pick con stake',
      },
    });

    assert.match(result.reply, /Plan de evento/i);
    assert.match(result.reply, /presupuesto objetivo/i);
    assert.match(result.reply, /Remanente estimado/i);
  });

  tests.push(async () => {
    const conversationStore = createConversationStore();
    const fakeClient = createSequentialFakeClient([
      responseWithText('Pick principal\n- Stake: 1u (=$500 ARS)\n- Cuota: @2.10'),
    ]);

    const wizard = createBettingWizard({
      conversationStore,
      client: fakeClient,
      fightsScalper: {
        async getFighterHistory() {
          return { fighters: [], rows: [] };
        },
      },
      userStore: {
        getUserProfile() {
          return {
            bankroll: 10000,
            unitSize: 500,
            riskProfile: 'moderado',
            targetEventUtilizationPct: 10,
            minStakeAmount: 2000,
            minUnitsPerBet: 3,
            currency: 'ARS',
          };
        },
      },
    });

    const result = await wizard.handleMessage('dame un pick con stake', {
      chatId: 'chat-stake-conflict-1',
      userId: 'u-stake-conflict-1',
      originalMessage: 'dame un pick con stake',
      resolution: {
        resolvedMessage: 'dame un pick con stake',
      },
    });

    assert.match(result.reply, /NO_BET sugerido/i);
    assert.match(result.reply, /piso de stake/i);
  });

  tests.push(async () => {
    const conversationStore = createConversationStore();
    const fakeClient = createSequentialFakeClient([responseWithText('no debería ejecutarse')]);
    let receivedUpdates = null;

    const wizard = createBettingWizard({
      conversationStore,
      client: fakeClient,
      fightsScalper: {
        async getFighterHistory() {
          return { fighters: [], rows: [] };
        },
      },
      userStore: {
        updateUserProfile(_userId, updates) {
          receivedUpdates = updates;
          return {
            unitSize: 400,
            minStakeAmount: updates.minStakeAmount,
            minUnitsPerBet: updates.minUnitsPerBet,
          };
        },
      },
    });

    const result = await wizard.handleMessage('mi stake minimo es $3000 y minimo 4u por pick', {
      chatId: 'chat-stake-pref-1',
      userId: 'u-stake-pref-1',
      originalMessage: 'mi stake minimo es $3000 y minimo 4u por pick',
      resolution: {
        resolvedMessage: 'mi stake minimo es $3000 y minimo 4u por pick',
      },
    });

    assert.deepEqual(receivedUpdates, { minStakeAmount: 3000, minUnitsPerBet: 4 });
    assert.match(result.reply, /Perfil de staking actualizado/);
    assert.equal(fakeClient.calls.length, 0);
  });

  tests.push(async () => {
    const conversationStore = createConversationStore();
    const fakeClient = createSequentialFakeClient([
      responseWithFunctionCall(
        'mutate_user_bets',
        {
          operation: 'archive',
        },
        'call-archive-direct'
      ),
      responseWithText('Hecho, archivada sin confirmación extra.'),
    ]);

    let previewPayload = null;
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
          previewPayload = payload;
          return {
            ok: true,
            operation: 'archive',
            requiresConfirmation: false,
            candidates: [{ id: 35, result: 'pending' }],
          };
        },
        applyBetMutation() {
          applyCalls += 1;
          return {
            ok: true,
            operation: 'archive',
            affectedCount: 1,
            receipts: [{ betId: 35, previousResult: 'pending', newResult: 'pending' }],
          };
        },
      },
    });

    const result = await wizard.handleMessage('borra bet_id 35', {
      chatId: 'chat-archive-direct-1',
      userId: 'u-archive-direct-1',
      originalMessage: 'borra bet_id 35',
      resolution: {
        resolvedMessage: 'borra bet_id 35',
      },
    });

    assert.equal(Array.isArray(previewPayload?.betIds), true);
    assert.deepEqual(previewPayload.betIds, [35]);
    assert.equal(applyCalls, 1);
    assert.match(result.reply, /sin confirmación extra|sin confirmacion extra/i);
  });

  tests.push(async () => {
    const conversationStore = createConversationStore();
    const fakeClient = createSequentialFakeClient([
      responseWithFunctionCall(
        'mutate_user_bets',
        {
          operation: 'settle',
          result: 'LOST',
        },
        'call-settle-inferred-list'
      ),
      responseWithText('Listo, cierre aplicado.'),
    ]);

    let previewPayload = null;
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
          previewPayload = payload;
          return {
            ok: true,
            operation: 'settle',
            result: 'loss',
            requiresConfirmation: false,
            candidates: [
              { id: 3, result: 'pending' },
              { id: 4, result: 'pending' },
              { id: 5, result: 'pending' },
            ],
          };
        },
        applyBetMutation() {
          applyCalls += 1;
          return {
            ok: true,
            operation: 'settle',
            affectedCount: 3,
            receipts: [
              { betId: 3, previousResult: 'pending', newResult: 'loss' },
              { betId: 4, previousResult: 'pending', newResult: 'loss' },
              { betId: 5, previousResult: 'pending', newResult: 'loss' },
            ],
          };
        },
      },
    });

    await wizard.handleMessage('cerra las apuestas 3, 4 y 5 como perdidas', {
      chatId: 'chat-settle-list-1',
      userId: 'u-settle-list-1',
      originalMessage: 'cerra las apuestas 3, 4 y 5 como perdidas',
      resolution: {
        resolvedMessage: 'cerra las apuestas 3, 4 y 5 como perdidas',
      },
    });

    assert.deepEqual(previewPayload?.betIds, [3, 4, 5]);
    assert.equal(applyCalls, 1);
  });

  tests.push(async () => {
    const conversationStore = createConversationStore();
    const fakeClient = createSequentialFakeClient([responseWithText('no deberia ejecutarse')]);
    let receivedUpdates = null;

    const wizard = createBettingWizard({
      conversationStore,
      client: fakeClient,
      fightsScalper: {
        async getFighterHistory() {
          return { fighters: [], rows: [] };
        },
      },
      userStore: {
        updateUserProfile(_userId, updates) {
          receivedUpdates = updates;
          return {
            currency: 'ARS',
            minStakeAmount: 3000,
            minUnitsPerBet: 4,
            ...updates,
          };
        },
      },
    });

    const result = await wizard.handleMessage(
      'unidad 600, riesgo moderado, bankroll 120000, timezone America/Argentina/Buenos_Aires, utilizacion objetivo 35%',
      {
        chatId: 'chat-config-update-1',
        userId: 'u-config-update-1',
        originalMessage:
          'unidad 600, riesgo moderado, bankroll 120000, timezone America/Argentina/Buenos_Aires, utilizacion objetivo 35%',
        resolution: {
          resolvedMessage:
            'unidad 600, riesgo moderado, bankroll 120000, timezone America/Argentina/Buenos_Aires, utilizacion objetivo 35%',
        },
      }
    );

    assert.deepEqual(receivedUpdates, {
      bankroll: 120000,
      unitSize: 600,
      riskProfile: 'moderado',
      timezone: 'America/Argentina/Buenos_Aires',
      targetEventUtilizationPct: 35,
    });
    assert.match(result.reply, /Config actualizada/i);
    assert.match(result.reply, /Bankroll/i);
    assert.equal(fakeClient.calls.length, 0);
  });

  tests.push(async () => {
    const conversationStore = createConversationStore();
    const fakeClient = createSequentialFakeClient([responseWithText('no deberia ejecutarse')]);

    const wizard = createBettingWizard({
      conversationStore,
      client: fakeClient,
      fightsScalper: {
        async getFighterHistory() {
          return { fighters: [], rows: [] };
        },
      },
      userStore: {
        getUserProfile() {
          return {
            bankroll: 120000,
            unitSize: 600,
            riskProfile: 'moderado',
            currency: 'ARS',
            timezone: 'America/Argentina/Buenos_Aires',
            minStakeAmount: 3000,
            minUnitsPerBet: 4,
            targetEventUtilizationPct: 35,
          };
        },
      },
    });

    const result = await wizard.handleMessage('mostrame mi configuracion actual', {
      chatId: 'chat-config-view-1',
      userId: 'u-config-view-1',
      originalMessage: 'mostrame mi configuracion actual',
      resolution: {
        resolvedMessage: 'mostrame mi configuracion actual',
      },
    });

    assert.match(result.reply, /Config actual/);
    assert.match(result.reply, /Stake minimo/);
    assert.match(result.reply, /Timezone/);
    assert.equal(fakeClient.calls.length, 0);
  });

  tests.push(async () => {
    const conversationStore = createConversationStore();
    const fakeClient = createSequentialFakeClient([responseWithText('no deberia ejecutarse')]);
    let updateCalls = 0;

    const wizard = createBettingWizard({
      conversationStore,
      client: fakeClient,
      fightsScalper: {
        async getFighterHistory() {
          return { fighters: [], rows: [] };
        },
      },
      userStore: {
        updateUserProfile() {
          updateCalls += 1;
          return {};
        },
      },
    });

    const result = await wizard.handleMessage('timezone Marte/Phobos', {
      chatId: 'chat-config-tz-invalid-1',
      userId: 'u-config-tz-invalid-1',
      originalMessage: 'timezone Marte/Phobos',
      resolution: {
        resolvedMessage: 'timezone Marte/Phobos',
      },
    });

    assert.match(result.reply, /No pude aplicar cambios en Config/i);
    assert.match(result.reply, /timezone/i);
    assert.equal(updateCalls, 0);
    assert.equal(fakeClient.calls.length, 0);
  });

  tests.push(async () => {
    const conversationStore = createConversationStore();
    const fakeClient = createSequentialFakeClient([responseWithText('no deberia ejecutarse')]);

    const wizard = createBettingWizard({
      conversationStore,
      client: fakeClient,
      fightsScalper: {
        async getFighterHistory() {
          return { fighters: [], rows: [] };
        },
      },
      userStore: {
        getCreditState() {
          return {
            availableCredits: 7.5,
            freeCredits: 2,
            paidCredits: 5.5,
            weekId: '2026-W09',
          };
        },
        getUsageCounters() {
          return {
            imagesToday: 1,
            audioSecondsWeek: 180,
          };
        },
        listCreditTransactions() {
          return [
            {
              amount: 5,
              type: 'credit',
              reason: 'mercadopago_payment',
              createdAt: '2026-03-01T03:00:00.000Z',
            },
            {
              amount: -1,
              type: 'spend',
              reason: 'analysis',
              createdAt: '2026-03-01T03:30:00.000Z',
            },
          ];
        },
      },
    });

    const result = await wizard.handleMessage('cuantos creditos tengo?', {
      chatId: 'chat-credit-balance-1',
      userId: 'u-credit-balance-1',
      originalMessage: 'cuantos creditos tengo?',
      resolution: {
        resolvedMessage: 'cuantos creditos tengo?',
      },
    });

    assert.match(result.reply, /Estado de creditos/i);
    assert.match(result.reply, /Disponibles:\s*7\.50/);
    assert.match(result.reply, /Ultimos movimientos/i);
    assert.equal(fakeClient.calls.length, 0);
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
