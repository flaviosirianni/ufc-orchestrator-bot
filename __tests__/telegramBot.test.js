import assert from 'node:assert/strict';
import { normalizeGuidedMenuId, startTelegramBot } from '../src/core/telegramBot.js';

class FakeTelegramBot {
  constructor() {
    this.handlers = new Map();
    this.sentMessages = [];
    this.chatActions = [];
    this.answeredCallbacks = [];
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
  messageId = 1,
  chatId = 100,
  userId = 200,
  photo = undefined,
} = {}) {
  return {
    message_id: messageId,
    text,
    chat: { id: chatId, type: 'private' },
    from: { id: userId, first_name: 'QA' },
    ...(photo ? { photo } : {}),
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
    assert.match(out.text, /modo guiado activo/i);
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
      'message',
      createBaseMessage({
        text: 'UFC 325, Holloway vs Oliveira, ML Holloway @2.10',
      })
    );

    assert.equal(router.calls.length, 1);
    assert.equal(router.calls[0].interactionMode, 'guided_strict');
    assert.equal(router.calls[0].guidedAction, 'analyze_quotes');
    assert.equal(router.calls[0].inputType, 'text_odds');
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
    assert.equal(router.calls[0].inputType, 'text_bet_record');
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
        text: 'bet_id 42 LOST',
      })
    );

    assert.equal(router.calls.length, 1);
    assert.equal(router.calls[0].guidedAction, 'settle_bet');
    assert.equal(router.calls[0].inputType, 'text_bet_settle');
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
    assert.equal(router.calls[1].inputType, 'text_bet_settle');
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

    await fakeBot.emit(
      'message',
      createBaseMessage({
        text: 'hola',
      })
    );

    assert.equal(router.calls.length, 0);
    const out = fakeBot.sentMessages[fakeBot.sentMessages.length - 1];
    assert.match(out.text, /modo guiado - cerrar apuesta/i);
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
        data: 'qa:nutrition_view_summary',
      })
    );

    assert.equal(router.calls.length, 1);
    assert.equal(router.calls[0].guidedAction, 'view_summary');
    assert.equal(router.calls[0].inputType, 'synthetic');
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
        text: 'hola',
      })
    );

    assert.equal(router.calls.length, 0);
    const out = fakeBot.sentMessages[fakeBot.sentMessages.length - 1];
    assert.match(out.text, /modo guiado - registrar pesaje/i);
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
