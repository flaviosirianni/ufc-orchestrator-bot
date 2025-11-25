import TelegramBot from 'node-telegram-bot-api';
import dotenv from 'dotenv';
dotenv.config();

export function startTelegramBot(router) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const bot = new TelegramBot(token, { polling: true });

  bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const userMessage = msg.text || '';

    console.log(`📩 Mensaje recibido: ${userMessage}`);

    const reply = await router.routeMessage(userMessage);
    bot.sendMessage(chatId, reply || 'No tengo respuesta para eso aún 😅');
  });

  console.log('🤖 Telegram bot iniciado y esperando mensajes...');
}
