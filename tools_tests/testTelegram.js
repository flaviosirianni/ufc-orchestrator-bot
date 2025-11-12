console.log("🟢 Test iniciado");

import TelegramBot from "node-telegram-bot-api";
import dotenv from "dotenv";
dotenv.config();

const token = process.env.TELEGRAM_BOT_TOKEN;

if (!token) {
  console.error("❌ No se encontró TELEGRAM_BOT_TOKEN en .env");
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });

bot.on("message", (msg) => {
  console.log(`📨 Mensaje recibido de ${msg.from.first_name}: ${msg.text}`);
  bot.sendMessage(msg.chat.id, "✅ Bot funcionando correctamente en Telegram!");
});

console.log("🤖 Bot de prueba iniciado. Mandale un mensaje en Telegram!");