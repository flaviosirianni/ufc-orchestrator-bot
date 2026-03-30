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
      responseWithFunctionCall(
        'record_user_bet',
        {
          eventName: 'UFC 326',
          fight: 'Drew Dober vs Michael Johnson',
          pick: 'Dober por KO/TKO',
        },
        'call_record_missing_fields'
      ),
      responseWithText('Necesito cuota y stake para registrarla.'),
    ]);

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
      },
    });

    const result = await wizard.handleMessage('registrala en ledger', {
      chatId: 'chat-record-required-1',
      userId: 'u-record-required-1',
      originalMessage: 'registrala en ledger',
      resolution: {
        resolvedMessage: 'registrala en ledger',
      },
    });

    assert.match(result.reply, /cuota y stake|Necesito/i);
    assert.equal(createCalls, 0);
  });

  tests.push(async () => {
    const conversationStore = createConversationStore();
    const fakeClient = createSequentialFakeClient([
      responseWithFunctionCall(
        'record_user_bet',
        {
          eventName: 'UFC 326',
        },
        'call_record_from_screenshot'
      ),
      responseWithText(
        '{"eventName":"UFC 326","fight":"Drew Dober vs Michael Johnson","pick":"Drew Dober por KO, TKO o DQ","odds":"2.10","stake":"2000","units":"3.3"}'
      ),
      responseWithText('Listo, apuesta registrada con éxito.'),
    ]);

    let storedRecord = null;

    const wizard = createBettingWizard({
      conversationStore,
      client: fakeClient,
      fightsScalper: {
        async getFighterHistory() {
          return { fighters: [], rows: [] };
        },
      },
      userStore: {
        addBetRecord(_userId, record) {
          storedRecord = record;
          return {
            id: 39,
            ...record,
            result: record.result || 'pending',
          };
        },
      },
    });

    const result = await wizard.handleMessage('anotala en mi ledger', {
      chatId: 'chat-record-screenshot-1',
      userId: 'u-record-screenshot-1',
      originalMessage: 'anotala en mi ledger',
      resolution: {
        resolvedMessage: 'anotala en mi ledger',
      },
      inputItems: [
        {
          type: 'input_image',
          image_url: 'data:image/jpeg;base64,ZmFrZQ==',
        },
      ],
      mediaStats: {
        imageCount: 1,
        audioSeconds: 0,
      },
    });

    assert.match(result.reply, /registrada|Listo/i);
    assert.equal(storedRecord?.fight, 'Drew Dober vs Michael Johnson');
    assert.equal(storedRecord?.pick, 'Drew Dober por KO, TKO o DQ');
    assert.equal(storedRecord?.odds, 2.1);
    assert.equal(storedRecord?.stake, 2000);
  });

  tests.push(async () => {
    const conversationStore = createConversationStore();
    const fakeClient = createSequentialFakeClient([
      responseWithFunctionCall(
        'mutate_user_bets',
        {
          operation: 'settle',
          result: 'loss',
          fight: 'Drew Drover vs Michael Johnson',
        },
        'call_fuzzy_settle'
      ),
      responseWithText('Hecho.'),
    ]);

    const previewPayloads = [];
    let applyPayload = null;

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
              id: 39,
              eventName: 'UFC 326',
              fight: 'Drew Dober vs Michael Johnson',
              pick: 'Dober por KO/TKO',
              result: 'pending',
            },
          ];
        },
        previewBetMutation(_userId, payload = {}) {
          previewPayloads.push(payload);
          const betIds = Array.isArray(payload.betIds) ? payload.betIds : [];
          if (!betIds.length) {
            return {
              ok: false,
              error: 'no_matching_bets',
            };
          }
          return {
            ok: true,
            operation: 'settle',
            result: 'loss',
            requiresConfirmation: false,
            candidates: [{ id: 39, result: 'pending' }],
          };
        },
        applyBetMutation(_userId, payload = {}) {
          applyPayload = payload;
          return {
            ok: true,
            operation: 'settle',
            affectedCount: 1,
            receipts: [{ betId: 39, previousResult: 'pending', newResult: 'loss' }],
          };
        },
      },
    });

    const result = await wizard.handleMessage('cerrala como perdida: Drew Drover vs Michael Johnson', {
      chatId: 'chat-fuzzy-close-1',
      userId: 'u-fuzzy-close-1',
      originalMessage: 'cerrala como perdida: Drew Drover vs Michael Johnson',
      resolution: {
        resolvedMessage: 'cerrala como perdida: Drew Drover vs Michael Johnson',
      },
    });

    assert.match(result.reply, /Hecho|cerrada|aplicada/i);
    assert.equal(previewPayloads.length, 2);
    assert.deepEqual(previewPayloads[1].betIds, [39]);
    assert.deepEqual(applyPayload?.betIds, [39]);
  });

  tests.push(async () => {
    const conversationStore = createConversationStore();
    const fakeClient = createSequentialFakeClient([responseWithText('no debería ejecutarse')]);

    let refreshCalls = 0;

    const wizard = createBettingWizard({
      conversationStore,
      client: fakeClient,
      fightsScalper: {
        async getFighterHistory() {
          return { fighters: [], rows: [] };
        },
      },
      userStore: {
        async refreshLiveScores() {
          refreshCalls += 1;
          return { ok: true, upsertedCount: 1 };
        },
        listRecentOddsEvents() {
          return [
            {
              eventId: 'ufc_326',
              eventName: 'UFC 326',
              homeTeam: 'Drew Dober',
              awayTeam: 'Michael Johnson',
              commenceTime: '2026-03-08T01:00:00Z',
              completed: true,
              scores: [
                { name: 'Drew Dober', score: '1' },
                { name: 'Michael Johnson', score: '0' },
              ],
              lastScoresSyncAt: '2026-03-08T03:00:00Z',
            },
          ];
        },
      },
    });

    const result = await wizard.handleMessage(
      'fijate si sabes como salio Drew Dober vs Michael Johnson',
      {
        chatId: 'chat-result-live-1',
        userId: 'u-result-live-1',
        originalMessage: 'fijate si sabes como salio Drew Dober vs Michael Johnson',
        resolution: {
          resolvedMessage: 'fijate si sabes como salio Drew Dober vs Michael Johnson',
        },
      }
    );

    assert.match(result.reply, /fuente live prioritaria/i);
    assert.match(result.reply, /gano Drew Dober|ganó Drew Dober/i);
    assert.equal(refreshCalls, 1);
    assert.equal(fakeClient.calls.length, 0);
  });

  tests.push(async () => {
    const conversationStore = createConversationStore();
    const fakeClient = createSequentialFakeClient([
      responseWithText('Pick principal: Dober por KO @2.10'),
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

    const result = await wizard.handleMessage('cerrala como ganada', {
      chatId: 'chat-ledger-op-1',
      originalMessage: 'cerrala como ganada',
      resolution: {
        resolvedMessage: 'cerrala como ganada',
      },
    });

    assert.doesNotMatch(result.reply, /Fundamento de la elección/i);
    assert.doesNotMatch(result.reply, /Control de calidad/i);
  });

  tests.push(async () => {
    const conversationStore = createConversationStore();
    const fakeClient = createSequentialFakeClient([
      responseWithFunctionCall(
        'record_user_bet',
        {
          eventName: 'UFC FN',
          fight: 'Charles Johnson vs Bruno Silva',
          pick: 'Charles Johnson ML',
          odds: 1.62,
          stake: 2000,
          units: 5,
          result: 'pending',
        },
        'call_record_exposure_guard'
      ),
      responseWithText(
        [
          'Perfecto, ya la tengo registrada ✅',
          '',
          '🥊 Apuesta: Charles Johnson vs Bruno Silva',
          '• Pick: Charles Johnson ML',
          '• Cuota: @1.62',
          '• Stake: $2.000 ARS',
          '',
          'Si queres, decime si esta apuesta corresponde al mismo evento donde tenias "6 peleas restantes", asi te voy armando el plan de exposicion por pelea para no pasarnos de riesgo en la cartelera.',
          '',
          'Plan de evento: presupuesto objetivo $14.000 ARS (35% del bankroll).',
          'Comprometido en esta recomendacion: $5.080 ARS | Remanente estimado: $8.920 ARS.',
        ].join('\n')
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
        addBetRecord() {
          return {
            id: 43,
            eventName: 'UFC FN',
            fight: 'Charles Johnson vs Bruno Silva',
            pick: 'Charles Johnson ML',
            result: 'pending',
            updatedAt: '2026-03-15T00:01:00.000Z',
          };
        },
        listUserBets() {
          return [
            {
              id: 43,
              eventName: 'UFC FN',
              fight: 'Charles Johnson vs Bruno Silva',
              pick: 'Charles Johnson ML',
              result: 'pending',
            },
          ];
        },
      },
    });

    const result = await wizard.handleMessage(
      'Charles Johnson ML @1.62 stake 2000, registrala por favor',
      {
        chatId: 'chat-exposure-guard-1',
        userId: 'u-exposure-guard-1',
        originalMessage: 'Charles Johnson ML @1.62 stake 2000, registrala por favor',
        resolution: {
          resolvedMessage: 'Charles Johnson ML @1.62 stake 2000, registrala por favor',
        },
      }
    );

    assert.match(result.reply, /registrada/i);
    assert.doesNotMatch(result.reply, /6 peleas restantes/i);
    assert.doesNotMatch(result.reply, /plan de exposicion/i);
    assert.doesNotMatch(result.reply, /Comprometido en esta recomendacion/i);
    assert.doesNotMatch(result.reply, /Remanente estimado/i);
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
    const fakeClient = createSequentialFakeClient([
      responseWithFunctionCall(
        'mutate_user_bets',
        {
          transactionPolicy: 'all_or_nothing',
          steps: [
            { operation: 'settle', result: 'loss', betIds: [77] },
            { operation: 'archive', betIds: [78] },
          ],
        },
        'call-composite-apply-1'
      ),
      responseWithText('Listo, lote aplicado.'),
    ]);

    let previewCompositeCalls = 0;
    let applyCompositeCalls = 0;
    let capturedPreviewPayload = null;
    let capturedApplyPayload = null;

    const wizard = createBettingWizard({
      conversationStore,
      client: fakeClient,
      fightsScalper: {
        async getFighterHistory() {
          return { fighters: [], rows: [] };
        },
      },
      userStore: {
        previewCompositeBetMutations(_userId, payload = {}) {
          previewCompositeCalls += 1;
          capturedPreviewPayload = payload;
          return {
            ok: true,
            transactionPolicy: 'all_or_nothing',
            requiresConfirmation: false,
            stepResults: [
              { index: 0, ok: true, operation: 'settle', candidateCount: 1 },
              { index: 1, ok: true, operation: 'archive', candidateCount: 1 },
            ],
          };
        },
        applyCompositeBetMutations(_userId, payload = {}) {
          applyCompositeCalls += 1;
          capturedApplyPayload = payload;
          return {
            ok: true,
            transactionPolicy: 'all_or_nothing',
            affectedCount: 2,
            stepResults: [
              {
                index: 0,
                operation: 'settle',
                affectedCount: 1,
                receipts: [{ betId: 77, previousResult: 'pending', newResult: 'loss' }],
              },
              {
                index: 1,
                operation: 'archive',
                affectedCount: 1,
                receipts: [{ betId: 78, previousResult: 'pending', newResult: 'pending' }],
              },
            ],
            receipts: [
              { betId: 77, previousResult: 'pending', newResult: 'loss' },
              { betId: 78, previousResult: 'pending', newResult: 'pending' },
            ],
          };
        },
      },
    });

    const result = await wizard.handleMessage('cerra 77 como perdida y archiva 78', {
      chatId: 'chat-composite-apply-1',
      userId: 'u-composite-apply-1',
      originalMessage: 'cerra 77 como perdida y archiva 78',
      resolution: {
        resolvedMessage: 'cerra 77 como perdida y archiva 78',
      },
    });

    assert.match(result.reply, /lote aplicado|Listo/i);
    assert.equal(previewCompositeCalls, 1);
    assert.equal(applyCompositeCalls, 1);
    assert.equal(capturedPreviewPayload?.transactionPolicy, 'all_or_nothing');
    assert.equal(Array.isArray(capturedPreviewPayload?.steps), true);
    assert.equal(capturedApplyPayload?.confirm, true);
  });

  tests.push(async () => {
    const conversationStore = createConversationStore();
    const fakeClient = createSequentialFakeClient([
      responseWithFunctionCall(
        'mutate_user_bets',
        {
          transactionPolicy: 'all_or_nothing',
          steps: [
            { operation: 'settle', result: 'loss', fight: 'A vs B' },
            { operation: 'archive', fight: 'A vs B' },
          ],
        },
        'call-composite-confirm-1'
      ),
      responseWithText('Necesito confirmacion para aplicar el lote.'),
    ]);

    let previewCompositeCalls = 0;
    let applyCompositeCalls = 0;

    const wizard = createBettingWizard({
      conversationStore,
      client: fakeClient,
      fightsScalper: {
        async getFighterHistory() {
          return { fighters: [], rows: [] };
        },
      },
      userStore: {
        previewCompositeBetMutations() {
          previewCompositeCalls += 1;
          return {
            ok: true,
            transactionPolicy: 'all_or_nothing',
            requiresConfirmation: true,
            stepResults: [
              {
                index: 0,
                ok: true,
                operation: 'settle',
                requiresConfirmation: true,
                confirmationReason: 'bulk_state_change',
                candidateCount: 2,
                candidates: [{ id: 88 }, { id: 89 }],
              },
              {
                index: 1,
                ok: true,
                operation: 'archive',
                requiresConfirmation: true,
                confirmationReason: 'bulk_archive',
                candidateCount: 2,
                candidates: [{ id: 88 }, { id: 89 }],
              },
            ],
          };
        },
        applyCompositeBetMutations() {
          applyCompositeCalls += 1;
          return {
            ok: true,
            transactionPolicy: 'all_or_nothing',
            affectedCount: 4,
            stepResults: [
              { index: 0, operation: 'settle', affectedCount: 2, receipts: [] },
              { index: 1, operation: 'archive', affectedCount: 2, receipts: [] },
            ],
            receipts: [],
          };
        },
      },
    });

    await wizard.handleMessage('previsualiza cierre y archivo en lote', {
      chatId: 'chat-composite-confirm-1',
      userId: 'u-composite-confirm-1',
      originalMessage: 'previsualiza cierre y archivo en lote',
      resolution: {
        resolvedMessage: 'previsualiza cierre y archivo en lote',
      },
    });

    const result = await wizard.handleMessage('confirmo', {
      chatId: 'chat-composite-confirm-1',
      userId: 'u-composite-confirm-1',
      originalMessage: 'confirmo',
      resolution: {
        resolvedMessage: 'confirmo',
      },
    });

    assert.match(result.reply, /Confirmación aplicada|Confirmacion aplicada/i);
    assert.equal(previewCompositeCalls, 1);
    assert.equal(applyCompositeCalls, 1);
    assert.equal(fakeClient.calls.length, 2);
  });

  tests.push(async () => {
    const conversationStore = createConversationStore();
    const fakeClient = createSequentialFakeClient([
      responseWithFunctionCall(
        'mutate_user_bets',
        {
          transactionPolicy: 'all_or_nothing',
          steps: [
            { operation: 'settle', result: 'loss', betIds: [90] },
            { operation: 'archive', betIds: [9999] },
          ],
        },
        'call-composite-fail-1'
      ),
      responseWithText('No pude aplicar el lote.'),
    ]);

    let previewCompositeCalls = 0;
    let applyCompositeCalls = 0;

    const wizard = createBettingWizard({
      conversationStore,
      client: fakeClient,
      fightsScalper: {
        async getFighterHistory() {
          return { fighters: [], rows: [] };
        },
      },
      userStore: {
        previewCompositeBetMutations() {
          previewCompositeCalls += 1;
          return {
            ok: false,
            error: 'composite_preview_failed',
            failedStepIndex: 1,
            transactionPolicy: 'all_or_nothing',
            stepResults: [
              { index: 0, ok: true, operation: 'settle', candidateCount: 1 },
              { index: 1, ok: false, operation: 'archive', error: 'no_matching_bets' },
            ],
          };
        },
        applyCompositeBetMutations() {
          applyCompositeCalls += 1;
          return { ok: true };
        },
      },
    });

    const result = await wizard.handleMessage('cerra 90 y archiva 9999 en lote', {
      chatId: 'chat-composite-fail-1',
      userId: 'u-composite-fail-1',
      originalMessage: 'cerra 90 y archiva 9999 en lote',
      resolution: {
        resolvedMessage: 'cerra 90 y archiva 9999 en lote',
      },
    });

    assert.match(result.reply, /No pude aplicar el lote/i);
    assert.equal(previewCompositeCalls, 1);
    assert.equal(applyCompositeCalls, 0);
  });

  tests.push(async () => {
    const conversationStore = createConversationStore();
    const calls = [];
    let callIndex = 0;
    let observedToolError = null;
    let applySingleCalls = 0;

    const fakeClient = {
      calls,
      responses: {
        async create(payload) {
          calls.push(JSON.parse(JSON.stringify(payload)));
          callIndex += 1;

          if (callIndex === 1) {
            return responseWithFunctionCall(
              'mutate_user_bets',
              {
                transactionPolicy: 'all_or_nothing',
                steps: [
                  { operation: 'settle', result: 'loss', betIds: [301] },
                  { operation: 'archive', betIds: [302] },
                ],
              },
              'call-composite-no-atomic-store'
            );
          }

          const output = payload.input?.[0]?.output;
          const parsed = output ? JSON.parse(output) : {};
          observedToolError = parsed?.error || null;
          return responseWithText('No pude aplicar el lote por política atómica.');
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
        previewCompositeBetMutations() {
          return {
            ok: true,
            transactionPolicy: 'all_or_nothing',
            requiresConfirmation: false,
            stepResults: [
              { index: 0, ok: true, operation: 'settle', candidateCount: 1 },
              { index: 1, ok: true, operation: 'archive', candidateCount: 1 },
            ],
          };
        },
        applyBetMutation() {
          applySingleCalls += 1;
          return {
            ok: true,
            operation: 'settle',
            affectedCount: 1,
            receipts: [{ betId: 301, previousResult: 'pending', newResult: 'loss' }],
          };
        },
      },
    });

    const result = await wizard.handleMessage('ejecuta lote compuesto', {
      chatId: 'chat-composite-no-atomic-store',
      userId: 'u-composite-no-atomic-store',
      originalMessage: 'ejecuta lote compuesto',
      resolution: {
        resolvedMessage: 'ejecuta lote compuesto',
      },
    });

    assert.match(result.reply, /No pude aplicar el lote/i);
    assert.equal(observedToolError, 'composite_apply_requires_atomic_store_support');
    assert.equal(applySingleCalls, 0);
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
    const fakeClient = createSequentialFakeClient([
      responseWithFunctionCall(
        'mutate_user_bets',
        {
          operation: 'settle',
          result: 'loss',
        },
        'call_context_only_settle'
      ),
      responseWithText('Necesito selector explicito.'),
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
          return [{ id: 201, fight: 'Drew Dober vs Michael Johnson', result: 'pending' }];
        },
        previewBetMutation() {
          previewCalls += 1;
          return { ok: true, operation: 'settle', candidates: [{ id: 201 }] };
        },
        applyBetMutation() {
          applyCalls += 1;
          return { ok: true, operation: 'settle', affectedCount: 1, receipts: [] };
        },
      },
    });

    const result = await wizard.handleMessage('cerrala como perdida', {
      chatId: 'chat-context-guard-1',
      userId: 'u-context-guard-1',
      originalMessage: 'cerrala como perdida',
      resolution: {
        resolvedMessage: 'cerrala como perdida',
        resolvedFight: {
          fighterA: 'Drew Dober',
          fighterB: 'Michael Johnson',
        },
      },
    });

    assert.match(result.reply, /selector explicito|desambiguar|bet_id/i);
    assert.equal(previewCalls, 0);
    assert.equal(applyCalls, 0);
  });

  tests.push(async () => {
    const conversationStore = createConversationStore();
    const fakeClient = createSequentialFakeClient([responseWithText('no deberia ejecutarse')]);
    const applyPayloads = [];

    const wizard = createBettingWizard({
      conversationStore,
      client: fakeClient,
      fightsScalper: {
        async getFighterHistory() {
          return {
            fighters: ['Josh Emmett', 'Kevin Vallejos', 'Amanda Lemos', 'Gillian Robertson', 'Max Holloway', 'Charles Oliveira'],
            rows: [
              ['2026-03-15', 'UFC 999', 'Josh Emmett', 'Kevin Vallejos', '', 'Kevin Vallejos', 'Decision'],
              ['2026-03-15', 'UFC 999', 'Amanda Lemos', 'Gillian Robertson', '', 'Amanda Lemos', 'Decision'],
              ['2026-03-15', 'UFC 999', 'Max Holloway', 'Charles Oliveira', '', 'Charles Oliveira', 'KO/TKO'],
            ],
          };
        },
      },
      userStore: {
        listUserBets() {
          return [
            {
              id: 101,
              eventName: 'UFC 999',
              fight: 'Josh Emmett vs Kevin Vallejos',
              pick: 'Josh Emmett ganador',
              result: 'pending',
              createdAt: '2026-03-14T20:00:00.000Z',
            },
            {
              id: 102,
              eventName: 'UFC 999',
              fight: 'Josh Emmett vs Kevin Vallejos',
              pick: 'Kevin Vallejos ganador',
              result: 'pending',
              createdAt: '2026-03-14T20:00:00.000Z',
            },
            {
              id: 103,
              eventName: 'UFC 999',
              fight: 'Amanda Lemos vs Gillian Robertson',
              pick: 'Gillian Robertson por sumision',
              result: 'pending',
              createdAt: '2026-03-14T20:00:00.000Z',
            },
            {
              id: 104,
              eventName: 'UFC 999',
              fight: 'Max Holloway vs Charles Oliveira',
              pick: 'Charles Oliveira por sumision',
              result: 'pending',
              createdAt: '2026-03-14T20:00:00.000Z',
            },
          ];
        },
        previewCompositeBetMutations() {
          return {
            ok: true,
            transactionPolicy: 'all_or_nothing',
            requiresConfirmation: false,
            stepResults: [],
          };
        },
        applyCompositeBetMutations(_userId, payload = {}) {
          applyPayloads.push(payload);
          const steps = Array.isArray(payload.steps) ? payload.steps : [];
          const receipts = steps.map((step) => ({
            betId: step.betIds?.[0] || null,
            previousResult: 'pending',
            newResult: step.result || null,
            eventName: 'UFC 999',
            fight: 'N/D',
            pick: 'N/D',
          }));
          return {
            ok: true,
            transactionPolicy: 'all_or_nothing',
            affectedCount: receipts.length,
            stepResults: steps.map((step, index) => ({
              index,
              operation: step.operation,
              result: step.result,
              affectedCount: 1,
              receipts: receipts[index] ? [receipts[index]] : [],
            })),
            receipts,
          };
        },
      },
    });

    const first = await wizard.handleMessage(
      'te podes fijar como salieron esas peleas para cerrar las apuestas?',
      {
        chatId: 'chat-bulk-verified-settle-1',
        userId: 'u-bulk-verified-settle-1',
        originalMessage: 'te podes fijar como salieron esas peleas para cerrar las apuestas?',
        resolution: {
          resolvedMessage: 'te podes fijar como salieron esas peleas para cerrar las apuestas?',
        },
      }
    );

    assert.match(first.reply, /Verificadas para cierre:\s*4\s*\(WIN 1 \/ LOSS 3\)/i);
    assert.match(first.reply, /no voy a cerrar todo como ganado/i);
    const tokenMatch = first.reply.match(/confirmo\s+(mut_[a-z0-9]+)/i);
    assert.ok(tokenMatch?.[1]);
    assert.equal(fakeClient.calls.length, 0);

    const confirmMessage = `confirmo ${tokenMatch[1]}`;
    const second = await wizard.handleMessage(confirmMessage, {
      chatId: 'chat-bulk-verified-settle-1',
      userId: 'u-bulk-verified-settle-1',
      originalMessage: confirmMessage,
      resolution: {
        resolvedMessage: confirmMessage,
      },
    });

    assert.equal(applyPayloads.length, 1);
    const appliedSteps = Array.isArray(applyPayloads[0]?.steps) ? applyPayloads[0].steps : [];
    assert.equal(appliedSteps.length, 4);
    assert.deepEqual(
      appliedSteps.map((step) => ({ id: step.betIds?.[0], result: step.result })),
      [
        { id: 101, result: 'loss' },
        { id: 102, result: 'win' },
        { id: 103, result: 'loss' },
        { id: 104, result: 'loss' },
      ]
    );
    assert.match(second.reply, /Confirmación aplicada: 1 mutación/i);
  });

  tests.push(async () => {
    const conversationStore = createConversationStore();
    const fakeClient = createSequentialFakeClient([responseWithText('no deberia ejecutarse')]);
    let applyCalls = 0;

    const wizard = createBettingWizard({
      conversationStore,
      client: fakeClient,
      fightsScalper: {
        async getFighterHistory() {
          return {
            fighters: ['Fighter A', 'Fighter B'],
            rows: [],
          };
        },
      },
      userStore: {
        listUserBets() {
          return [
            {
              id: 201,
              fight: 'Fighter A vs Fighter B',
              pick: 'Fighter A ganador',
              result: 'pending',
              createdAt: '2026-03-14T20:00:00.000Z',
            },
          ];
        },
        applyCompositeBetMutations() {
          applyCalls += 1;
          return { ok: true, affectedCount: 0, receipts: [] };
        },
      },
    });

    const result = await wizard.handleMessage(
      'fijate como salieron y cerra mis apuestas pendientes',
      {
        chatId: 'chat-bulk-verified-settle-no-evidence-1',
        userId: 'u-bulk-verified-settle-no-evidence-1',
        originalMessage: 'fijate como salieron y cerra mis apuestas pendientes',
        resolution: {
          resolvedMessage: 'fijate como salieron y cerra mis apuestas pendientes',
        },
      }
    );

    assert.match(result.reply, /No pude verificar con confianza/i);
    assert.match(result.reply, /No voy a cerrarlas como ganadas sin evidencia/i);
    assert.equal(applyCalls, 0);
    assert.equal(fakeClient.calls.length, 0);
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
    const fakeClient = createSequentialFakeClient([
      responseWithFunctionCall(
        'get_fighter_history',
        {
          fighters: ['Michel Pereira'],
          strict: true,
        },
        'call-history-stale'
      ),
      responseWithText('Michel Pereira viene de ganar sus ultimas 4 peleas.'),
    ]);

    const wizard = createBettingWizard({
      conversationStore,
      client: fakeClient,
      fightsScalper: {
        async getFighterHistory() {
          return {
            fighters: ['Michel Pereira'],
            rows: [
              ['2023-11-11', 'UFC 295', 'Michel Pereira', 'Andre Petroski', '', 'Michel Pereira', 'KO'],
              ['2023-07-08', 'UFC FN', 'Michel Pereira', 'Santiago Ponzinibbio', '', 'Michel Pereira', 'KO'],
            ],
          };
        },
        getFightHistoryCacheStatus() {
          return {
            latestFightDate: '2023-11-11',
            sheetAgeDays: 860,
            potentialGap: true,
          };
        },
      },
    });

    const result = await wizard.handleMessage('analiza la forma de Michel Pereira', {
      chatId: 'chat-freshness-stale-1',
      originalMessage: 'analiza la forma de Michel Pereira',
      resolution: {
        resolvedMessage: 'analiza la forma de Michel Pereira',
      },
    });

    assert.match(result.reply, /Verificacion factual pendiente/i);
    assert.match(result.reply, /Ultimo registro historico detectado:\s*2023-11-11/i);
    assert.doesNotMatch(result.reply, /viene de ganar sus ultimas 4 peleas/i);
  });

  tests.push(async () => {
    const conversationStore = createConversationStore();
    const fakeClient = createSequentialFakeClient([
      responseWithFunctionCall(
        'get_fighter_history',
        {
          fighters: ['Michel Pereira'],
          strict: true,
        },
        'call-history-fresh'
      ),
      responseWithText('Michel Pereira viene de ganar sus ultimas 4 peleas.'),
    ]);

    const wizard = createBettingWizard({
      conversationStore,
      client: fakeClient,
      fightsScalper: {
        async getFighterHistory() {
          return {
            fighters: ['Michel Pereira'],
            rows: [
              ['2026-03-01', 'UFC 400', 'Michel Pereira', 'Rival A', '', 'Michel Pereira', 'DEC'],
              ['2026-01-18', 'UFC 399', 'Michel Pereira', 'Rival B', '', 'Michel Pereira', 'SUB'],
              ['2025-11-02', 'UFC 398', 'Michel Pereira', 'Rival C', '', 'Michel Pereira', 'KO'],
              ['2025-09-06', 'UFC 397', 'Michel Pereira', 'Rival D', '', 'Michel Pereira', 'DEC'],
            ],
          };
        },
        getFightHistoryCacheStatus() {
          return {
            latestFightDate: '2026-03-01',
            sheetAgeDays: 10,
            potentialGap: false,
          };
        },
      },
    });

    const result = await wizard.handleMessage('analiza la forma de Michel Pereira', {
      chatId: 'chat-freshness-fresh-1',
      originalMessage: 'analiza la forma de Michel Pereira',
      resolution: {
        resolvedMessage: 'analiza la forma de Michel Pereira',
      },
    });

    assert.match(result.reply, /viene de ganar sus ultimas 4 peleas/i);
    assert.doesNotMatch(result.reply, /Verificacion factual pendiente/i);
  });

  tests.push(async () => {
    const conversationStore = createConversationStore();
    const fakeClient = createSequentialFakeClient([
      responseWithText('No, viene de ganar sus ultimas 4 peleas y eso esta confirmado.'),
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

    const result = await wizard.handleMessage(
      'eso esta mal, Michel Pereira no viene de 4 victorias seguidas',
      {
        chatId: 'chat-contradiction-1',
        originalMessage: 'eso esta mal, Michel Pereira no viene de 4 victorias seguidas',
        resolution: {
          resolvedMessage: 'eso esta mal, Michel Pereira no viene de 4 victorias seguidas',
        },
      }
    );

    assert.match(result.reply, /posible contradiccion factica/i);
    assert.match(result.reply, /No voy a sostener el claim sin verificacion adicional/i);
    assert.match(result.reply, /hoy=\d{4}-\d{2}-\d{2}/i);
    assert.doesNotMatch(result.reply, /No, viene de ganar sus ultimas 4 peleas/i);
  });

  tests.push(async () => {
    const conversationStore = createConversationStore();
    const fakeClient = createSequentialFakeClient([
      responseWithText('La proxima cartelera es manana por la noche.', {
        includeWebSearch: true,
      }),
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

    const result = await wizard.handleMessage('que evento de ufc hay manana?', {
      chatId: 'chat-consistency-temporal-1',
      originalMessage: 'que evento de ufc hay manana?',
      resolution: {
        resolvedMessage: 'que evento de ufc hay manana?',
      },
    });

    assert.match(result.reply, /Referencia temporal:\s*hoy=\d{4}-\d{2}-\d{2}/i);
    assert.match(result.reply, /manana=\d{4}-\d{2}-\d{2}/i);
  });

  tests.push(async () => {
    const conversationStore = createConversationStore();
    const fakeClient = createSequentialFakeClient([responseWithText('fallback')]);
    const nowMs = Date.now();
    const commenceIso = new Date(nowMs - 30 * 60 * 1000).toISOString();
    const syncOddsIso = new Date(nowMs - 4 * 60 * 1000).toISOString();
    const syncScoresIso = new Date(nowMs - 2 * 60 * 1000).toISOString();

    const wizard = createBettingWizard({
      conversationStore,
      client: fakeClient,
      fightsScalper: {
        async getFighterHistory() {
          return { fighters: [], rows: [] };
        },
      },
      userStore: {
        getEventWatchState() {
          return {
            eventId: 'ufc_324_2026-04-18',
            eventName: 'UFC 324',
            eventDateUtc: '2026-04-18',
            mainCard: [],
            updatedAt: '2026-03-06T00:00:00Z',
          };
        },
        async resolveLiveEventContext() {
          return {
            eventName: 'UFC 326',
            date: '2026-03-07',
            source: 'ufc.com',
            fights: [
              { fighterA: 'Max Holloway', fighterB: 'Charles Oliveira' },
              { fighterA: 'Caio Borralho', fighterB: 'Reinier de Ridder' },
            ],
          };
        },
        listUpcomingOddsEvents() {
          return [];
        },
      },
    });

    const result = await wizard.handleMessage(
      'fijate online el evento que esta en vivo ahora mismo de la ufc',
      {
        chatId: 'chat-live-status-1',
        originalMessage: 'fijate online el evento que esta en vivo ahora mismo de la ufc',
        resolution: {
          resolvedMessage: 'fijate online el evento que esta en vivo ahora mismo de la ufc',
        },
      }
    );

    assert.match(result.reply, /Estado UFC en vivo/i);
    assert.match(result.reply, /UFC 326/);
    assert.doesNotMatch(result.reply, /Proyecciones para el evento/i);
    assert.equal(fakeClient.calls.length, 0);
  });

  tests.push(async () => {
    const conversationStore = createConversationStore();
    const fakeClient = createSequentialFakeClient([responseWithText('fallback')]);
    const nowMs = Date.now();
    const commenceIso = new Date(nowMs - 30 * 60 * 1000).toISOString();
    const syncOddsIso = new Date(nowMs - 4 * 60 * 1000).toISOString();
    const syncScoresIso = new Date(nowMs - 2 * 60 * 1000).toISOString();

    const wizard = createBettingWizard({
      conversationStore,
      client: fakeClient,
      fightsScalper: {
        async getFighterHistory() {
          return { fighters: [], rows: [] };
        },
      },
      userStore: {
        getEventWatchState() {
          return {
            eventId: 'ufc_324_2026-04-18',
            eventName: 'UFC 324',
            eventDateUtc: '2026-04-18',
            updatedAt: '2026-03-07T00:00:00Z',
          };
        },
        async resolveLiveEventContext() {
          return null;
        },
        listUpcomingOddsEvents() {
          return [];
        },
      },
    });

    const result = await wizard.handleMessage('hay evento de ufc ahora en vivo?', {
      chatId: 'chat-live-status-2',
      originalMessage: 'hay evento de ufc ahora en vivo?',
      resolution: {
        resolvedMessage: 'hay evento de ufc ahora en vivo?',
      },
    });

    assert.match(result.reply, /No pude confirmar un evento UFC en vivo/i);
    assert.match(result.reply, /Proximo evento en agenda/i);
    assert.doesNotMatch(result.reply, /Evento detectado: UFC 324/i);
    assert.equal(fakeClient.calls.length, 0);
  });

  tests.push(async () => {
    const conversationStore = createConversationStore();
    const fakeClient = createSequentialFakeClient([responseWithText('fallback')]);
    const nowMs = Date.now();
    const commenceIso = new Date(nowMs - 30 * 60 * 1000).toISOString();
    const syncOddsIso = new Date(nowMs - 4 * 60 * 1000).toISOString();
    const syncScoresIso = new Date(nowMs - 2 * 60 * 1000).toISOString();

    const wizard = createBettingWizard({
      conversationStore,
      client: fakeClient,
      fightsScalper: {
        async getFighterHistory() {
          return { fighters: [], rows: [] };
        },
      },
      userStore: {
        getEventWatchState() {
          return {
            eventId: 'ufc_324_2026-04-18',
            eventName: 'UFC 324',
            eventDateUtc: '2026-04-18',
            updatedAt: '2026-03-07T10:00:00Z',
          };
        },
        async resolveLiveEventContext() {
          return {
            eventName: 'UFC 324',
            date: '2026-04-18',
            source: 'open-web',
            fights: [{ fighterA: 'Gaethje', fighterB: 'Pimblett' }],
          };
        },
        listUpcomingOddsEvents() {
          return [
            {
              eventId: 'ufc_326_2026-03-08',
              eventName: 'UFC 326',
              commenceTime: commenceIso,
              homeTeam: 'Max Holloway',
              awayTeam: 'Charles Oliveira',
              completed: false,
              lastOddsSyncAt: syncOddsIso,
              updatedAt: syncOddsIso,
            },
            {
              eventId: 'ufc_326_2026-03-08',
              eventName: 'UFC 326',
              commenceTime: commenceIso,
              homeTeam: 'Caio Borralho',
              awayTeam: 'Reinier de Ridder',
              completed: false,
              lastOddsSyncAt: syncOddsIso,
              updatedAt: syncOddsIso,
            },
          ];
        },
        listRecentOddsEvents() {
          return [
            {
              eventId: 'ufc_326_2026-03-08',
              eventName: 'UFC 326',
              commenceTime: commenceIso,
              homeTeam: 'Max Holloway',
              awayTeam: 'Charles Oliveira',
              completed: false,
              scores: [{ name: 'Max Holloway', score: '0' }],
              lastScoresSyncAt: syncScoresIso,
              updatedAt: syncScoresIso,
            },
          ];
        },
        async refreshLiveScores() {
          return { ok: true, upsertedCount: 1 };
        },
      },
    });

    const result = await wizard.handleMessage('fijate online el evento en vivo de la ufc', {
      chatId: 'chat-live-status-reconcile-1',
      originalMessage: 'fijate online el evento en vivo de la ufc',
      resolution: {
        resolvedMessage: 'fijate online el evento en vivo de la ufc',
      },
    });

    assert.match(result.reply, /Estado UFC en vivo/i);
    assert.match(result.reply, /Evento detectado: UFC 326/i);
    assert.doesNotMatch(result.reply, /Evento detectado: UFC 324/i);
    assert.match(result.reply, /Fuente primaria: indice interno de odds\/scores/i);
    assert.equal(fakeClient.calls.length, 0);
  });

  tests.push(async () => {
    const conversationStore = createConversationStore();
    const fakeClient = createSequentialFakeClient([
      responseWithText('Pick principal: Max Holloway ML.'),
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
        getEventWatchState() {
          return {
            eventId: 'ufc_326_2026-03-07',
            eventName: 'UFC 326',
            eventDateUtc: '2026-03-07',
            updatedAt: '2026-03-07T20:00:00Z',
          };
        },
        listLatestBetScoringForEvent() {
          return [
            {
              eventId: 'ufc_326_2026-03-07',
              fightId: 'fight_2',
              fighterA: 'Max Holloway',
              fighterB: 'Charles Oliveira',
              marketKey: 'moneyline',
              selection: 'Max Holloway',
              recommendation: 'bet',
              edgePct: 5.4,
              confidencePct: 69,
              modelProbabilityPct: 58.2,
              impliedProbabilityPct: 52.8,
              riskLevel: 'medium',
              suggestedStakeUnits: 1.7,
            },
          ];
        },
        getLatestOddsSnapshot() {
          return null;
        },
      },
    });

    const result = await wizard.handleMessage('dame un pick para esta pelea', {
      chatId: 'chat-deterministic-pending-1',
      originalMessage: 'dame un pick para esta pelea',
      resolution: {
        resolvedMessage: 'dame un pick para esta pelea',
        resolvedFight: {
          fightId: 'fight_2',
          fighterA: 'Max Holloway',
          fighterB: 'Charles Oliveira',
        },
      },
    });

    assert.match(result.reply, /Ajuste deterministico pendiente/i);
    assert.match(result.reply, /Pick final bloqueado/i);
    assert.match(result.reply, /Formato sugerido/i);
  });

  tests.push(async () => {
    const conversationStore = createConversationStore();
    const fakeClient = createSequentialFakeClient([
      responseWithText('Pick principal: Max Holloway ML.'),
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
        getEventWatchState() {
          return {
            eventId: 'ufc_326_2026-03-07',
            eventName: 'UFC 326',
            eventDateUtc: '2026-03-07',
            updatedAt: '2026-03-07T20:00:00Z',
          };
        },
        listLatestBetScoringForEvent() {
          return [
            {
              eventId: 'ufc_326_2026-03-07',
              fightId: 'fight_2',
              fighterA: 'Max Holloway',
              fighterB: 'Charles Oliveira',
              marketKey: 'moneyline',
              selection: 'Max Holloway',
              recommendation: 'bet',
              edgePct: 5.4,
              confidencePct: 69,
              modelProbabilityPct: 58.2,
              impliedProbabilityPct: 52.8,
              riskLevel: 'medium',
              suggestedStakeUnits: 1.7,
            },
          ];
        },
        getLatestOddsSnapshot() {
          return null;
        },
      },
    });

    const result = await wizard.handleMessage('dame un pick para esta pelea, Holloway @2.10', {
      chatId: 'chat-deterministic-final-1',
      originalMessage: 'dame un pick para esta pelea, Holloway @2.10',
      resolution: {
        resolvedMessage: 'dame un pick para esta pelea, Holloway @2.10',
        resolvedFight: {
          fightId: 'fight_2',
          fighterA: 'Max Holloway',
          fighterB: 'Charles Oliveira',
        },
      },
    });

    assert.match(result.reply, /Ajuste deterministico \(cuota de tu bookie\)/i);
    assert.match(result.reply, /Cuota usuario: @2\.10/i);
    assert.match(result.reply, /Veredicto final:/i);
  });

  tests.push(async () => {
    const conversationStore = createConversationStore();
    const fakeClient = createSequentialFakeClient([
      responseWithText('Pick principal: Max Holloway ML.'),
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
        getEventWatchState() {
          return {
            eventId: 'ufc_326_2026-03-07',
            eventName: 'UFC 326',
            eventDateUtc: '2026-03-07',
            updatedAt: '2026-03-07T20:00:00Z',
          };
        },
        listLatestBetScoringForEvent() {
          return [
            {
              eventId: 'ufc_326_2026-03-07',
              fightId: 'fight_2',
              fighterA: 'Max Holloway',
              fighterB: 'Charles Oliveira',
              marketKey: 'moneyline',
              selection: 'Max Holloway',
              recommendation: 'bet',
              edgePct: 5.4,
              confidencePct: 69,
              modelProbabilityPct: 58.2,
              impliedProbabilityPct: 52.8,
              riskLevel: 'medium',
              suggestedStakeUnits: 1.7,
              booksCount: 2,
              inputs: {
                lineMovementPct: -6.2,
                marketAgreementPct: 48.5,
                dataWindowHours: 6.4,
              },
            },
          ];
        },
        getLatestOddsSnapshot() {
          return null;
        },
      },
    });

    const result = await wizard.handleMessage('dame un pick para esta pelea, Holloway @2.10', {
      chatId: 'chat-deterministic-hard-gate-1',
      originalMessage: 'dame un pick para esta pelea, Holloway @2.10',
      resolution: {
        resolvedMessage: 'dame un pick para esta pelea, Holloway @2.10',
        resolvedFight: {
          fightId: 'fight_2',
          fighterA: 'Max Holloway',
          fighterB: 'Charles Oliveira',
        },
      },
    });

    assert.match(result.reply, /Ajuste deterministico \(cuota de tu bookie\)/i);
    assert.match(result.reply, /Veredicto final: ⛔ NO_BET/i);
    assert.match(result.reply, /Gate mercado:/i);
    assert.match(result.reply, /Señales mercado:/i);
  });

  tests.push(async () => {
    const conversationStore = createConversationStore();
    const fakeClient = createSequentialFakeClient([
      responseWithText('Pick principal: Max Holloway ML.'),
      responseWithText(
        '{"eventName":"UFC 326","fighterA":"Max Holloway","fighterB":"Charles Oliveira","moneylineA":2.10,"moneylineB":1.75,"bookmaker":"bet365"}'
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
        getEventWatchState() {
          return {
            eventId: 'ufc_326_2026-03-07',
            eventName: 'UFC 326',
            eventDateUtc: '2026-03-07',
            updatedAt: '2026-03-07T20:00:00Z',
          };
        },
        listLatestBetScoringForEvent() {
          return [
            {
              eventId: 'ufc_326_2026-03-07',
              fightId: 'fight_2',
              fighterA: 'Max Holloway',
              fighterB: 'Charles Oliveira',
              marketKey: 'moneyline',
              selection: 'Max Holloway',
              recommendation: 'bet',
              edgePct: 5.4,
              confidencePct: 69,
              modelProbabilityPct: 58.2,
              impliedProbabilityPct: 52.8,
              riskLevel: 'medium',
              suggestedStakeUnits: 1.7,
            },
          ];
        },
        getLatestOddsSnapshot() {
          return null;
        },
      },
    });

    const result = await wizard.handleMessage('dame pick de la estelar', {
      chatId: 'chat-deterministic-media-1',
      originalMessage: 'dame pick de la estelar',
      inputItems: [
        {
          type: 'input_image',
          image_url: 'data:image/jpeg;base64,ZmFrZQ==',
        },
      ],
      mediaStats: {
        imageCount: 1,
        audioSeconds: 0,
      },
      resolution: {
        resolvedMessage: 'dame pick de la estelar',
        resolvedFight: {
          fightId: 'fight_2',
          fighterA: 'Max Holloway',
          fighterB: 'Charles Oliveira',
        },
      },
    });

    assert.match(result.reply, /Ajuste deterministico \(cuota de tu bookie\)/i);
    assert.match(result.reply, /Cuota usuario: @2\.10 \(media_extraida\)/i);
    assert.equal(fakeClient.calls.length, 2);
  });

  tests.push(async () => {
    const conversationStore = createConversationStore();
    const fakeClient = createSequentialFakeClient([
      responseWithText('Pick principal: Max Holloway ganador.'),
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
        getEventWatchState() {
          return {
            eventId: 'ufc_326_2026-03-07',
            eventName: 'UFC 326',
            eventDateUtc: '2026-03-07',
            mainCard: [],
            updatedAt: '2026-03-07T20:00:00Z',
          };
        },
        listLatestProjectionSnapshotsForEvent() {
          return [
            {
              eventId: 'ufc_326_2026-03-07',
              fightId: 'fight_2',
              fighterA: 'Max Holloway',
              fighterB: 'Charles Oliveira',
              predictedWinner: 'Max Holloway',
              confidencePct: 68,
              keyFactors: ['Consenso cuotas favorable en 5 casas'],
              createdAt: '2026-03-07T21:00:00Z',
            },
          ];
        },
        listLatestBetScoringForEvent() {
          return [
            {
              eventId: 'ufc_326_2026-03-07',
              fightId: 'fight_2',
              fighterA: 'Max Holloway',
              fighterB: 'Charles Oliveira',
              marketKey: 'moneyline',
              selection: 'Max Holloway',
              recommendation: 'bet',
              edgePct: 5.4,
              confidencePct: 69,
              riskLevel: 'medium',
            },
          ];
        },
        listLatestOddsMarketsForFight() {
          return [
            {
              bookmakerKey: 'draftkings',
              fetchedAt: '2026-03-07T22:00:00Z',
              outcomeAName: 'Max Holloway',
              outcomeAPrice: 1.78,
              outcomeBName: 'Charles Oliveira',
              outcomeBPrice: 2.06,
            },
            {
              bookmakerKey: 'fanduel',
              fetchedAt: '2026-03-07T22:01:00Z',
              outcomeAName: 'Max Holloway',
              outcomeAPrice: 1.8,
              outcomeBName: 'Charles Oliveira',
              outcomeBPrice: 2.02,
            },
          ];
        },
      },
    });

    const result = await wizard.handleMessage('dame un pick para esta pelea', {
      chatId: 'chat-precomputed-pick-1',
      originalMessage: 'dame un pick para esta pelea',
      resolution: {
        resolvedMessage: 'dame un pick para esta pelea',
        resolvedFight: {
          fightId: 'fight_2',
          fighterA: 'Max Holloway',
          fighterB: 'Charles Oliveira',
        },
      },
    });

    assert.match(result.reply, /Pick principal/);
    assert.match(fakeClient.calls[0]?.input || '', /\[PRECOMPUTED_PROJECTION\]/);
    assert.match(fakeClient.calls[0]?.input || '', /\[PRECOMPUTED_BET_SCORING\]/);
    assert.match(fakeClient.calls[0]?.input || '', /\[CACHED_ODDS_CONSENSUS\]/);
    assert.match(fakeClient.calls[0]?.input || '', /Max Holloway/);
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
    conversationStore.setLastCard('chat-event-budget-gate-1', {
      eventName: 'UFC 314',
      date: '2026-04-11',
      fights: [{ fighterA: 'Fighter A', fighterB: 'Fighter B' }],
    });
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
        getUserProfile() {
          return {
            currency: 'ARS',
          };
        },
        getActiveEventBudgetSession() {
          return null;
        },
        upsertEventBudgetSession() {
          return null;
        },
      },
    });

    const resolution = conversationStore.resolveMessage(
      'chat-event-budget-gate-1',
      'dame pick con stake para la pelea 1 @2.10'
    );
    const result = await wizard.handleMessage(resolution.resolvedMessage, {
      chatId: 'chat-event-budget-gate-1',
      userId: 'u-event-budget-gate-1',
      originalMessage: 'dame pick con stake para la pelea 1 @2.10',
      resolution,
    });

    assert.match(result.reply, /Antes de recomendar stake/i);
    assert.match(result.reply, /presupuesto evento/i);
    assert.equal(fakeClient.calls.length, 0);
  });

  tests.push(async () => {
    const conversationStore = createConversationStore();
    conversationStore.setLastCard('chat-event-budget-set-1', {
      eventName: 'UFC 314',
      date: '2026-04-11',
      fights: [
        { fighterA: 'Fighter A', fighterB: 'Fighter B' },
        { fighterA: 'Fighter C', fighterB: 'Fighter D' },
      ],
    });
    const fakeClient = createSequentialFakeClient([responseWithText('no debería ejecutarse')]);
    let upsertPayload = null;

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
          return { currency: 'ARS' };
        },
        upsertEventBudgetSession(_userId, payload = {}) {
          upsertPayload = payload;
          return {
            id: 14,
            eventName: payload.eventName,
            budgetAmount: payload.budgetAmount,
            currency: payload.currency || 'ARS',
          };
        },
        listUserBets() {
          return [
            {
              id: 20,
              eventName: 'UFC 314',
              stake: 2000,
              result: 'pending',
            },
          ];
        },
      },
    });

    const result = await wizard.handleMessage('presupuesto evento $10000', {
      chatId: 'chat-event-budget-set-1',
      userId: 'u-event-budget-set-1',
      originalMessage: 'presupuesto evento $10000',
      resolution: {
        resolvedMessage: 'presupuesto evento $10000',
      },
    });

    assert.equal(Number(upsertPayload?.budgetAmount), 10000);
    assert.match(result.reply, /Presupuesto de evento guardado/i);
    assert.match(result.reply, /Remanente estimado/i);
    assert.equal(fakeClient.calls.length, 0);
  });

  tests.push(async () => {
    const conversationStore = createConversationStore();
    conversationStore.setLastCard('chat-event-budget-cal-1', {
      eventName: 'UFC 314',
      date: '2026-04-11',
      fights: [
        { fighterA: 'Fighter A', fighterB: 'Fighter B' },
        { fighterA: 'Fighter C', fighterB: 'Fighter D' },
        { fighterA: 'Fighter E', fighterB: 'Fighter F' },
        { fighterA: 'Fighter G', fighterB: 'Fighter H' },
        { fighterA: 'Fighter I', fighterB: 'Fighter J' },
      ],
    });
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
            unitSize: 500,
            minStakeAmount: 500,
            minUnitsPerBet: 1,
            riskProfile: 'moderado',
            currency: 'ARS',
          };
        },
        getActiveEventBudgetSession() {
          return {
            id: 31,
            eventName: 'UFC 314',
            budgetAmount: 10000,
            currency: 'ARS',
          };
        },
        listUserBets() {
          return [
            {
              id: 30,
              eventName: 'UFC 314',
              stake: 3000,
              result: 'pending',
            },
          ];
        },
      },
    });

    const result = await wizard.handleMessage('dame un pick con stake', {
      chatId: 'chat-event-budget-cal-1',
      userId: 'u-event-budget-cal-1',
      originalMessage: 'dame un pick con stake',
      resolution: {
        resolvedMessage: 'dame un pick con stake',
      },
    });

    assert.match(result.reply, /Plan de evento: presupuesto activo \$10\.000 ARS/i);
    assert.match(result.reply, /Comprometido \(open \+ recomendacion\)/i);
    assert.match(result.reply, /Stake objetivo por pick/i);
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
        getEventWatchState() {
          return {
            eventId: 'ufc_fight_night_test_2026-03-14',
            eventName: 'UFC Fight Night: Test vs Test',
            eventDateUtc: '2026-03-14',
            updatedAt: '2026-03-07T10:00:00.000Z',
          };
        },
        listLatestRelevantNews() {
          return [
            {
              fighterName: 'Fighter A',
              title: 'Fighter A suffers injury during camp before UFC event',
              impactLevel: 'high',
              sourceDomain: 'espn.com',
              publishedAt: '2026-03-07T09:00:00.000Z',
              fetchedAt: '2026-03-07T10:00:00.000Z',
              url: 'https://espn.com/mma/story/test-news',
            },
          ];
        },
      },
    });

    const result = await wizard.handleMessage(
      'mostrame ultimas novedaes del proximo evento',
      {
        chatId: 'chat-intel-news-1',
        userId: 'u-intel-news-1',
        originalMessage: 'mostrame ultimas novedaes del proximo evento',
        resolution: {
          resolvedMessage: 'mostrame ultimas novedaes del proximo evento',
        },
      }
    );

    assert.match(result.reply, /Ultimas novedades/i);
    assert.match(result.reply, /Fighter A suffers injury/i);
    assert.match(result.reply, /espn\.com/i);
    assert.match(result.reply, /https:\/\/espn\.com\/mma\/story\/test-news/i);
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
        getEventWatchState() {
          return {
            eventId: 'ufc_999_2026-03-21',
            eventName: 'UFC 999',
            eventDateUtc: '2026-03-21',
            mainCard: [
              { fighterA: 'Alpha One', fighterB: 'Bravo Two' },
              { fighterA: 'Charlie Three', fighterB: 'Delta Four' },
            ],
            updatedAt: '2026-03-07T11:00:00.000Z',
          };
        },
        listLatestRelevantNews() {
          return [
            {
              fighterSlug: 'alpha_one',
              fighterName: 'Alpha One',
              title: 'Alpha One withdrawn after injury concern',
              impactLevel: 'high',
              confidenceScore: 90,
              publishedAt: '2026-03-07T09:00:00.000Z',
            },
            {
              fighterSlug: 'delta_four',
              fighterName: 'Delta Four',
              title: 'Delta Four fully fit and ready for UFC 999',
              impactLevel: 'medium',
              confidenceScore: 70,
              publishedAt: '2026-03-07T08:00:00.000Z',
            },
          ];
        },
        listLatestOddsMarketsForFight({ fighterA, fighterB }) {
          if (
            String(fighterA) === 'Alpha One' &&
            String(fighterB) === 'Bravo Two'
          ) {
            return [
              {
                bookmakerKey: 'draftkings',
                outcomeAName: 'Alpha One',
                outcomeAPrice: 1.82,
                outcomeBName: 'Bravo Two',
                outcomeBPrice: 2.04,
                fetchedAt: '2026-03-07T10:30:00.000Z',
              },
              {
                bookmakerKey: 'fanduel',
                outcomeAName: 'Alpha One',
                outcomeAPrice: 1.9,
                outcomeBName: 'Bravo Two',
                outcomeBPrice: 1.98,
                fetchedAt: '2026-03-07T10:31:00.000Z',
              },
            ];
          }
          return [];
        },
        listLatestBetScoringForEvent() {
          return [
            {
              eventId: 'ufc_999_2026-03-21',
              fightId: 'fight_alpha_bravo',
              fighterA: 'Alpha One',
              fighterB: 'Bravo Two',
              marketKey: 'moneyline',
              selection: 'Bravo Two',
              recommendation: 'bet',
              edgePct: 6.4,
              confidencePct: 68,
              riskLevel: 'medium',
              suggestedStakeUnits: 1.7,
              consensusOdds: 2.03,
              booksCount: 4,
              createdAt: '2026-03-07T12:00:00.000Z',
            },
            {
              eventId: 'ufc_999_2026-03-21',
              fightId: 'fight_alpha_bravo',
              fighterA: 'Alpha One',
              fighterB: 'Bravo Two',
              marketKey: 'method',
              selection: 'Bravo Two por decision',
              recommendation: 'lean',
              edgePct: 2.5,
              confidencePct: 58,
              riskLevel: 'high',
              suggestedStakeUnits: 0.8,
              consensusOdds: 3.15,
              booksCount: 3,
              createdAt: '2026-03-07T12:00:00.000Z',
            },
            {
              eventId: 'ufc_999_2026-03-21',
              fightId: 'fight_charlie_delta',
              fighterA: 'Charlie Three',
              fighterB: 'Delta Four',
              marketKey: 'total_rounds',
              selection: 'Over 2.5 rounds',
              recommendation: 'lean',
              edgePct: 2.2,
              confidencePct: 57,
              riskLevel: 'medium',
              suggestedStakeUnits: 0.7,
              consensusOdds: 1.92,
              booksCount: 3,
              createdAt: '2026-03-07T12:00:00.000Z',
            },
          ];
        },
      },
    });

    const result = await wizard.handleMessage('mostrame proyecciones para el proximo evento', {
      chatId: 'chat-intel-proj-1',
      userId: 'u-intel-proj-1',
      originalMessage: 'mostrame proyecciones para el proximo evento',
      resolution: {
        resolvedMessage: 'mostrame proyecciones para el proximo evento',
      },
    });

    assert.match(result.reply, /Proyecciones para el evento/i);
    assert.match(result.reply, /Alpha One vs Bravo Two/);
    assert.match(result.reply, /ventaja para Bravo Two/i);
    assert.match(result.reply, /Confianza:\s*\d+%/i);
    assert.match(result.reply, /Consenso bookies/i);
    assert.match(result.reply, /Recomendacion backend:/i);
    assert.match(result.reply, /Moneyline/i);
    assert.match(result.reply, /Oportunidades precomputadas/i);
    assert.equal(fakeClient.calls.length, 0);
  });

  tests.push(async () => {
    const conversationStore = createConversationStore();
    const fakeClient = createSequentialFakeClient([responseWithText('no deberia ejecutarse')]);
    const nowMs = Date.now();
    const commenceIso = new Date(nowMs - 25 * 60 * 1000).toISOString();
    const staleIso = new Date(nowMs - 2 * 60 * 1000).toISOString();

    const wizard = createBettingWizard({
      conversationStore,
      client: fakeClient,
      fightsScalper: {
        async getFighterHistory() {
          return { fighters: [], rows: [] };
        },
      },
      userStore: {
        getEventWatchState() {
          return {
            eventId: 'ufc_324_2026-04-18',
            eventName: 'UFC 324',
            eventDateUtc: '2026-04-18',
            mainCard: [
              { fightId: 'fight_1', fighterA: 'Gaethje', fighterB: 'Pimblett' },
              { fightId: 'fight_2', fighterA: 'Holloway', fighterB: 'Oliveira' },
            ],
            updatedAt: '2026-03-07T12:00:00.000Z',
          };
        },
        listUpcomingOddsEvents() {
          return [
            {
              eventId: 'ufc_326_2026-03-08',
              eventName: 'UFC 326',
              commenceTime: commenceIso,
              homeTeam: 'Max Holloway',
              awayTeam: 'Charles Oliveira',
              completed: false,
              lastOddsSyncAt: staleIso,
              updatedAt: staleIso,
            },
            {
              eventId: 'ufc_326_2026-03-08',
              eventName: 'UFC 326',
              commenceTime: commenceIso,
              homeTeam: 'Caio Borralho',
              awayTeam: 'Reinier de Ridder',
              completed: true,
              lastOddsSyncAt: staleIso,
              updatedAt: staleIso,
            },
          ];
        },
        listRecentOddsEvents() {
          return [
            {
              eventId: 'ufc_326_2026-03-08',
              eventName: 'UFC 326',
              commenceTime: commenceIso,
              homeTeam: 'Max Holloway',
              awayTeam: 'Charles Oliveira',
              completed: false,
              scores: [{ name: 'Max Holloway', score: '0' }],
              lastScoresSyncAt: staleIso,
              updatedAt: staleIso,
            },
            {
              eventId: 'ufc_326_2026-03-08',
              eventName: 'UFC 326',
              commenceTime: commenceIso,
              homeTeam: 'Caio Borralho',
              awayTeam: 'Reinier de Ridder',
              completed: true,
              scores: [{ name: 'Caio Borralho', score: '30' }],
              lastScoresSyncAt: staleIso,
              updatedAt: staleIso,
            },
          ];
        },
        async refreshLiveScores() {
          return { ok: true, upsertedCount: 2 };
        },
        listLatestRelevantNews() {
          return [];
        },
        listLatestProjectionSnapshotsForEvent({ eventId }) {
          if (eventId !== 'ufc_326_2026-03-08') return [];
          return [
            {
              eventId,
              fightId: 'fight_1',
              fighterA: 'Max Holloway',
              fighterB: 'Charles Oliveira',
              predictedWinner: 'Max Holloway',
              predictedMethod: 'decision_lean',
              confidencePct: 67,
              keyFactors: ['Consenso cuotas favorable'],
              createdAt: staleIso,
            },
            {
              eventId,
              fightId: 'fight_2',
              fighterA: 'Caio Borralho',
              fighterB: 'Reinier de Ridder',
              predictedWinner: 'Caio Borralho',
              predictedMethod: 'decision_lean',
              confidencePct: 64,
              keyFactors: ['Pelea ya finalizada'],
              createdAt: staleIso,
            },
          ];
        },
        listLatestBetScoringForEvent({ eventId }) {
          if (eventId !== 'ufc_326_2026-03-08') return [];
          return [
            {
              eventId,
              fightId: 'fight_1',
              fighterA: 'Max Holloway',
              fighterB: 'Charles Oliveira',
              marketKey: 'moneyline',
              selection: 'Max Holloway',
              recommendation: 'lean',
              edgePct: 2.2,
              confidencePct: 58,
              riskLevel: 'medium',
              suggestedStakeUnits: 0.9,
              consensusOdds: 2.03,
              booksCount: 3,
              createdAt: staleIso,
            },
          ];
        },
        listLatestOddsMarketsForFight({ fighterA, fighterB }) {
          if (fighterA === 'Max Holloway' && fighterB === 'Charles Oliveira') {
            return [
              {
                bookmakerKey: 'dk',
                outcomeAName: 'Max Holloway',
                outcomeAPrice: 2.03,
                outcomeBName: 'Charles Oliveira',
                outcomeBPrice: 1.82,
                fetchedAt: staleIso,
              },
            ];
          }
          return [];
        },
      },
    });

    const result = await wizard.handleMessage('mostrame proyecciones para el proximo evento', {
      chatId: 'chat-intel-proj-live-reconcile-1',
      userId: 'u-intel-proj-live-reconcile-1',
      originalMessage: 'mostrame proyecciones para el proximo evento',
      resolution: {
        resolvedMessage: 'mostrame proyecciones para el proximo evento',
      },
    });

    assert.match(result.reply, /Evento:\s*UFC 326/i);
    assert.doesNotMatch(result.reply, /Evento:\s*UFC 324/i);
    assert.match(result.reply, /Estado live: 1\/2 peleas cerradas/i);
    assert.match(result.reply, /Max Holloway vs Charles Oliveira/i);
    assert.doesNotMatch(result.reply, /Caio Borralho vs Reinier de Ridder/i);
    assert.equal(fakeClient.calls.length, 0);
  });

  tests.push(async () => {
    const conversationStore = createConversationStore();
    const fakeClient = createSequentialFakeClient([responseWithText('no deberia ejecutarse')]);
    const nowMs = Date.now();
    const liveEventDateIso = new Date(nowMs).toISOString().slice(0, 10);

    const wizard = createBettingWizard({
      conversationStore,
      client: fakeClient,
      fightsScalper: {
        async getFighterHistory() {
          return { fighters: [], rows: [] };
        },
      },
      userStore: {
        getEventWatchState() {
          return {
            eventId: 'ufc_324_2026-04-18',
            eventName: 'UFC 324',
            eventDateUtc: '2026-04-18',
            mainCard: [
              { fightId: 'fight_1', fighterA: 'Gaethje', fighterB: 'Pimblett' },
              { fightId: 'fight_2', fighterA: 'Holloway', fighterB: 'Oliveira' },
            ],
            updatedAt: '2026-03-07T12:00:00.000Z',
          };
        },
        listUpcomingOddsEvents() {
          return [];
        },
        listRecentOddsEvents() {
          return [];
        },
        async refreshLiveScores() {
          return { ok: true, upsertedCount: 0 };
        },
        async resolveLiveEventContext() {
          return {
            eventName: 'UFC 326',
            date: liveEventDateIso,
            source: 'open-web',
            fights: [
              {
                fighterA: 'Max Holloway',
                fighterB: 'Charles Oliveira',
              },
            ],
          };
        },
        listLatestRelevantNews() {
          return [];
        },
        listLatestProjectionSnapshotsForEvent({ eventId }) {
          if (eventId !== `ufc_326_${liveEventDateIso}`) return [];
          return [
            {
              eventId,
              fightId: 'fight_1',
              fighterA: 'Max Holloway',
              fighterB: 'Charles Oliveira',
              predictedWinner: 'Max Holloway',
              predictedMethod: 'decision_lean',
              confidencePct: 65,
              keyFactors: ['Contexto live reconciliado'],
              createdAt: new Date(nowMs - 5 * 60 * 1000).toISOString(),
            },
          ];
        },
        listLatestBetScoringForEvent() {
          return [];
        },
        listLatestOddsMarketsForFight() {
          return [];
        },
      },
    });

    const result = await wizard.handleMessage('mostrame proyecciones para el proximo evento', {
      chatId: 'chat-intel-proj-web-live-reconcile-1',
      userId: 'u-intel-proj-web-live-reconcile-1',
      originalMessage: 'mostrame proyecciones para el proximo evento',
      resolution: {
        resolvedMessage: 'mostrame proyecciones para el proximo evento',
      },
    });

    assert.match(result.reply, /Evento:\s*UFC 326/i);
    assert.doesNotMatch(result.reply, /Evento:\s*UFC 324/i);
    assert.match(result.reply, /reconciliado con contexto web live/i);
    assert.match(result.reply, /Max Holloway vs Charles Oliveira/i);
    assert.equal(fakeClient.calls.length, 0);
  });

  tests.push(async () => {
    const conversationStore = createConversationStore();
    const fakeClient = createSequentialFakeClient([responseWithText('no deberia ejecutarse')]);
    const todayIso = new Date().toISOString().slice(0, 10);

    const wizard = createBettingWizard({
      conversationStore,
      client: fakeClient,
      fightsScalper: {
        async getFighterHistory() {
          return { fighters: [], rows: [] };
        },
      },
      userStore: {
        getEventWatchState(watchKey = 'next_event') {
          if (watchKey === 'current_event') {
            return {
              eventId: `ufc_326_${todayIso}`,
              eventName: 'UFC 326',
              eventDateUtc: todayIso,
              mainCard: [
                {
                  fightId: 'fight_1',
                  fighterA: 'Max Holloway',
                  fighterB: 'Charles Oliveira',
                  isCompleted: false,
                },
                {
                  fightId: 'fight_2',
                  fighterA: 'Caio Borralho',
                  fighterB: 'Reinier de Ridder',
                  isCompleted: true,
                },
              ],
              updatedAt: new Date().toISOString(),
            };
          }
          return {
            eventId: 'ufc_324_2026-04-18',
            eventName: 'UFC 324',
            eventDateUtc: '2026-04-18',
            mainCard: [
              { fightId: 'fight_1', fighterA: 'Gaethje', fighterB: 'Pimblett' },
              { fightId: 'fight_2', fighterA: 'Holloway', fighterB: 'Oliveira' },
            ],
            updatedAt: '2026-03-07T12:00:00.000Z',
          };
        },
        listUpcomingOddsEvents() {
          return [];
        },
        listRecentOddsEvents() {
          return [];
        },
        async refreshLiveScores() {
          return { ok: true, upsertedCount: 0 };
        },
        listLatestRelevantNews() {
          return [];
        },
        listLatestProjectionSnapshotsForEvent({ eventId }) {
          if (eventId !== `ufc_326_${todayIso}`) return [];
          return [
            {
              eventId,
              fightId: 'fight_1',
              fighterA: 'Max Holloway',
              fighterB: 'Charles Oliveira',
              predictedWinner: 'Max Holloway',
              predictedMethod: 'decision_lean',
              confidencePct: 62,
              keyFactors: ['Persistencia de current_event'],
              createdAt: new Date().toISOString(),
            },
          ];
        },
        listLatestBetScoringForEvent() {
          return [];
        },
        listLatestOddsMarketsForFight() {
          return [];
        },
      },
    });

    const result = await wizard.handleMessage('mostrame proyecciones para el proximo evento', {
      chatId: 'chat-intel-proj-current-event-priority-1',
      userId: 'u-intel-proj-current-event-priority-1',
      originalMessage: 'mostrame proyecciones para el proximo evento',
      resolution: {
        resolvedMessage: 'mostrame proyecciones para el proximo evento',
      },
    });

    assert.match(result.reply, /Evento:\s*UFC 326/i);
    assert.doesNotMatch(result.reply, /Evento:\s*UFC 324/i);
    assert.match(result.reply, /Estado live: 1\/2 peleas cerradas/i);
    assert.match(result.reply, /Max Holloway vs Charles Oliveira/i);
    assert.doesNotMatch(result.reply, /Caio Borralho vs Reinier de Ridder/i);
    assert.equal(fakeClient.calls.length, 0);
  });

  tests.push(async () => {
    const realDateNow = Date.now;
    const fixedNowMs = Date.parse('2026-03-08T02:30:00.000Z');
    Date.now = () => fixedNowMs;
    try {
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
              timezone: 'America/Argentina/Buenos_Aires',
            };
          },
          getEventWatchState(watchKey = 'next_event') {
            if (watchKey === 'current_event') {
              return {
                eventId: 'ufc_999_2026-03-06',
                eventName: 'UFC 999',
                eventDateUtc: '2026-03-06',
                mainCard: [
                  {
                    fightId: 'fight_1',
                    fighterA: 'Max Holloway',
                    fighterB: 'Charles Oliveira',
                    isCompleted: false,
                  },
                ],
                updatedAt: '2026-03-08T02:25:00.000Z',
              };
            }
            return {
              eventId: 'ufc_324_2026-04-18',
              eventName: 'UFC 324',
              eventDateUtc: '2026-04-18',
              mainCard: [
                { fightId: 'fight_1', fighterA: 'Gaethje', fighterB: 'Pimblett' },
                { fightId: 'fight_2', fighterA: 'Holloway', fighterB: 'Oliveira' },
              ],
              updatedAt: '2026-03-07T12:00:00.000Z',
            };
          },
          listUpcomingOddsEvents() {
            return [];
          },
          listRecentOddsEvents() {
            return [];
          },
          async refreshLiveScores() {
            return { ok: true, upsertedCount: 0 };
          },
          listLatestRelevantNews() {
            return [];
          },
          listLatestProjectionSnapshotsForEvent({ eventId }) {
            if (eventId !== 'ufc_999_2026-03-06') return [];
            return [
              {
                eventId,
                fightId: 'fight_1',
                fighterA: 'Max Holloway',
                fighterB: 'Charles Oliveira',
                predictedWinner: 'Max Holloway',
                predictedMethod: 'decision_lean',
                confidencePct: 62,
                keyFactors: ['Ventana local nocturna'],
                createdAt: '2026-03-08T02:20:00.000Z',
              },
            ];
          },
          listLatestBetScoringForEvent() {
            return [];
          },
          listLatestOddsMarketsForFight() {
            return [];
          },
        },
      });

      const result = await wizard.handleMessage('mostrame proyecciones para el proximo evento', {
        chatId: 'chat-intel-proj-local-window-1',
        userId: 'u-intel-proj-local-window-1',
        originalMessage: 'mostrame proyecciones para el proximo evento',
        resolution: {
          resolvedMessage: 'mostrame proyecciones para el proximo evento',
        },
      });

      assert.match(result.reply, /Evento:\s*UFC 999/i);
      assert.doesNotMatch(result.reply, /Evento:\s*UFC 324/i);
      assert.equal(fakeClient.calls.length, 0);
    } finally {
      Date.now = realDateNow;
    }
  });

  tests.push(async () => {
    const conversationStore = createConversationStore();
    const fakeClient = createSequentialFakeClient([responseWithText('no deberia ejecutarse')]);
    const updatePayloads = [];

    const wizard = createBettingWizard({
      conversationStore,
      client: fakeClient,
      fightsScalper: {
        async getFighterHistory() {
          return { fighters: [], rows: [] };
        },
      },
      userStore: {
        getUserIntelPrefs() {
          return {
            telegramUserId: 'u-alert-1',
            newsAlertsEnabled: true,
            alertMinImpact: 'high',
            confidenceDeltaThreshold: 8,
            updatedAt: null,
          };
        },
        updateUserIntelPrefs(_userId, updates) {
          updatePayloads.push(updates);
          return {
            telegramUserId: 'u-alert-1',
            newsAlertsEnabled: false,
            alertMinImpact: 'high',
            confidenceDeltaThreshold: 8,
            updatedAt: '2026-03-07T12:00:00.000Z',
          };
        },
        getEventWatchState() {
          return {
            eventId: 'ufc_1000_2026-03-28',
            eventName: 'UFC 1000',
            eventDateUtc: '2026-03-28',
          };
        },
      },
    });

    const result = await wizard.handleMessage('toggle alertas noticias', {
      chatId: 'chat-alert-1',
      userId: 'u-alert-1',
      originalMessage: 'toggle alertas noticias',
      resolution: {
        resolvedMessage: 'toggle alertas noticias',
      },
    });

    assert.equal(updatePayloads.length, 1);
    assert.deepEqual(updatePayloads[0], { newsAlertsEnabled: false });
    assert.match(result.reply, /desactivadas/i);
    assert.match(result.reply, /Estado:\s*DESACTIVADAS/i);
    assert.equal(fakeClient.calls.length, 0);
  });

  tests.push(async () => {
    const conversationStore = createConversationStore();
    let addBetCalls = 0;
    const fakeClient = createSequentialFakeClient([
      responseWithFunctionCall(
        'record_user_bet',
        {
          eventName: 'UFC 325',
          fight: 'Max Holloway vs Charles Oliveira',
          pick: 'Holloway ML',
          odds: 2.1,
          stake: 2000,
        },
        'call_blocked_record'
      ),
      responseWithText('Analisis completo sin mutaciones operativas.'),
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
        addBetRecord() {
          addBetCalls += 1;
          return { id: 1 };
        },
      },
    });

    const result = await wizard.handleMessage(
      'UFC 325, Holloway vs Oliveira, ML Holloway @2.10',
      {
        chatId: 'chat-guided-allowlist-1',
        userId: 'u-guided-allowlist-1',
        interactionMode: 'guided_strict',
        guidedAction: 'analyze_quotes',
        inputType: 'text_odds',
        originalMessage: 'UFC 325, Holloway vs Oliveira, ML Holloway @2.10',
        resolution: {
          resolvedMessage: 'UFC 325, Holloway vs Oliveira, ML Holloway @2.10',
        },
      }
    );

    assert.match(result.reply, /Analisis completo/i);
    assert.equal(addBetCalls, 0);
    const toolDefs = fakeClient.calls[0].tools
      .filter((item) => item?.type === 'function')
      .map((item) => item.name);
    assert.equal(toolDefs.includes('record_user_bet'), false);
    assert.equal(toolDefs.includes('mutate_user_bets'), false);
    assert.equal(toolDefs.includes('undo_last_mutation'), false);

    const outputs = fakeClient.calls[1]?.input || [];
    const blockedPayload = JSON.stringify(outputs);
    assert.match(blockedPayload, /tool_not_allowed_in_interaction_mode/);
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
          return { currency: 'ARS', timezone: 'America/Argentina/Buenos_Aires' };
        },
        getLedgerSummary() {
          return { totalStaked: 7000, wins: 1, losses: 1, pushes: 0 };
        },
        listUserBets() {
          return [
            {
              id: 3,
              eventName: 'UFC Test',
              fight: 'Alpha vs Bravo',
              pick: 'Alpha ML',
              odds: 2.1,
              stake: 3000,
              units: 3,
              result: 'win',
              createdAt: '2026-03-20T21:10:00.000Z',
              updatedAt: '2026-03-20T23:20:00.000Z',
            },
            {
              id: 2,
              eventName: 'UFC Test',
              fight: 'Charlie vs Delta',
              pick: 'Under 2.5',
              odds: 1.8,
              stake: 4000,
              units: 4,
              result: 'loss',
              createdAt: '2026-03-19T21:10:00.000Z',
              updatedAt: '2026-03-19T23:20:00.000Z',
            },
          ];
        },
      },
    });

    const result = await wizard.handleMessage('mostrame historial del ledger', {
      chatId: 'chat-ledger-history-guided-1',
      userId: 'u-ledger-history-guided-1',
      interactionMode: 'guided_strict',
      guidedAction: 'ledger_list_history',
      inputType: 'synthetic',
      originalMessage: 'mostrame historial del ledger',
      resolution: {
        resolvedMessage: 'mostrame historial del ledger',
      },
    });

    assert.match(result.reply, /Historial del ledger/i);
    assert.match(result.reply, /Total apostado/i);
    assert.match(result.reply, /Total ganado/i);
    assert.match(result.reply, /Total perdido/i);
    assert.match(result.reply, /Win rate/i);
    assert.match(result.reply, /bet_id 3/i);
    assert.equal(fakeClient.calls.length, 0);
  });

  tests.push(async () => {
    const conversationStore = createConversationStore();
    const fakeClient = createSequentialFakeClient([responseWithText('no deberia ejecutarse')]);
    const listCalls = [];

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
          return { currency: 'ARS', timezone: 'America/Argentina/Buenos_Aires' };
        },
        listUserBets(_userId, options = {}) {
          listCalls.push(options);
          return [
            {
              id: 11,
              eventName: 'UFC Pending',
              fight: 'Echo vs Foxtrot',
              pick: 'Echo ML',
              odds: 1.66,
              stake: 5000,
              units: 5,
              result: 'pending',
              createdAt: '2026-03-21T21:10:00.000Z',
              updatedAt: '2026-03-21T22:00:00.000Z',
            },
          ];
        },
      },
    });

    const result = await wizard.handleMessage('mostrame pendientes del ledger', {
      chatId: 'chat-ledger-pending-guided-1',
      userId: 'u-ledger-pending-guided-1',
      interactionMode: 'guided_strict',
      guidedAction: 'ledger_list_pending',
      inputType: 'synthetic',
      originalMessage: 'mostrame pendientes del ledger',
      resolution: {
        resolvedMessage: 'mostrame pendientes del ledger',
      },
    });

    assert.equal(listCalls.length, 1);
    assert.equal(listCalls[0].status, 'pending');
    assert.match(result.reply, /Pendientes del ledger/i);
    assert.match(result.reply, /Exposicion abierta/i);
    assert.match(result.reply, /bet_id 11/i);
    assert.match(result.reply, /Ejemplos para cerrar/i);
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
