import './env.js';
import TelegramBot from 'node-telegram-bot-api';

export function startTelegramBot(router) {
  const token = process.env.TELEGRAM_BOT_TOKEN;

  if (!token) {
    throw new Error(
      'TELEGRAM_BOT_TOKEN is not set. Create a bot via BotFather and update your .env file.'
    );
  }

  const bot = new TelegramBot(token, { polling: true });

  bot.on('polling_error', (error) => {
    console.error('Telegram polling error', error);
  });

  bot.on('message', async (msg) => {
    const chatId = msg.chat?.id;
    const text = msg.text;

    if (!chatId || typeof text !== 'string') {
      return;
    }

    try {
      const response = await router.routeMessage(text, msg);
      await bot.sendMessage(chatId, response);
    } catch (error) {
      console.error('Failed to process Telegram message', error);
      await bot.sendMessage(
        chatId,
        'An internal error occurred while handling your request. Please try again later.'
      );
    }
  });

  console.log('🤖 Telegram bot polling has started.');

  return {
    stop() {
      bot.stopPolling();
    },
  };
}

export default {
  startTelegramBot,
};
