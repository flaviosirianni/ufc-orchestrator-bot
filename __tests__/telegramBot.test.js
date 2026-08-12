import assert from 'node:assert/strict';
import {
  normalizeGuidedMenuId,
  resolveGuidedMessageDecision,
  startTelegramBot,
} from '../src/core/telegramBot.js';

class FakeTelegramBot {
  constructor() {
    this.handlers = new Map();
    this.sentMessages = [];
    this.chatActions = [];
    this.answeredCallbacks = [];
    this.startPollingCalls = 0;
    this.stopPollingCalls = 0;
  }

  on(event, handler) {
    this.handlers.set(event, handler);
  }

  async emit(event, payload) {
    const handler = this.handlers.get(event);
    if (!handler) {
      throw new Error(`Handler no registrado para evento: ${event}`);
    }
    return handler(payload);
  }

  async sendMessage(chatId, text, options = {}) {
    this.sentMessages.push({ chatId, text, options });
    return {
      chat: { id: chatId },
      text,
      options,
    };
  }

  async sendChatAction(chatId, action) {
    this.chatActions.push({ chatId, action });
  }

  async answerCallbackQuery(id) {
    this.answeredCallbacks.push(id);
  }

  async startPolling() {
    this.startPollingCalls += 1;
  }

  async stopPolling() {
    this.stopPollingCalls += 1;
  }
}

function createRouterSpy() {
  const calls = [];
  return {
    calls,
    async routeMessage(payload) {
      calls.push(payload);
      return 'ROUTED_OK';
    },
  };
}

function createBaseMessage({
  text = '',
  caption = '',
  messageId = 1,
  chatId = 100,
  userId = 200,
  photo = undefined,
  mediaGroupId = '',
} = {}) {
  return {
    message_id: messageId,
    text,
    ...(caption ? { caption } : {}),
    chat: { id: chatId, type: 'private' },
    from: { id: userId, first_name: 'QA' },
    ...(photo ? { photo } : {}),
    ...(mediaGroupId ? { media_group_id: mediaGroupId } : {}),
  };
}

function createBaseCallback({
  data = '',
  callbackId = 'cb_1',
  chatId = 100,
  userId = 200,
} = {}) {
  return {
    id: callbackId,
    data,
    from: { id: userId, first_name: 'QA' },
    message: {
      message_id: 77,
      chat: { id: chatId, type: 'private' },
    },
  };
}

function extractCallbackDataList(message = null) {
  const keyboard = message?.options?.reply_markup?.inline_keyboard || [];
  return keyboard
    .flat()
    .map((item) => item.callback_data)
    .filter(Boolean);
}

function sleep(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runTelegramBotTests() {
  const tests = [];

  tests.push(async () => {
    assert.equal(normalizeGuidedMenuId('ufc_default'), 'ufc_v1');
    assert.equal(normalizeGuidedMenuId('default'), 'ufc_v1');
    assert.equal(normalizeGuidedMenuId('nutrition_v1'), 'nutrition_v1');
  });

  tests.push(async () => {
    const fakeBot = new FakeTelegramBot();
    const router = createRouterSpy();
    const runtime = startTelegramBot(router, {
      botInstance: fakeBot,
      interactionMode: 'guided_strict',
      guidedQuotesTextFallback: true,
      pollingIdleWatchdogMs: 120000,
      pollingWatchdogIntervalMs: 10000,
      downloadFileImpl: async () => ({ buffer: Buffer.from('x'), filePath: 'x.jpg' }),
    });

    await fakeBot.emit(
      'message',
      createBaseMessage({
        text: '/start',
      })
    );
    const statusAfterMessage = runtime.getRuntimeStatus();
    assert.ok(Number(statusAfterMessage.lastMessageAt) > 0);
    assert.ok(Number(statusAfterMessage.lastUpdateAt) > 0);

    await fakeBot.emit('polling_error', new Error('ETIMEDOUT: socket hang up'));
    await sleep(10);
    const statusAfterError = runtime.getRuntimeStatus();
    assert.match(String(statusAfterError.lastErrorMessage || ''), /etimedout/i);
    assert.ok(fakeBot.stopPollingCalls >= 1);
    assert.ok(fakeBot.startPollingCalls >= 1);
    runtime.close();
  });

  tests.push(async () => {
    const fakeBot = new FakeTelegramBot();
    const router = createRouterSpy();

    const runtime = startTelegramBot(router, {
      botInstance: fakeBot,
      interactionMode: 'guided_strict',
      guidedQuotesTextFallback: true,
      pollingIdleWatchdogMs: 120000,
      pollingWatchdogIntervalMs: 10000,
      downloadFileImpl: async () => ({ buffer: Buffer.from('x'), filePath: 'x.jpg' }),
    });

    await fakeBot.emit(
      'polling_error',
      new Error(
        'ETELEGRAM: 409 Conflict: terminated by other getUpdates request; make sure that only one bot instance is running'
      )
    );
    await sleep(10);

    const status = runtime.getRuntimeStatus();
    assert.ok(fakeBot.stopPollingCalls >= 1);
    assert.ok(fakeBot.startPollingCalls >= 1);
    assert.ok(Number(status.lastPollingConflictAt) > 0);
    assert.ok(Number(status.pollingConflictCount) >= 1);
    runtime.close();
  });

  tests.push(async () => {
    const fakeBot = new FakeTelegramBot();
    const router = createRouterSpy();

    const runtime = startTelegramBot(router, {
      botInstance: fakeBot,
      interactionMode: 'guided_strict',
      guidedQuotesTextFallback: true,
      pollingIdleWatchdogMs: 120000,
      pollingWatchdogIntervalMs: 10000,
      downloadFileImpl: async () => ({ buffer: Buffer.from('x'), filePath: 'x.jpg' }),
    });

    await fakeBot.emit('polling_error', new Error('EFATAL: AggregateError'));
    await sleep(10);

    const status = runtime.getRuntimeStatus();
    assert.match(String(status.lastErrorMessage || ''), /aggregateerror/i);
    assert.equal(fakeBot.stopPollingCalls, 0);
    assert.equal(fakeBot.startPollingCalls, 0);
    runtime.close();
  });

  // Task 3 (guided-menu-unification): cold start -- no active guided-action state
  // has ever been set for this chat (no /start, no button press) -- now shows the
  // UFC main menu instead of a "modo guiado activo" reencauce hint. A blocked
  // guided message routes the user back to the menu instead of guessing intent
  // from free text.
  tests.push(async () => {
    const fakeBot = new FakeTelegramBot();
    const router = createRouterSpy();

    startTelegramBot(router, {
      botInstance: fakeBot,
      interactionMode: 'guided_strict',
      guidedQuotesTextFallback: true,
      downloadFileImpl: async () => ({ buffer: Buffer.from('x'), filePath: 'x.jpg' }),
    });

    await fakeBot.emit(
      'message',
      createBaseMessage({
        text: 'hola amigo, que onda?',
      })
    );

    assert.equal(router.calls.length, 0);
    const out = fakeBot.sentMessages[fakeBot.sentMessages.length - 1];
    assert.match(out.text, /Men[uú] principal|🧾 Ledger|📰 Evento/i);
  });

  tests.push(async () => {
    const fakeBot = new FakeTelegramBot();
    const router = createRouterSpy();

    startTelegramBot(router, {
      botInstance: fakeBot,
      interactionMode: 'guided_strict',
      guidedQuotesTextFallback: true,
      downloadFileImpl: async () => ({ buffer: Buffer.from('x'), filePath: 'x.jpg' }),
    });

    // /start establishes the default guided-action state (analyze_quotes for the
    // UFC menu) -- routing now comes from that persisted state, never from the
    // odds-shaped text itself (Task 2: guided-menu-unification).
    await fakeBot.emit('message', createBaseMessage({ text: '/start' }));

    await fakeBot.emit(
      'message',
      createBaseMessage({
        text: 'UFC 325, Holloway vs Oliveira, ML Holloway @2.10',
      })
    );

    assert.equal(router.calls.length, 1);
    assert.equal(router.calls[0].interactionMode, 'guided_strict');
    assert.equal(router.calls[0].guidedAction, 'analyze_quotes');
    assert.equal(router.calls[0].inputType, 'text');
  });

  tests.push(async () => {
    const fakeBot = new FakeTelegramBot();
    const router = createRouterSpy();

    startTelegramBot(router, {
      botInstance: fakeBot,
      interactionMode: 'guided_strict',
      guidedQuotesTextFallback: true,
      downloadFileImpl: async () => ({
        buffer: Buffer.from('fake-image'),
        filePath: 'ticket.jpg',
      }),
    });

    // /start establishes the default guided-action state so this photo has
    // something to route under (a photo with zero active state is blocked
    // instead -- see the resolveGuidedMessageDecision unit test for
    // hasMedia:true + activeGuidedActionState:null, Task 2: guided-menu-unification).
    await fakeBot.emit('message', createBaseMessage({ text: '/start' }));

    await fakeBot.emit(
      'message',
      createBaseMessage({
        text: '',
        photo: [{ file_id: 'photo_1', file_size: 1000 }],
      })
    );

    assert.equal(router.calls.length, 1);
    assert.equal(router.calls[0].interactionMode, 'guided_strict');
    assert.equal(router.calls[0].guidedAction, 'analyze_quotes');
    assert.equal(router.calls[0].inputType, 'image');
    assert.equal(Array.isArray(router.calls[0].inputItems), true);
    assert.equal(router.calls[0].inputItems.length, 1);
  });

  tests.push(async () => {
    const fakeBot = new FakeTelegramBot();
    const router = createRouterSpy();

    startTelegramBot(router, {
      botInstance: fakeBot,
      interactionMode: 'guided_strict',
      guidedQuotesTextFallback: true,
      downloadFileImpl: async () => ({
        buffer: Buffer.from('fake-image'),
        filePath: 'ticket.jpg',
      }),
    });

    // /start establishes the default guided-action state so this album has
    // something to route under (see the resolveGuidedMessageDecision unit
    // test for hasMedia:true + activeGuidedActionState:null -> block,
    // Task 2: guided-menu-unification).
    await fakeBot.emit('message', createBaseMessage({ text: '/start' }));

    await fakeBot.emit(
      'message',
      createBaseMessage({
        messageId: 10,
        caption: 'analiza estos quotes',
        mediaGroupId: 'group_1',
        photo: [{ file_id: 'photo_group_1', file_size: 1000 }],
      })
    );
    await fakeBot.emit(
      'message',
      createBaseMessage({
        messageId: 11,
        mediaGroupId: 'group_1',
        photo: [{ file_id: 'photo_group_2', file_size: 1000 }],
      })
    );

    await sleep(1100);

    assert.equal(router.calls.length, 1);
    assert.equal(router.calls[0].interactionMode, 'guided_strict');
    assert.equal(router.calls[0].guidedAction, 'analyze_quotes');
    assert.equal(router.calls[0].inputType, 'image');
    assert.equal(router.calls[0].message, 'analiza estos quotes');
    assert.equal(Array.isArray(router.calls[0].inputItems), true);
    assert.equal(router.calls[0].inputItems.length, 2);
  });

  tests.push(async () => {
    const fakeBot = new FakeTelegramBot();
    const router = createRouterSpy();

    startTelegramBot(router, {
      botInstance: fakeBot,
      interactionMode: 'guided_strict',
      guidedQuotesTextFallback: true,
      downloadFileImpl: async () => ({ buffer: Buffer.from('x'), filePath: 'x.jpg' }),
    });

    await fakeBot.emit(
      'callback_query',
      createBaseCallback({
        data: 'qa:list_pending',
      })
    );

    assert.equal(router.calls.length, 1);
    assert.equal(router.calls[0].guidedAction, 'ledger_list_pending');
    assert.equal(router.calls[0].inputType, 'synthetic');
  });

  tests.push(async () => {
    const fakeBot = new FakeTelegramBot();
    const router = createRouterSpy();
    router.routeMessage = async (payload) => {
      router.calls.push(payload);
      return 'CREDITOS_OK';
    };

    startTelegramBot(router, {
      botInstance: fakeBot,
      interactionMode: 'guided_strict',
      guidedQuotesTextFallback: true,
      downloadFileImpl: async () => ({ buffer: Buffer.from('x'), filePath: 'x.jpg' }),
    });

    await fakeBot.emit(
      'callback_query',
      createBaseCallback({
        data: 'qa:view_credits',
      })
    );

    assert.equal(router.calls.length, 1);
    assert.equal(router.calls[0].interactionMode, 'guided_strict');
    assert.equal(router.calls[0].guidedAction, 'view_credits');
    assert.equal(router.calls[0].inputType, 'synthetic');

    const out = fakeBot.sentMessages[fakeBot.sentMessages.length - 1];
    const keyboard = out.options?.reply_markup?.inline_keyboard || [];
    const flatCallbacks = keyboard
      .flat()
      .map((item) => item.callback_data)
      .filter(Boolean);
    assert.ok(flatCallbacks.includes('qa:topup_credits'));
  });

  tests.push(async () => {
    const fakeBot = new FakeTelegramBot();
    const router = createRouterSpy();

    startTelegramBot(router, {
      botInstance: fakeBot,
      interactionMode: 'guided_strict',
      guidedQuotesTextFallback: true,
      downloadFileImpl: async () => ({ buffer: Buffer.from('x'), filePath: 'x.jpg' }),
    });

    await fakeBot.emit(
      'callback_query',
      createBaseCallback({
        data: 'qa:record_bet',
      })
    );

    await fakeBot.emit(
      'message',
      createBaseMessage({
        text: 'UFC 326, Holloway vs Oliveira, Holloway ML @2.10, stake $5000',
      })
    );

    assert.equal(router.calls.length, 1);
    assert.equal(router.calls[0].guidedAction, 'record_bet');
    // inputType is now the generic 'text' -- routing comes from the active
    // record_bet session state, not from sniffing the text shape (Task 2).
    assert.equal(router.calls[0].inputType, 'text');
  });

  tests.push(async () => {
    const fakeBot = new FakeTelegramBot();
    const router = createRouterSpy();

    startTelegramBot(router, {
      botInstance: fakeBot,
      interactionMode: 'guided_strict',
      guidedQuotesTextFallback: true,
      downloadFileImpl: async () => ({ buffer: Buffer.from('x'), filePath: 'x.jpg' }),
    });

    await fakeBot.emit(
      'callback_query',
      createBaseCallback({
        data: 'qa:record_bet',
      })
    );

    // Regression guard for the bug class this plan removes: "bet_id 42 LOST"
    // is settle-shaped text, but the active session state is record_bet -- it
    // must stay record_bet, never get reclassified by keyword-sniffing the
    // message (Task 2: guided-menu-unification).
    await fakeBot.emit(
      'message',
      createBaseMessage({
        text: 'bet_id 42 LOST',
      })
    );

    assert.equal(router.calls.length, 1);
    assert.equal(router.calls[0].guidedAction, 'record_bet');
    assert.equal(router.calls[0].inputType, 'text');
  });

  tests.push(async () => {
    const fakeBot = new FakeTelegramBot();
    const router = createRouterSpy();

    startTelegramBot(router, {
      botInstance: fakeBot,
      interactionMode: 'guided_strict',
      guidedQuotesTextFallback: true,
      downloadFileImpl: async () => ({ buffer: Buffer.from('x'), filePath: 'x.jpg' }),
    });

    await fakeBot.emit(
      'callback_query',
      createBaseCallback({
        data: 'qa:list_pending',
      })
    );

    await fakeBot.emit(
      'message',
      createBaseMessage({
        text: 'bet_id 45 WON',
      })
    );

    assert.equal(router.calls.length, 2);
    assert.equal(router.calls[0].guidedAction, 'ledger_list_pending');
    assert.equal(router.calls[1].guidedAction, 'settle_bet');
    assert.equal(router.calls[1].inputType, 'text');
  });

  tests.push(async () => {
    const fakeBot = new FakeTelegramBot();
    const router = createRouterSpy();

    startTelegramBot(router, {
      botInstance: fakeBot,
      interactionMode: 'guided_strict',
      guidedQuotesTextFallback: true,
      downloadFileImpl: async () => ({ buffer: Buffer.from('x'), filePath: 'x.jpg' }),
    });

    await fakeBot.emit(
      'callback_query',
      createBaseCallback({
        data: 'qa:settle_bet',
      })
    );

    // With a fresh active state, any text now routes under that state's action
    // -- the guided layer no longer judges whether the text "looks like" a
    // valid settle message; that's the router's job downstream (Task 2:
    // guided-menu-unification, "intent comes from state, never from text").
    await fakeBot.emit(
      'message',
      createBaseMessage({
        text: 'hola',
      })
    );

    assert.equal(router.calls.length, 1);
    assert.equal(router.calls[0].guidedAction, 'settle_bet');
    assert.equal(router.calls[0].inputType, 'text');
    assert.equal(router.calls[0].message, 'hola');
  });

  tests.push(async () => {
    const fakeBot = new FakeTelegramBot();
    const router = createRouterSpy();

    startTelegramBot(router, {
      botInstance: fakeBot,
      interactionMode: 'guided_strict',
      guidedLedgerEnabled: false,
      guidedQuotesTextFallback: true,
      downloadFileImpl: async () => ({ buffer: Buffer.from('x'), filePath: 'x.jpg' }),
    });

    await fakeBot.emit(
      'callback_query',
      createBaseCallback({
        data: 'menu:ledger',
      })
    );

    const out = fakeBot.sentMessages[fakeBot.sentMessages.length - 1];
    assert.match(out.text, /no esta disponible/i);
    assert.equal(router.calls.length, 0);
  });

  tests.push(async () => {
    const fakeBot = new FakeTelegramBot();
    const router = createRouterSpy();

    startTelegramBot(router, {
      botInstance: fakeBot,
      interactionMode: 'guided_strict',
      guidedLedgerEnabled: true,
      guidedQuotesTextFallback: true,
      downloadFileImpl: async () => ({ buffer: Buffer.from('x'), filePath: 'x.jpg' }),
    });

    await fakeBot.emit(
      'message',
      createBaseMessage({
        text: '/start',
      })
    );

    const out = fakeBot.sentMessages[fakeBot.sentMessages.length - 1];
    const keyboard = out.options?.reply_markup?.inline_keyboard || [];
    const flatCallbacks = keyboard
      .flat()
      .map((item) => item.callback_data)
      .filter(Boolean);
    assert.ok(flatCallbacks.includes('menu:ufc_analysis'));
    assert.ok(flatCallbacks.includes('menu:ufc_ledger'));
    assert.ok(flatCallbacks.includes('menu:ufc_event'));
    assert.ok(flatCallbacks.includes('menu:ufc_config'));
    assert.ok(flatCallbacks.includes('qa:view_credits'));
    assert.ok(flatCallbacks.includes('qa:help'));
  });

  tests.push(async () => {
    const fakeBot = new FakeTelegramBot();
    const router = createRouterSpy();

    startTelegramBot(router, {
      botInstance: fakeBot,
      interactionMode: 'guided_strict',
      guidedLedgerEnabled: true,
      guidedQuotesTextFallback: true,
      downloadFileImpl: async () => ({ buffer: Buffer.from('x'), filePath: 'x.jpg' }),
    });

    await fakeBot.emit(
      'callback_query',
      createBaseCallback({
        data: 'menu:ufc_ledger',
      })
    );

    const out = fakeBot.sentMessages[fakeBot.sentMessages.length - 1];
    const keyboard = out.options?.reply_markup?.inline_keyboard || [];
    const flatCallbacks = keyboard
      .flat()
      .map((item) => item.callback_data)
      .filter(Boolean);
    assert.ok(flatCallbacks.includes('qa:record_bet'));
    assert.ok(flatCallbacks.includes('qa:settle_bet'));
    assert.ok(flatCallbacks.includes('qa:list_pending'));
    assert.ok(flatCallbacks.includes('qa:list_history'));
    assert.ok(flatCallbacks.includes('menu:main'));
  });

  tests.push(async () => {
    const fakeBot = new FakeTelegramBot();
    const router = createRouterSpy();

    startTelegramBot(router, {
      botInstance: fakeBot,
      interactionMode: 'guided_strict',
      guidedLedgerEnabled: true,
      guidedQuotesTextFallback: true,
      downloadFileImpl: async () => ({ buffer: Buffer.from('x'), filePath: 'x.jpg' }),
    });

    await fakeBot.emit(
      'callback_query',
      createBaseCallback({
        data: 'menu:ufc_event',
      })
    );

    await fakeBot.emit(
      'callback_query',
      createBaseCallback({
        data: 'qa:event_projections',
      })
    );

    assert.equal(router.calls.length, 1);
    const out = fakeBot.sentMessages[fakeBot.sentMessages.length - 1];
    const keyboard = out.options?.reply_markup?.inline_keyboard || [];
    const flatCallbacks = keyboard
      .flat()
      .map((item) => item.callback_data)
      .filter(Boolean);
    assert.ok(flatCallbacks.includes('qa:event_projections'));
    assert.ok(flatCallbacks.includes('qa:latest_news'));
    assert.ok(flatCallbacks.includes('act:cfg_news_alerts_toggle'));
    assert.ok(flatCallbacks.includes('menu:main'));
  });

  tests.push(async () => {
    const fakeBot = new FakeTelegramBot();
    const router = createRouterSpy();

    startTelegramBot(router, {
      botInstance: fakeBot,
      interactionMode: 'guided_strict',
      guidedMenuId: 'nutrition_v1',
      guidedLedgerEnabled: false,
      guidedQuotesTextFallback: true,
      downloadFileImpl: async () => ({ buffer: Buffer.from('x'), filePath: 'x.jpg' }),
    });

    await fakeBot.emit(
      'callback_query',
      createBaseCallback({
        data: 'qa:nutrition_learning',
      })
    );

    await fakeBot.emit(
      'message',
      createBaseMessage({
        text: 'explicame recomposicion corporal',
      })
    );

    assert.equal(router.calls.length, 1);
    assert.equal(router.calls[0].guidedAction, 'learning_chat');
    assert.equal(router.calls[0].inputType, 'text_freechat');
  });

  tests.push(async () => {
    const fakeBot = new FakeTelegramBot();
    const router = createRouterSpy();

    startTelegramBot(router, {
      botInstance: fakeBot,
      interactionMode: 'guided_strict',
      guidedMenuId: 'nutrition_v1',
      guidedLedgerEnabled: false,
      guidedQuotesTextFallback: true,
      downloadFileImpl: async () => ({ buffer: Buffer.from('x'), filePath: 'x.jpg' }),
    });

    await fakeBot.emit(
      'callback_query',
      createBaseCallback({
        data: 'qa:help',
      })
    );

    const out = fakeBot.sentMessages[fakeBot.sentMessages.length - 1];
    assert.match(out.text, /ayuda y feedback/i);
    const flatCallbacks = extractCallbackDataList(out);
    assert.ok(flatCallbacks.includes('qa:nutrition_report_bug'));
    assert.ok(flatCallbacks.includes('qa:nutrition_feature_request'));
    assert.ok(flatCallbacks.includes('menu:main'));
  });

  tests.push(async () => {
    const fakeBot = new FakeTelegramBot();
    const router = createRouterSpy();

    startTelegramBot(router, {
      botInstance: fakeBot,
      interactionMode: 'guided_strict',
      guidedMenuId: 'nutrition_v1',
      guidedLedgerEnabled: false,
      guidedQuotesTextFallback: true,
      downloadFileImpl: async () => ({ buffer: Buffer.from('x'), filePath: 'x.jpg' }),
    });

    await fakeBot.emit(
      'callback_query',
      createBaseCallback({
        data: 'qa:nutrition_report_bug',
      })
    );

    await fakeBot.emit(
      'message',
      createBaseMessage({
        text: 'al registrar pesaje 81.4 kg, en algunos casos me devuelve error de timeout',
      })
    );

    assert.equal(router.calls.length, 1);
    assert.equal(router.calls[0].guidedAction, 'report_bug');
    assert.equal(router.calls[0].inputType, 'text_feedback');

    await fakeBot.emit(
      'message',
      createBaseMessage({
        text: '14:30 yogur con banana',
      })
    );

    assert.equal(router.calls.length, 2);
    assert.equal(router.calls[1].guidedAction, 'log_intake');
    assert.equal(router.calls[1].inputType, 'text_intake');
  });

  tests.push(async () => {
    const fakeBot = new FakeTelegramBot();
    const router = createRouterSpy();

    startTelegramBot(router, {
      botInstance: fakeBot,
      interactionMode: 'guided_strict',
      guidedMenuId: 'nutrition_v1',
      guidedLedgerEnabled: false,
      guidedQuotesTextFallback: true,
      downloadFileImpl: async () => ({ buffer: Buffer.from('x'), filePath: 'x.jpg' }),
    });

    await fakeBot.emit(
      'callback_query',
      createBaseCallback({
        data: 'qa:nutrition_report_bug',
      })
    );

    await fakeBot.emit(
      'message',
      createBaseMessage({
        text: '',
        photo: [{ file_id: 'feedback_photo_1', file_size: 1000 }],
      })
    );

    assert.equal(router.calls.length, 0);
    const out = fakeBot.sentMessages[fakeBot.sentMessages.length - 1];
    assert.match(out.text, /modo feedback activo|mensaje de texto/i);
    const flatCallbacks = extractCallbackDataList(out);
    assert.ok(flatCallbacks.includes('qa:nutrition_report_bug'));
    assert.ok(flatCallbacks.includes('qa:nutrition_feature_request'));
  });

  tests.push(async () => {
    const fakeBot = new FakeTelegramBot();
    const router = createRouterSpy();

    startTelegramBot(router, {
      botInstance: fakeBot,
      interactionMode: 'guided_strict',
      guidedMenuId: 'nutrition_v1',
      guidedLedgerEnabled: false,
      guidedQuotesTextFallback: true,
      downloadFileImpl: async () => ({ buffer: Buffer.from('x'), filePath: 'x.jpg' }),
    });

    await fakeBot.emit(
      'callback_query',
      createBaseCallback({
        data: 'qa:nutrition_feature_request',
      })
    );

    await fakeBot.emit(
      'message',
      createBaseMessage({
        text: 'me gustaría exportar el resumen semanal a PDF con macros y tendencia',
      })
    );

    assert.equal(router.calls.length, 1);
    assert.equal(router.calls[0].guidedAction, 'submit_feature_request');
    assert.equal(router.calls[0].inputType, 'text_feedback');
  });

  tests.push(async () => {
    const fakeBot = new FakeTelegramBot();
    const router = createRouterSpy();

    startTelegramBot(router, {
      botInstance: fakeBot,
      interactionMode: 'guided_strict',
      guidedMenuId: 'nutrition_v1',
      guidedLedgerEnabled: false,
      guidedQuotesTextFallback: true,
      downloadFileImpl: async () => ({ buffer: Buffer.from('x'), filePath: 'x.jpg' }),
    });

    await fakeBot.emit(
      'callback_query',
      createBaseCallback({
        data: 'qa:nutrition_view_summary',
      })
    );

    assert.equal(router.calls.length, 1);
    assert.equal(router.calls[0].guidedAction, 'view_summary');
    assert.equal(router.calls[0].inputType, 'synthetic');
    const out = fakeBot.sentMessages[fakeBot.sentMessages.length - 1];
    assert.deepEqual(extractCallbackDataList(out), ['menu:nutrition_estadisticas']);
  });

  tests.push(async () => {
    const fakeBot = new FakeTelegramBot();
    const router = createRouterSpy();

    startTelegramBot(router, {
      botInstance: fakeBot,
      interactionMode: 'guided_strict',
      guidedMenuId: 'nutrition_v1',
      guidedLedgerEnabled: false,
      guidedQuotesTextFallback: true,
      downloadFileImpl: async () => ({ buffer: Buffer.from('x'), filePath: 'x.jpg' }),
    });

    await fakeBot.emit(
      'callback_query',
      createBaseCallback({
        data: 'qa:nutrition_log_weighin',
      })
    );

    const weighinHint = fakeBot.sentMessages[fakeBot.sentMessages.length - 1];
    assert.match(weighinHint.text, /foto|screenshot|imagen/i);
    assert.doesNotMatch(weighinHint.text, /confirm/i);
    assert.deepEqual(extractCallbackDataList(weighinHint), ['menu:nutrition_registro']);

    await fakeBot.emit(
      'message',
      createBaseMessage({
        text: 'hola',
      })
    );

    assert.equal(router.calls.length, 0);
    const out = fakeBot.sentMessages[fakeBot.sentMessages.length - 1];
    assert.match(out.text, /modo guiado - registrar pesaje/i);
    assert.match(out.text, /foto|screenshot|imagen/i);
    assert.deepEqual(extractCallbackDataList(out), ['menu:nutrition_registro']);
  });

  tests.push(async () => {
    const fakeBot = new FakeTelegramBot();
    const router = createRouterSpy();

    startTelegramBot(router, {
      botInstance: fakeBot,
      interactionMode: 'guided_strict',
      guidedMenuId: 'nutrition_v1',
      guidedLedgerEnabled: false,
      guidedQuotesTextFallback: true,
      downloadFileImpl: async () => ({ buffer: Buffer.from('x'), filePath: 'x.jpg' }),
    });

    await fakeBot.emit(
      'callback_query',
      createBaseCallback({
        data: 'qa:nutrition_log_weighin',
      })
    );

    await fakeBot.emit(
      'message',
      createBaseMessage({
        text: '',
        photo: [{ file_id: 'weighin_photo_1', file_size: 1000 }],
      })
    );

    assert.equal(router.calls.length, 1);
    assert.equal(router.calls[0].guidedAction, 'log_weighin');
    assert.equal(router.calls[0].inputType, 'image_weighin');
  });

  tests.push(async () => {
    const fakeBot = new FakeTelegramBot();
    const router = createRouterSpy();

    startTelegramBot(router, {
      botInstance: fakeBot,
      interactionMode: 'guided_strict',
      guidedMenuId: 'nutrition_v1',
      guidedLedgerEnabled: false,
      guidedQuotesTextFallback: true,
      downloadFileImpl: async () => ({ buffer: Buffer.from('x'), filePath: 'x.jpg' }),
    });

    await fakeBot.emit(
      'callback_query',
      createBaseCallback({
        data: 'qa:nutrition_log_weighin',
      })
    );

    await fakeBot.emit(
      'message',
      createBaseMessage({
        text: 'borra el ultimo pesaje',
      })
    );

    assert.equal(router.calls.length, 1);
    assert.equal(router.calls[0].guidedAction, 'log_weighin');
    assert.equal(router.calls[0].inputType, 'text_weighin');
  });

  tests.push(async () => {
    const fakeBot = new FakeTelegramBot();
    const router = createRouterSpy();

    startTelegramBot(router, {
      botInstance: fakeBot,
      interactionMode: 'guided_strict',
      guidedMenuId: 'nutrition_v1',
      guidedLedgerEnabled: false,
      guidedQuotesTextFallback: true,
      downloadFileImpl: async () => ({ buffer: Buffer.from('x'), filePath: 'x.jpg' }),
    });

    await fakeBot.emit(
      'callback_query',
      createBaseCallback({
        data: 'qa:nutrition_log_weighin',
      })
    );

    await fakeBot.emit(
      'message',
      createBaseMessage({
        text: 'modificar',
      })
    );

    assert.equal(router.calls.length, 1);
    assert.equal(router.calls[0].guidedAction, 'log_weighin');
    assert.equal(router.calls[0].inputType, 'text_weighin');
  });

  tests.push(async () => {
    const fakeBot = new FakeTelegramBot();
    const router = createRouterSpy();

    startTelegramBot(router, {
      botInstance: fakeBot,
      interactionMode: 'guided_strict',
      guidedMenuId: 'nutrition_v1',
      guidedLedgerEnabled: false,
      guidedQuotesTextFallback: true,
      downloadFileImpl: async () => ({ buffer: Buffer.from('x'), filePath: 'x.jpg' }),
    });

    await fakeBot.emit(
      'callback_query',
      createBaseCallback({
        data: 'qa:nutrition_log_weighin',
      })
    );

    await fakeBot.emit(
      'message',
      createBaseMessage({
        text: '81.4 kg',
      })
    );

    assert.equal(router.calls.length, 1);
    assert.equal(router.calls[0].guidedAction, 'log_weighin');
    assert.equal(router.calls[0].inputType, 'text_weighin');
  });

  tests.push(async () => {
    const fakeBot = new FakeTelegramBot();
    const router = createRouterSpy();

    startTelegramBot(router, {
      botInstance: fakeBot,
      interactionMode: 'guided_strict',
      guidedMenuId: 'nutrition_v1',
      guidedLedgerEnabled: false,
      guidedQuotesTextFallback: true,
      downloadFileImpl: async () => ({ buffer: Buffer.from('x'), filePath: 'x.jpg' }),
    });

    await fakeBot.emit(
      'callback_query',
      createBaseCallback({
        data: 'menu:nutrition_registro',
      })
    );

    const out = fakeBot.sentMessages[fakeBot.sentMessages.length - 1];
    const keyboard = out.options?.reply_markup?.inline_keyboard || [];
    const flatCallbacks = keyboard
      .flat()
      .map((item) => item.callback_data)
      .filter(Boolean);
    assert.ok(flatCallbacks.includes('qa:nutrition_modify_delete_intake'));
    assert.ok(flatCallbacks.includes('qa:nutrition_modify_delete_weighin'));
  });

  tests.push(async () => {
    const fakeBot = new FakeTelegramBot();
    const router = createRouterSpy();

    startTelegramBot(router, {
      botInstance: fakeBot,
      interactionMode: 'guided_strict',
      guidedMenuId: 'nutrition_v1',
      guidedLedgerEnabled: false,
      guidedQuotesTextFallback: true,
      downloadFileImpl: async () => ({ buffer: Buffer.from('x'), filePath: 'x.jpg' }),
    });

    await fakeBot.emit(
      'callback_query',
      createBaseCallback({
        data: 'qa:nutrition_modify_delete_intake',
      })
    );

    const out = fakeBot.sentMessages[fakeBot.sentMessages.length - 1];
    assert.match(out.text, /modificar\/borrar ingesta/i);
    assert.deepEqual(extractCallbackDataList(out), ['menu:nutrition_registro']);
    assert.equal(router.calls.length, 0);
  });

  tests.push(async () => {
    const fakeBot = new FakeTelegramBot();
    const router = createRouterSpy();

    startTelegramBot(router, {
      botInstance: fakeBot,
      interactionMode: 'guided_strict',
      guidedMenuId: 'nutrition_v1',
      guidedLedgerEnabled: false,
      guidedQuotesTextFallback: true,
      downloadFileImpl: async () => ({ buffer: Buffer.from('x'), filePath: 'x.jpg' }),
    });

    await fakeBot.emit(
      'callback_query',
      createBaseCallback({
        data: 'qa:nutrition_modify_delete_weighin',
      })
    );

    await fakeBot.emit(
      'message',
      createBaseMessage({
        text: 'hola',
      })
    );

    assert.equal(router.calls.length, 0);
    const out = fakeBot.sentMessages[fakeBot.sentMessages.length - 1];
    assert.match(out.text, /modo guiado - registrar pesaje/i);
    assert.deepEqual(extractCallbackDataList(out), ['menu:nutrition_registro']);
  });

  tests.push(async () => {
    const fakeBot = new FakeTelegramBot();
    const router = createRouterSpy();

    startTelegramBot(router, {
      botInstance: fakeBot,
      interactionMode: 'guided_strict',
      guidedMenuId: 'nutrition_v1',
      guidedLedgerEnabled: false,
      guidedQuotesTextFallback: true,
      downloadFileImpl: async () => ({ buffer: Buffer.from('x'), filePath: 'x.jpg' }),
    });

    await fakeBot.emit(
      'callback_query',
      createBaseCallback({
        data: 'qa:nutrition_view_summary',
      })
    );

    await fakeBot.emit(
      'message',
      createBaseMessage({
        text: 'hola',
      })
    );

    const out = fakeBot.sentMessages[fakeBot.sentMessages.length - 1];
    assert.match(out.text, /resumen/i);
    assert.deepEqual(extractCallbackDataList(out), ['menu:nutrition_estadisticas']);
  });

  tests.push(async () => {
    const fakeBot = new FakeTelegramBot();
    const router = createRouterSpy();

    startTelegramBot(router, {
      botInstance: fakeBot,
      interactionMode: 'guided_strict',
      guidedMenuId: 'nutrition_v1',
      guidedLedgerEnabled: false,
      guidedQuotesTextFallback: true,
      downloadFileImpl: async () => ({ buffer: Buffer.from('x'), filePath: 'x.jpg' }),
    });

    await fakeBot.emit(
      'callback_query',
      createBaseCallback({
        data: 'qa:nutrition_update_profile',
      })
    );

    const out = fakeBot.sentMessages[fakeBot.sentMessages.length - 1];
    assert.match(out.text, /perfil|objetivos/i);
    assert.deepEqual(extractCallbackDataList(out), ['menu:nutrition_perfil']);
    assert.equal(router.calls.length, 0);
  });

  tests.push(async () => {
    const fakeBot = new FakeTelegramBot();
    const router = createRouterSpy();

    startTelegramBot(router, {
      botInstance: fakeBot,
      interactionMode: 'guided_strict',
      guidedMenuId: 'nutrition_v1',
      guidedLedgerEnabled: false,
      guidedQuotesTextFallback: true,
      downloadFileImpl: async () => ({ buffer: Buffer.from('x'), filePath: 'x.jpg' }),
    });

    await fakeBot.emit(
      'callback_query',
      createBaseCallback({
        data: 'qa:nutrition_analysis',
      })
    );

    assert.equal(router.calls.length, 1);
    assert.equal(router.calls[0].guidedAction, 'view_analysis');
    assert.equal(router.calls[0].inputType, 'synthetic');
    const out = fakeBot.sentMessages[fakeBot.sentMessages.length - 1];
    assert.deepEqual(extractCallbackDataList(out), ['menu:nutrition_aprendizaje']);
  });

  tests.push(async () => {
    const fakeBot = new FakeTelegramBot();
    const calls = [];
    let releaseRoute;
    const routeLock = new Promise((resolve) => {
      releaseRoute = resolve;
    });
    const router = {
      calls,
      async routeMessage(payload) {
        calls.push(payload);
        await routeLock;
        return 'ROUTED_OK';
      },
    };

    startTelegramBot(router, {
      botInstance: fakeBot,
      interactionMode: 'guided_strict',
      guidedMenuId: 'nutrition_v1',
      guidedLedgerEnabled: false,
      guidedQuotesTextFallback: true,
      messageDedupWindowMs: 5000,
      busyNoticeCooldownMs: 60000,
      downloadFileImpl: async () => ({ buffer: Buffer.from('x'), filePath: 'x.jpg' }),
    });

    const duplicated = createBaseMessage({
      messageId: 1501,
      text: '16:30 1 yogur proteico + 1 scoop whey',
    });

    const first = fakeBot.emit('message', duplicated);
    await sleep(5);
    await fakeBot.emit('message', { ...duplicated });
    await sleep(5);

    assert.equal(router.calls.length, 1);
    const busyCount = fakeBot.sentMessages.filter((row) =>
      /estoy respondiendo tu mensaje anterior/i.test(String(row?.text || ''))
    ).length;
    assert.equal(busyCount, 0);

    releaseRoute();
    await first;
  });

  tests.push(async () => {
    const fakeBot = new FakeTelegramBot();
    const calls = [];
    let releaseRoute;
    const routeLock = new Promise((resolve) => {
      releaseRoute = resolve;
    });
    const router = {
      calls,
      async routeMessage(payload) {
        calls.push(payload);
        await routeLock;
        return 'ROUTED_OK';
      },
    };

    startTelegramBot(router, {
      botInstance: fakeBot,
      interactionMode: 'guided_strict',
      guidedMenuId: 'nutrition_v1',
      guidedLedgerEnabled: false,
      guidedQuotesTextFallback: true,
      busyNoticeCooldownMs: 60000,
      downloadFileImpl: async () => ({ buffer: Buffer.from('x'), filePath: 'x.jpg' }),
    });

    const first = fakeBot.emit(
      'message',
      createBaseMessage({
        messageId: 1601,
        text: '17:00 1 yogur natural',
      })
    );
    await sleep(5);

    await fakeBot.emit(
      'message',
      createBaseMessage({
        messageId: 1602,
        text: '17:01 1 manzana',
      })
    );
    await fakeBot.emit(
      'message',
      createBaseMessage({
        messageId: 1603,
        text: '17:02 1 banana',
      })
    );

    assert.equal(router.calls.length, 1);
    const busyCount = fakeBot.sentMessages.filter((row) =>
      /estoy respondiendo tu mensaje anterior/i.test(String(row?.text || ''))
    ).length;
    assert.equal(busyCount, 1);

    releaseRoute();
    await first;
  });


  tests.push(async () => {
    const fakeBot = new FakeTelegramBot();
    const router = createRouterSpy();

    startTelegramBot(router, {
      botInstance: fakeBot,
      interactionMode: 'guided_strict',
      callbackDedupWindowMs: 5000,
      guidedQuotesTextFallback: true,
      downloadFileImpl: async () => ({ buffer: Buffer.from('x'), filePath: 'x.jpg' }),
    });

    await fakeBot.emit(
      'callback_query',
      createBaseCallback({
        callbackId: 'cb_dedupe_1',
        data: 'qa:list_pending',
      })
    );

    await fakeBot.emit(
      'callback_query',
      createBaseCallback({
        callbackId: 'cb_dedupe_2',
        data: 'qa:list_pending',
      })
    );

    assert.equal(router.calls.length, 1);
    assert.equal(fakeBot.answeredCallbacks.length, 2);
  });

  tests.push(async () => {
    const fakeBot = new FakeTelegramBot();
    const router = createRouterSpy();
    let nowMs = 1000;

    startTelegramBot(router, {
      botInstance: fakeBot,
      interactionMode: 'guided_strict',
      callbackDedupWindowMs: 1000,
      nowProvider: () => nowMs,
      guidedQuotesTextFallback: true,
      downloadFileImpl: async () => ({ buffer: Buffer.from('x'), filePath: 'x.jpg' }),
    });

    await fakeBot.emit(
      'callback_query',
      createBaseCallback({
        callbackId: 'cb_dedupe_ttl_1',
        data: 'qa:list_pending',
      })
    );

    nowMs = 1500;
    await fakeBot.emit(
      'callback_query',
      createBaseCallback({
        callbackId: 'cb_dedupe_ttl_2',
        data: 'qa:list_pending',
      })
    );

    nowMs = 2601;
    await fakeBot.emit(
      'callback_query',
      createBaseCallback({
        callbackId: 'cb_dedupe_ttl_3',
        data: 'qa:list_pending',
      })
    );

    assert.equal(router.calls.length, 2);
    assert.equal(fakeBot.answeredCallbacks.length, 3);
  });

  // Test A — degraded mode after exceeding recovery limit
  tests.push(async () => {
    const fakeBot = new FakeTelegramBot();
    const runtime = startTelegramBot(createRouterSpy(), {
      botInstance: fakeBot,
      interactionMode: 'guided_strict',
      guidedQuotesTextFallback: true,
      pollingIdleWatchdogMs: 0,
      pollingWatchdogIntervalMs: 0,
      pollingRecoveryCooldownMs: 1,
      pollingConflictRecoveryCooldownMs: 1,
      pollingRecoveryWindowMs: 60_000,
      pollingRecoveryMaxPerWindow: 2,
    });

    for (let i = 0; i < 4; i++) {
      await fakeBot.emit('polling_error', new Error('ETIMEDOUT'));
      await sleep(5);
    }

    const status = runtime.getRuntimeStatus();
    assert.equal(status.degraded, true, 'debe entrar en degraded tras superar limite');
    assert.ok(fakeBot.startPollingCalls <= 2, `solo ${fakeBot.startPollingCalls} recoveries, max 2`);
    runtime.close();
  });

  // Test B — window expiry resets degraded
  tests.push(async () => {
    let mockNow = 1_000_000;
    const fakeBot = new FakeTelegramBot();
    const runtime = startTelegramBot(createRouterSpy(), {
      botInstance: fakeBot,
      interactionMode: 'guided_strict',
      guidedQuotesTextFallback: true,
      pollingIdleWatchdogMs: 0,
      pollingWatchdogIntervalMs: 0,
      nowProvider: () => mockNow,
      pollingRecoveryCooldownMs: 1,
      pollingConflictRecoveryCooldownMs: 1,
      pollingRecoveryWindowMs: 500,
      pollingRecoveryMaxPerWindow: 1,
    });

    // First recovery passes
    await fakeBot.emit('polling_error', new Error('ETIMEDOUT'));
    await sleep(5);
    assert.equal(fakeBot.startPollingCalls, 1);

    // Second in same window → blocked → degraded
    mockNow += 100;
    await fakeBot.emit('polling_error', new Error('ETIMEDOUT'));
    await sleep(5);
    assert.equal(runtime.getRuntimeStatus().degraded, true);

    // Advance past window → resets
    mockNow += 600;
    await fakeBot.emit('polling_error', new Error('ETIMEDOUT'));
    await sleep(5);
    const status = runtime.getRuntimeStatus();
    assert.equal(status.degraded, false, 'ventana expirada → degraded resetea');
    assert.equal(fakeBot.startPollingCalls, 2, 'una recovery adicional tras reset');
    runtime.close();
  });

  // Task 2 — resolveGuidedMessageDecision routes from session state, never from
  // keyword-guessed text. Regression coverage for the confirmed production incident
  // (2026-08-12 session): "le puse $2000 a Hooper por Sumisión @2.40" with an active
  // record_bet state must route as record_bet, not get reclassified as analyze_quotes
  // by an odds-shaped regex (the old keyword list only had the English "submission").
  tests.push(() => {
    const decision = resolveGuidedMessageDecision({
      cleanMessage: 'le puse $2000 a Hooper por Sumisión @2.40',
      hasMedia: false,
      activeGuidedActionState: { action: 'record_bet', fightContext: null, setAt: Date.now() },
      guidedMenuId: 'ufc_v1',
    });

    assert.equal(decision.action, 'route');
    assert.equal(decision.guidedAction, 'record_bet');
  });

  tests.push(() => {
    // Same message, but the active state is analyze_quotes: must stay analyze_quotes.
    // Proves intent comes from state, never from text content.
    const decision = resolveGuidedMessageDecision({
      cleanMessage: 'le puse $2000 a Hooper por Sumisión @2.40',
      hasMedia: false,
      activeGuidedActionState: { action: 'analyze_quotes', fightContext: null, setAt: Date.now() },
      guidedMenuId: 'ufc_v1',
    });

    assert.equal(decision.guidedAction, 'analyze_quotes');
  });

  tests.push(() => {
    // No active state at all: block (show menu), never guess.
    const decision = resolveGuidedMessageDecision({
      cleanMessage: 'le puse $2000 a Hooper por Sumisión @2.40',
      hasMedia: false,
      activeGuidedActionState: null,
      guidedMenuId: 'ufc_v1',
    });

    assert.equal(decision.action, 'block');
  });

  tests.push(() => {
    // Active state exists but is stale (46 min old): block (show menu), don't reuse it.
    const decision = resolveGuidedMessageDecision({
      cleanMessage: 'le puse $2000 a Hooper por Sumisión @2.40',
      hasMedia: false,
      activeGuidedActionState: { action: 'record_bet', fightContext: null, setAt: Date.now() - 46 * 60 * 1000 },
      guidedMenuId: 'ufc_v1',
    });

    assert.equal(decision.action, 'block');
  });

  tests.push(() => {
    // Media (photo) always routes with whatever the active state is, regardless of freshness
    // rules for text -- unchanged from today's behavior, still exercised here as a regression
    // guard since this function is being rewritten.
    const decision = resolveGuidedMessageDecision({
      cleanMessage: '',
      hasMedia: true,
      activeGuidedActionState: { action: 'analyze_quotes', fightContext: null, setAt: Date.now() - 46 * 60 * 1000 },
      guidedMenuId: 'ufc_v1',
    });

    assert.equal(decision.action, 'route');
    assert.equal(decision.guidedAction, 'analyze_quotes');
  });

  tests.push(() => {
    // Highest-risk branch ordering: a photo (or any media) arriving at a chat
    // with zero prior guided state must still block. The implementation checks
    // `!activeGuidedActionState` before `hasMedia` is ever consulted, so this
    // guards against a future reordering silently letting media bypass the
    // "no state at all" gate. (Every other hasMedia:true test above pairs it
    // with a non-null state -- this is the one that pins the null case.)
    const decision = resolveGuidedMessageDecision({
      hasMedia: true,
      activeGuidedActionState: null,
      guidedMenuId: 'ufc_v1',
    });

    assert.equal(decision.action, 'block');
  });

  // Task 1 — guided-action state carries a setAt timestamp for staleness checks
  tests.push(async () => {
    const runtime = startTelegramBot(createRouterSpy(), {
      botInstance: new FakeTelegramBot(),
      interactionMode: 'guided_strict',
      guidedQuotesTextFallback: true,
      pollingIdleWatchdogMs: 0,
      pollingWatchdogIntervalMs: 0,
    });

    const chatId = 'chat-guided-state-fresh-1';
    const before = Date.now();
    const state = runtime.setGuidedActionState(chatId, 'record_bet');
    const after = Date.now();

    assert.equal(state.action, 'record_bet');
    assert.ok(state.setAt >= before && state.setAt <= after, 'setAt debe ser el timestamp del set');
    assert.equal(runtime.isGuidedActionFresh(chatId, { maxAgeMs: 45 * 60 * 1000 }), true);
    runtime.close();
  });

  tests.push(async () => {
    let mockNow = 1_000_000;
    const runtime = startTelegramBot(createRouterSpy(), {
      botInstance: new FakeTelegramBot(),
      interactionMode: 'guided_strict',
      guidedQuotesTextFallback: true,
      pollingIdleWatchdogMs: 0,
      pollingWatchdogIntervalMs: 0,
      nowProvider: () => mockNow,
    });

    const chatId = 'chat-guided-state-stale-1';
    runtime.setGuidedActionState(chatId, 'record_bet');
    mockNow += 46 * 60 * 1000; // avanza el reloj inyectado 46 minutos (sin tocar el estado devuelto)

    assert.equal(runtime.isGuidedActionFresh(chatId, { maxAgeMs: 45 * 60 * 1000 }), false);
    runtime.close();
  });

  tests.push(async () => {
    const runtime = startTelegramBot(createRouterSpy(), {
      botInstance: new FakeTelegramBot(),
      interactionMode: 'guided_strict',
      guidedQuotesTextFallback: true,
      pollingIdleWatchdogMs: 0,
      pollingWatchdogIntervalMs: 0,
    });

    assert.equal(
      runtime.isGuidedActionFresh('chat-never-set-1', { maxAgeMs: 45 * 60 * 1000 }),
      false
    );
    runtime.close();
  });

  tests.push(async () => {
    const runtime = startTelegramBot(createRouterSpy(), {
      botInstance: new FakeTelegramBot(),
      interactionMode: 'guided_strict',
      guidedQuotesTextFallback: true,
      pollingIdleWatchdogMs: 0,
      pollingWatchdogIntervalMs: 0,
    });

    const chatId = 'chat-guided-state-fightcontext-1';
    runtime.setGuidedActionState(chatId, 'record_bet', { fightId: 'x' });

    assert.deepEqual(runtime.getGuidedActionState(chatId).fightContext, { fightId: 'x' });
    runtime.close();
  });

  tests.push(async () => {
    const runtime = startTelegramBot(createRouterSpy(), {
      botInstance: new FakeTelegramBot(),
      interactionMode: 'guided_strict',
      guidedQuotesTextFallback: true,
      pollingIdleWatchdogMs: 0,
      pollingWatchdogIntervalMs: 0,
    });

    const chatId = 'chat-guided-action-wrapper-1';
    runtime.setGuidedAction(chatId, 'record_bet');
    assert.equal(runtime.getGuidedAction(chatId), 'record_bet');
    runtime.close();
  });

  for (const test of tests) {
    await test();
  }

  console.log('All telegramBot tests passed.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runTelegramBotTests().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
