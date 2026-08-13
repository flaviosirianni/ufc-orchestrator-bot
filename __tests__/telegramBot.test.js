import assert from 'node:assert/strict';
import {
  normalizeGuidedMenuId,
  resolveGuidedMessageDecision,
  startTelegramBot,
  isGuidedCallbackAllowed,
  getFightContextByIdForStore,
} from '../src/core/telegramBot.js';
import { createUfcPolicyRouter } from '../src/bots/ufc/index.js';

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

  // Fast-follow (2026-08-12 review round 2): resolveGuidedMessageDecision's
  // unrecognized-action fallback must resolve per-bot, via getDefaultGuidedAction,
  // not the UFC-hardcoded 'analyze_quotes'. GUIDED_INPUT_ACTIONS never having
  // included any Ovidius med_* action name is a separate, pre-existing bug
  // (WISHLIST item 44, out of scope here) -- but before this fix, that gap made
  // resolveGuidedMessageDecision re-coerce an already-mangled 'med_free_chat'
  // state even further, to the UFC-specific 'analyze_quotes', which the Ovidius
  // router's guidedAction checks never match, so free-text follow-ups always
  // fell through to a generic fallback. Resolving the default per-menu (instead
  // of hardcoding UFC's) restores 'med_free_chat', which the Ovidius router DOES
  // recognize -- this is a partial mitigation, not a fix for the whitelist gap:
  // any other real med_* action still collapses to med_free_chat too (see the
  // second test below), since that specific name is already lost by the time
  // it's stored in guidedActionByChat.
  tests.push(() => {
    const decision = resolveGuidedMessageDecision({
      cleanMessage: 'me duele la cabeza',
      hasMedia: false,
      activeGuidedActionState: { action: 'med_free_chat', fightContext: null, setAt: Date.now() },
      guidedMenuId: 'ovidius_v1',
    });

    assert.equal(decision.action, 'route');
    assert.equal(decision.guidedAction, 'med_free_chat');
  });

  tests.push(() => {
    // Confirms the fix is intentionally partial: a real, specific med_* action
    // OTHER than med_free_chat still resolves to med_free_chat, not itself --
    // that name is already gone by the time it reaches this function (mangled
    // upstream at setGuidedActionState time, since it isn't in
    // GUIDED_INPUT_ACTIONS either). Fixing this fully needs the whitelist audit
    // tracked in WISHLIST item 44, deliberately not done here.
    const decision = resolveGuidedMessageDecision({
      cleanMessage: '',
      hasMedia: true,
      activeGuidedActionState: { action: 'med_upload_document', fightContext: null, setAt: Date.now() },
      guidedMenuId: 'ovidius_v1',
    });

    assert.equal(decision.guidedAction, 'med_free_chat');
  });

  tests.push(() => {
    // UFC's own default must stay analyze_quotes and must not regress to
    // reading Ovidius's/Nutrition's default when the active action is missing
    // or unrecognized (empty string exercises normalizeGuidedAction's fallback
    // branch the same way an unrecognized action string would).
    const decision = resolveGuidedMessageDecision({
      cleanMessage: 'algo',
      hasMedia: false,
      activeGuidedActionState: { action: '', fightContext: null, setAt: Date.now() },
      guidedMenuId: 'ufc_v1',
    });

    assert.equal(decision.guidedAction, 'analyze_quotes');
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

  // Task 4 (guided-menu-unification): fight-scoped callback allowlist regex.
  tests.push(() => {
    assert.equal(
      isGuidedCallbackAllowed('qa:record_bet_for:b23487230c72d1a9c46a58cf02db58cc', { ledgerEnabled: true, guidedMenuId: 'ufc_v1' }),
      true
    );
    assert.equal(
      isGuidedCallbackAllowed('qa:analyze_quotes_for:fight_1', { ledgerEnabled: true, guidedMenuId: 'ufc_v1' }),
      true
    );
    assert.equal(
      isGuidedCallbackAllowed('qa:record_bet_for:', { ledgerEnabled: true, guidedMenuId: 'ufc_v1' }),
      false,
      'un fight_id vacio no debe pasar el allowlist'
    );
    assert.equal(
      isGuidedCallbackAllowed('qa:record_bet_for:drop table bets', { ledgerEnabled: true, guidedMenuId: 'ufc_v1' }),
      false,
      'el fight_id debe ser alfanumerico, nada de texto libre en el callback_data'
    );
  });

  // Review fix (guided-menu-unification, Task 4+5 commit 8282fe4): Telegram's
  // inline-button callback_data has a hard 64-BYTE limit on the WHOLE string,
  // prefix included -- not 64 chars on the fight_id alone. 'qa:record_bet_for:'
  // is 18 bytes, 'qa:analyze_quotes_for:' is 22 bytes (both ASCII, so
  // bytes === chars), so the safe fight_id ceiling is 64-18=46 and 64-22=42
  // respectively. These pin that boundary so a future edit can't silently
  // widen it back past what Telegram will actually accept.
  tests.push(() => {
    const maxRecordBetFightId = 'x'.repeat(46);
    const overRecordBetFightId = 'x'.repeat(47);
    assert.equal(
      isGuidedCallbackAllowed(`qa:record_bet_for:${maxRecordBetFightId}`, { ledgerEnabled: true, guidedMenuId: 'ufc_v1' }),
      true,
      'fight_id de 46 chars (18 + 46 = 64 bytes) es el limite real de callback_data y debe pasar'
    );
    assert.equal(
      isGuidedCallbackAllowed(`qa:record_bet_for:${overRecordBetFightId}`, { ledgerEnabled: true, guidedMenuId: 'ufc_v1' }),
      false,
      'fight_id de 47 chars excede los 64 bytes de callback_data y debe rechazarse'
    );

    const maxAnalyzeQuotesFightId = 'x'.repeat(42);
    const overAnalyzeQuotesFightId = 'x'.repeat(43);
    assert.equal(
      isGuidedCallbackAllowed(`qa:analyze_quotes_for:${maxAnalyzeQuotesFightId}`, { ledgerEnabled: true, guidedMenuId: 'ufc_v1' }),
      true,
      'fight_id de 42 chars (22 + 42 = 64 bytes) es el limite real de callback_data y debe pasar'
    );
    assert.equal(
      isGuidedCallbackAllowed(`qa:analyze_quotes_for:${overAnalyzeQuotesFightId}`, { ledgerEnabled: true, guidedMenuId: 'ufc_v1' }),
      false,
      'fight_id de 43 chars excede los 64 bytes de callback_data y debe rechazarse'
    );
  });

  // Task 5 (guided-menu-unification): resolve a fight_id to fighter/event
  // context via the store-parameterized helper (testable without the whole
  // startTelegramBot closure).
  tests.push(() => {
    const fakeStore = {
      getEventWatchState(watchKey) {
        if (watchKey === 'next_event') {
          return { eventId: 'ufc_islam_makhachev_vs_ian_garry_2026-08-15', eventName: 'UFC: Islam Makhachev vs Ian Garry' };
        }
        return null;
      },
      getEventFightMirror(watchKey) {
        if (watchKey === 'next_event') {
          return [
            { fightId: 'fight_1', fighterA: 'Islam Makhachev', fighterB: 'Ian Garry' },
            { fightId: 'fight_2', fighterA: 'Mackenzie Dern', fighterB: 'Gillian Robertson' },
          ];
        }
        return [];
      },
    };

    const context = getFightContextByIdForStore(fakeStore, 'fight_2');

    assert.deepEqual(context, {
      fightId: 'fight_2',
      fighterA: 'Mackenzie Dern',
      fighterB: 'Gillian Robertson',
      eventId: 'ufc_islam_makhachev_vs_ian_garry_2026-08-15',
      eventName: 'UFC: Islam Makhachev vs Ian Garry',
    });
  });

  tests.push(() => {
    const fakeStore = {
      getEventWatchState() { return null; },
      getEventFightMirror() { return []; },
    };

    assert.equal(getFightContextByIdForStore(fakeStore, 'fight_1'), null);
  });

  // Review fix (guided-menu-unification, Task 4+5 commit 8282fe4): the tests
  // above only exercise getFightContextByIdForStore and isGuidedCallbackAllowed
  // in isolation -- neither fires an actual callback_query through
  // startTelegramBot, so the dispatch handlers themselves (the DI wiring,
  // the fightContext attach, the null-fightContext fallback, the
  // ledger-disabled guard) had zero coverage. These four follow the
  // established fakeBot.emit('callback_query', ...) pattern used throughout
  // this file (see the qa:record_bet callback tests above) to close that gap.

  tests.push(async () => {
    // Resolvable fight_id through the full DI wiring: options.getEventFightMirror
    // / getEventWatchState -> getFightContextById -> the sent hint names the
    // real fighters -> guided-action state carries the resolved fightContext.
    const fakeBot = new FakeTelegramBot();
    const router = createRouterSpy();
    const fakeStore = {
      getEventWatchState(watchKey) {
        if (watchKey === 'next_event') {
          return { eventId: 'evt_dispatch_1', eventName: 'UFC Fight Night: Dispatch Test' };
        }
        return null;
      },
      getEventFightMirror(watchKey) {
        if (watchKey === 'next_event') {
          return [{ fightId: 'fight_dispatch_1', fighterA: 'Dispatch Fighter A', fighterB: 'Dispatch Fighter B' }];
        }
        return [];
      },
    };

    const runtime = startTelegramBot(router, {
      botInstance: fakeBot,
      interactionMode: 'guided_strict',
      guidedQuotesTextFallback: true,
      pollingIdleWatchdogMs: 0,
      pollingWatchdogIntervalMs: 0,
      getEventFightMirror: fakeStore.getEventFightMirror,
      getEventWatchState: fakeStore.getEventWatchState,
    });

    await fakeBot.emit(
      'callback_query',
      createBaseCallback({
        data: 'qa:record_bet_for:fight_dispatch_1',
      })
    );

    const out = fakeBot.sentMessages[fakeBot.sentMessages.length - 1];
    assert.match(out.text, /Dispatch Fighter A vs Dispatch Fighter B/);

    const state = runtime.getGuidedActionState(100);
    assert.equal(state.action, 'record_bet');
    assert.deepEqual(state.fightContext, {
      fightId: 'fight_dispatch_1',
      fighterA: 'Dispatch Fighter A',
      fighterB: 'Dispatch Fighter B',
      eventId: 'evt_dispatch_1',
      eventName: 'UFC Fight Night: Dispatch Test',
    });

    runtime.close();
  });

  tests.push(async () => {
    // Unresolvable fight_id through the real dispatch path: the store is
    // wired, but the id in callback_data matches nothing in it. Must fall
    // back to the generic hint (never "undefined vs undefined"), and store
    // guided-action state with fightContext: null rather than a half-filled
    // object.
    const fakeBot = new FakeTelegramBot();
    const router = createRouterSpy();
    const fakeStore = {
      getEventWatchState(watchKey) {
        if (watchKey === 'next_event') {
          return { eventId: 'evt_dispatch_2', eventName: 'UFC Fight Night: Dispatch Test 2' };
        }
        return null;
      },
      getEventFightMirror(watchKey) {
        if (watchKey === 'next_event') {
          return [{ fightId: 'fight_dispatch_1', fighterA: 'Dispatch Fighter A', fighterB: 'Dispatch Fighter B' }];
        }
        return [];
      },
    };

    const runtime = startTelegramBot(router, {
      botInstance: fakeBot,
      interactionMode: 'guided_strict',
      guidedQuotesTextFallback: true,
      pollingIdleWatchdogMs: 0,
      pollingWatchdogIntervalMs: 0,
      getEventFightMirror: fakeStore.getEventFightMirror,
      getEventWatchState: fakeStore.getEventWatchState,
    });

    await fakeBot.emit(
      'callback_query',
      createBaseCallback({
        data: 'qa:analyze_quotes_for:fight_does_not_exist',
      })
    );

    const out = fakeBot.sentMessages[fakeBot.sentMessages.length - 1];
    assert.doesNotMatch(out.text, /undefined/i);
    assert.doesNotMatch(out.text, /Analizando cuotas para/);

    const state = runtime.getGuidedActionState(100);
    assert.equal(state.action, 'analyze_quotes');
    assert.equal(state.fightContext, null);

    runtime.close();
  });

  tests.push(async () => {
    // startTelegramBot with getEventFightMirror/getEventWatchState not wired
    // at all -- simulates Nutrition/Ovidius (or any other composition root)
    // reusing this file without the UFC-specific verifiedEventStoreView
    // plumbing. Must degrade to the generic hint, never throw.
    const fakeBot = new FakeTelegramBot();
    const router = createRouterSpy();

    const runtime = startTelegramBot(router, {
      botInstance: fakeBot,
      interactionMode: 'guided_strict',
      guidedQuotesTextFallback: true,
      pollingIdleWatchdogMs: 0,
      pollingWatchdogIntervalMs: 0,
    });

    await fakeBot.emit(
      'callback_query',
      createBaseCallback({
        data: 'qa:record_bet_for:fight_dispatch_1',
      })
    );

    const out = fakeBot.sentMessages[fakeBot.sentMessages.length - 1];
    assert.doesNotMatch(out.text, /undefined/i);
    assert.doesNotMatch(out.text, /Registrando apuesta para/);

    const state = runtime.getGuidedActionState(100);
    assert.equal(state.action, 'record_bet');
    assert.equal(state.fightContext, null);

    runtime.close();
  });

  tests.push(async () => {
    // guidedLedgerEnabled: false + qa:record_bet_for:<id> press -> the
    // ledger-disabled refusal message, and no guided-action state mutation
    // (the guard must return before ever calling getFightContextById).
    const fakeBot = new FakeTelegramBot();
    const router = createRouterSpy();

    const runtime = startTelegramBot(router, {
      botInstance: fakeBot,
      interactionMode: 'guided_strict',
      guidedLedgerEnabled: false,
      guidedQuotesTextFallback: true,
      pollingIdleWatchdogMs: 0,
      pollingWatchdogIntervalMs: 0,
    });

    await fakeBot.emit(
      'callback_query',
      createBaseCallback({
        data: 'qa:record_bet_for:fight_dispatch_1',
      })
    );

    const out = fakeBot.sentMessages[fakeBot.sentMessages.length - 1];
    assert.match(out.text, /ledger habilitado/i);

    assert.equal(runtime.getGuidedActionState(100), null);

    runtime.close();
  });

  // --- guided-menu-unification Task 7: multi-message replies[] plumbing ---

  tests.push(async () => {
    // createUfcPolicyRouter (src/bots/ufc/index.js) single-reply case: must
    // still return an OBJECT shape {text, replies:null} -- never a bare
    // string -- because deliverToRouter/routeSyntheticAction read .text off
    // whatever this wrapper returns. Using medical_guidance_companion
    // (alwaysAppendNotice: true) proves enforcePolicyPack actually ran.
    const rawRouter = {
      async routeMessage() {
        return { text: 'Respuesta simple', replies: null };
      },
    };
    const router = createUfcPolicyRouter({
      rawRouter,
      manifest: { risk_policy: 'medical_guidance_companion' },
    });

    const result = await router.routeMessage('hola');
    assert.equal(typeof result, 'object');
    assert.equal(result.replies, null);
    assert.match(result.text, /Respuesta simple/);
    assert.match(result.text, /no reemplaza la consulta médica profesional/i);
  });

  tests.push(async () => {
    // createUfcPolicyRouter replies[] case: each entry's text is
    // policy-enforced INDIVIDUALLY (not just the joined top-level text),
    // and each entry's replyMarkup passes through untouched.
    const rawRouter = {
      async routeMessage() {
        return {
          text: 'Pelea 1: A vs B\n\nPelea 2: C vs D',
          replies: [
            {
              text: 'Pelea 1: A vs B',
              replyMarkup: {
                inline_keyboard: [[{ text: 'Registrar', callback_data: 'qa:record_bet_for:f1' }]],
              },
            },
            { text: 'Pelea 2: C vs D', replyMarkup: null },
          ],
        };
      },
    };
    const router = createUfcPolicyRouter({
      rawRouter,
      manifest: { risk_policy: 'medical_guidance_companion' },
    });

    const result = await router.routeMessage('proyecciones');
    assert.ok(Array.isArray(result.replies));
    assert.equal(result.replies.length, 2);
    assert.match(result.replies[0].text, /Pelea 1: A vs B/);
    assert.match(result.replies[0].text, /no reemplaza la consulta médica profesional/i);
    assert.match(result.replies[1].text, /Pelea 2: C vs D/);
    assert.match(result.replies[1].text, /no reemplaza la consulta médica profesional/i);
    assert.deepEqual(result.replies[0].replyMarkup, {
      inline_keyboard: [[{ text: 'Registrar', callback_data: 'qa:record_bet_for:f1' }]],
    });
    assert.equal(result.replies[1].replyMarkup, null);
    assert.match(result.text, /no reemplaza la consulta médica profesional/i);
  });

  tests.push(async () => {
    // createUfcPolicyRouter defensive guard: even if rawRouter ever
    // returned a bare string (not the case for the real routerChain.js
    // post Task 7, but this wrapper must not assume it), the wrapper still
    // normalizes to an object shape instead of leaking the string raw or
    // stringifying it into "[object Object]".
    const rawRouter = {
      async routeMessage() {
        return 'respuesta en texto plano';
      },
    };
    const router = createUfcPolicyRouter({
      rawRouter,
      manifest: { risk_policy: 'general_safe_advice' },
    });

    const result = await router.routeMessage('hola');
    assert.equal(typeof result, 'object');
    assert.equal(result.text, 'respuesta en texto plano');
    assert.equal(result.replies, null);
  });

  tests.push(async () => {
    // createUfcPolicyRouter defensive guard, null/undefined variant: a
    // bare null or undefined return from rawRouter.routeMessage() (not a
    // string, not an object) must still normalize to a safe {text, replies}
    // object instead of throwing when reading rawResult.replies/.text off
    // of it downstream.
    for (const bareValue of [null, undefined]) {
      const rawRouter = {
        async routeMessage() {
          return bareValue;
        },
      };
      const router = createUfcPolicyRouter({
        rawRouter,
        manifest: { risk_policy: 'general_safe_advice' },
      });

      const result = await router.routeMessage('hola');
      assert.equal(typeof result, 'object', `expected object result for rawRouter returning ${bareValue}`);
      assert.equal(result.text, '');
      assert.equal(result.replies, null);
    }
  });

  tests.push(async () => {
    // End-to-end: a router returning {text, replies:[...]} (the shape
    // createUfcPolicyRouter now produces) must make deliverToRouter send
    // ONE Telegram message per entry, in order, each with its own
    // replyMarkup -- this is the actual feature this task adds.
    const fakeBot = new FakeTelegramBot();
    const router = {
      async routeMessage() {
        return {
          text: 'Pelea 1 Prochazka vs Ulberg\n\nPelea 2 Dern vs Robertson',
          replies: [
            {
              text: 'Pelea 1 Prochazka vs Ulberg',
              replyMarkup: {
                inline_keyboard: [[{ text: 'Registrar', callback_data: 'qa:record_bet_for:fight_1' }]],
              },
            },
            {
              text: 'Pelea 2 Dern vs Robertson',
              replyMarkup: {
                inline_keyboard: [[{ text: 'Registrar', callback_data: 'qa:record_bet_for:fight_2' }]],
              },
            },
          ],
        };
      },
    };

    const runtime = startTelegramBot(router, {
      botInstance: fakeBot,
      interactionMode: 'guided_strict',
      guidedQuotesTextFallback: true,
      pollingIdleWatchdogMs: 0,
      pollingWatchdogIntervalMs: 0,
      downloadFileImpl: async () => ({ buffer: Buffer.from('x'), filePath: 'x.jpg' }),
    });

    // First set guided-action state via a callback press (a free-text
    // message with no prior guided action is blocked by
    // resolveGuidedMessageDecision in guided_strict mode). That callback
    // press itself sends one hint message, so the two replies[] messages
    // are the ones sent AFTER it, once the free-text message routes.
    await fakeBot.emit('callback_query', createBaseCallback({ data: 'qa:analyze_quotes' }));
    const messagesBeforeRouting = fakeBot.sentMessages.length;

    await fakeBot.emit(
      'message',
      createBaseMessage({ messageId: 5001, text: 'proyecciones para el evento' })
    );

    const sent = fakeBot.sentMessages.slice(messagesBeforeRouting);
    assert.equal(sent.length, 2, `expected 2 reply messages, got ${sent.length}`);
    assert.match(sent[0].text, /Pelea 1 Prochazka vs Ulberg/);
    assert.match(sent[1].text, /Pelea 2 Dern vs Robertson/);
    assert.deepEqual(extractCallbackDataList(sent[0]), ['qa:record_bet_for:fight_1']);
    assert.deepEqual(extractCallbackDataList(sent[1]), ['qa:record_bet_for:fight_2']);

    runtime.close();
  });

  tests.push(async () => {
    // Code review follow-up (Important finding on commit a9baaa0): one
    // entry failing to send in the replies[] loop must not abort the rest
    // of the card, and must not become an unhandled promise rejection.
    // sendBotMessage re-throws on anything other than a parse_mode failure
    // (network blip, Telegram 429 flood-control) -- simulate that by
    // making the underlying bot.sendMessage throw for one specific entry's
    // text (on both the primary HTML attempt and sendBotMessage's own
    // plain-text fallback retry, since both carry the same marker) and
    // confirm the remaining entries still go out.
    class FlakyTelegramBot extends FakeTelegramBot {
      async sendMessage(chatId, text, options = {}) {
        if (String(text || '').includes('WILL_FAIL')) {
          throw new Error('simulated Telegram 429 flood-control');
        }
        return super.sendMessage(chatId, text, options);
      }
    }

    const fakeBot = new FlakyTelegramBot();
    const router = {
      async routeMessage() {
        return {
          text: 'card',
          replies: [
            { text: 'Pelea 1 WILL_FAIL', replyMarkup: null },
            { text: 'Pelea 2 ok', replyMarkup: null },
            { text: 'Pelea 3 ok', replyMarkup: null },
          ],
        };
      },
    };

    const runtime = startTelegramBot(router, {
      botInstance: fakeBot,
      interactionMode: 'guided_strict',
      guidedQuotesTextFallback: true,
      pollingIdleWatchdogMs: 0,
      pollingWatchdogIntervalMs: 0,
      downloadFileImpl: async () => ({ buffer: Buffer.from('x'), filePath: 'x.jpg' }),
    });

    await fakeBot.emit('callback_query', createBaseCallback({ data: 'qa:analyze_quotes' }));
    const messagesBeforeRouting = fakeBot.sentMessages.length;

    // Must resolve without throwing even though entry 1 fails both of
    // sendBotMessage's internal attempts.
    await fakeBot.emit(
      'message',
      createBaseMessage({ messageId: 5010, text: 'proyecciones para el evento' })
    );

    const sent = fakeBot.sentMessages.slice(messagesBeforeRouting);
    assert.equal(sent.length, 2, `expected 2 surviving reply messages, got ${sent.length}`);
    assert.match(sent[0].text, /Pelea 2 ok/);
    assert.match(sent[1].text, /Pelea 3 ok/);

    runtime.close();
  });

  tests.push(async () => {
    // Regression: an object-shaped reply with an empty/falsy .text and no
    // populated .replies (e.g. {text: '', replies: null} or {text: '',
    // replies: []}) must fall back to the "no tengo respuesta" message --
    // NOT get treated as a non-object and passed to sendBotMessage as-is,
    // which would stringify the object to the literal text
    // "[object Object]" and ship that to the user.
    const fakeBot = new FakeTelegramBot();
    const router = {
      async routeMessage() {
        return { text: '', replies: null };
      },
    };

    const runtime = startTelegramBot(router, {
      botInstance: fakeBot,
      interactionMode: 'guided_strict',
      guidedQuotesTextFallback: true,
      pollingIdleWatchdogMs: 0,
      pollingWatchdogIntervalMs: 0,
      downloadFileImpl: async () => ({ buffer: Buffer.from('x'), filePath: 'x.jpg' }),
    });

    await fakeBot.emit('callback_query', createBaseCallback({ data: 'qa:analyze_quotes' }));
    const messagesBeforeRouting = fakeBot.sentMessages.length;

    await fakeBot.emit(
      'message',
      createBaseMessage({ messageId: 5002, text: 'proyecciones para el evento' })
    );

    const sent = fakeBot.sentMessages.slice(messagesBeforeRouting);
    assert.equal(sent.length, 1);
    assert.doesNotMatch(sent[0].text, /object Object/i);
    assert.match(sent[0].text, /No tengo respuesta/i);

    runtime.close();
  });

  tests.push(async () => {
    // Same regression, but with an explicit empty array (replies: []) as
    // opposed to replies: null -- a distinct value that exercises the
    // Array.isArray(reply?.replies) && reply.replies.length check
    // separately (an empty array is truthy, so a naive `reply?.replies`
    // truthiness check alone would not catch this case).
    const fakeBot = new FakeTelegramBot();
    const router = {
      async routeMessage() {
        return { text: '', replies: [] };
      },
    };

    const runtime = startTelegramBot(router, {
      botInstance: fakeBot,
      interactionMode: 'guided_strict',
      guidedQuotesTextFallback: true,
      pollingIdleWatchdogMs: 0,
      pollingWatchdogIntervalMs: 0,
      downloadFileImpl: async () => ({ buffer: Buffer.from('x'), filePath: 'x.jpg' }),
    });

    await fakeBot.emit('callback_query', createBaseCallback({ data: 'qa:analyze_quotes' }));
    const messagesBeforeRouting = fakeBot.sentMessages.length;

    await fakeBot.emit(
      'message',
      createBaseMessage({ messageId: 5003, text: 'proyecciones para el evento' })
    );

    const sent = fakeBot.sentMessages.slice(messagesBeforeRouting);
    assert.equal(sent.length, 1);
    assert.doesNotMatch(sent[0].text, /object Object/i);
    assert.match(sent[0].text, /No tengo respuesta/i);

    runtime.close();
  });

  tests.push(async () => {
    // routeSyntheticAction must unwrap an object-shaped {text, replies}
    // router result (the shape createUfcPolicyRouter always returns as of
    // this task) back down to a plain string for its callback callers
    // (qa:view_credits here), which still expect a bare string/null and
    // pass it straight into sendBotMessage. Before this task's Step 5 fix,
    // this would have shipped "[object Object]" or silently fallen back to
    // "No pude completar esa accion ahora mismo." to every such caller,
    // across every bot sharing this code (not just UFC).
    const fakeBot = new FakeTelegramBot();
    const router = {
      calls: [],
      async routeMessage(payload) {
        this.calls.push(payload);
        return { text: 'CREDITOS_OK_OBJECT_SHAPE', replies: null };
      },
    };

    startTelegramBot(router, {
      botInstance: fakeBot,
      interactionMode: 'guided_strict',
      guidedQuotesTextFallback: true,
      downloadFileImpl: async () => ({ buffer: Buffer.from('x'), filePath: 'x.jpg' }),
    });

    await fakeBot.emit('callback_query', createBaseCallback({ data: 'qa:view_credits' }));

    assert.equal(router.calls.length, 1);
    assert.equal(router.calls[0].inputType, 'synthetic');

    const out = fakeBot.sentMessages[fakeBot.sentMessages.length - 1];
    assert.match(out.text, /CREDITOS_OK_OBJECT_SHAPE/);
    assert.doesNotMatch(out.text, /object Object/i);
    assert.doesNotMatch(out.text, /No pude completar/i);
  });

  tests.push(async () => {
    // Same routeSyntheticAction unwrap, but confirming the plain-string
    // contract used by Ovidius/Nutrition/scaffolded-template routers (none
    // of which touch routerChain.js, and several of which return bare
    // strings straight from routeMessage) still works unchanged -- the
    // unwrap must not assume every router became object-shaped.
    const fakeBot = new FakeTelegramBot();
    const router = {
      calls: [],
      async routeMessage(payload) {
        this.calls.push(payload);
        return 'CREDITOS_OK_STRING_SHAPE';
      },
    };

    startTelegramBot(router, {
      botInstance: fakeBot,
      interactionMode: 'guided_strict',
      guidedQuotesTextFallback: true,
      downloadFileImpl: async () => ({ buffer: Buffer.from('x'), filePath: 'x.jpg' }),
    });

    await fakeBot.emit('callback_query', createBaseCallback({ data: 'qa:view_credits' }));

    const out = fakeBot.sentMessages[fakeBot.sentMessages.length - 1];
    assert.match(out.text, /CREDITOS_OK_STRING_SHAPE/);
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
