import TelegramBot from 'node-telegram-bot-api';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import OpenAI, { toFile } from 'openai';
import ffmpegPath from 'ffmpeg-static';
import { toTelegramHtml, toTelegramPlainText } from './messageFormatter.js';

const execFileAsync = promisify(execFile);

const MAX_MEDIA_BYTES = Number(process.env.MAX_MEDIA_BYTES ?? String(25 * 1024 * 1024));
const AUDIO_TRANSCRIBE_MODEL = process.env.AUDIO_TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe';
const MAX_AUDIO_TRANSCRIPT_CHARS = Number(
  process.env.MAX_AUDIO_TRANSCRIPT_CHARS ?? '4000'
);
const MEDIA_GROUP_FLUSH_MS = Number(process.env.MEDIA_GROUP_FLUSH_MS ?? '900');
const FFMPEG_BINARY = ffmpegPath || 'ffmpeg';
const TYPING_ACTION_INTERVAL_MS = Number(process.env.TYPING_ACTION_INTERVAL_MS ?? '4500');

const MAIN_MENU_ROWS = [
  [
    { text: 'Apuestas', callback_data: 'menu:bets' },
    { text: 'Config', callback_data: 'menu:config' },
  ],
  [
    { text: 'Analizar pelea', callback_data: 'qa:analyze_fight' },
    { text: 'Analizar cuotas', callback_data: 'qa:analyze_quotes' },
  ],
  [
    { text: 'Registrar apuesta', callback_data: 'qa:record_bet' },
    { text: 'Ayuda', callback_data: 'qa:help' },
  ],
];

const BETS_MENU_ROWS = [
  [
    { text: 'Analizar pelea', callback_data: 'qa:analyze_fight' },
    { text: 'Analizar cuotas', callback_data: 'qa:analyze_quotes' },
  ],
  [
    { text: 'Abrir (setup)', callback_data: 'act:bet_open' },
    { text: 'Registrar', callback_data: 'act:bet_record' },
  ],
  [
    { text: 'Pendientes', callback_data: 'qa:list_pending' },
    { text: 'Cerrar', callback_data: 'qa:settle_bet' },
  ],
  [
    { text: 'Corregir ultima', callback_data: 'qa:undo_last' },
    { text: 'Ayuda', callback_data: 'qa:help' },
  ],
  [
    { text: '⬅ Volver', callback_data: 'menu:main' },
  ],
];

const CONFIG_MENU_ROWS = [
  [
    { text: 'Ver config', callback_data: 'qa:view_config' },
    { text: 'Stake minimo', callback_data: 'act:cfg_stake' },
  ],
  [
    { text: 'Unidad', callback_data: 'act:cfg_unit' },
    { text: 'Riesgo', callback_data: 'act:cfg_risk' },
  ],
  [
    { text: 'Bankroll', callback_data: 'act:cfg_bankroll' },
    { text: 'Timezone', callback_data: 'act:cfg_timezone' },
  ],
  [
    { text: 'Exposicion %', callback_data: 'act:cfg_utilization' },
    { text: 'Creditos', callback_data: 'qa:view_credits' },
  ],
  [
    { text: 'Ayuda', callback_data: 'qa:help' },
    { text: '⬅ Volver', callback_data: 'menu:main' },
  ],
];

const QUICK_ACTION_HINTS = {
  analyze_fight: [
    '🥊 Analizar pelea (sin cuotas)',
    'Pasame pelea y, si queres, evento.',
    'Ejemplo: `Zellhuber vs Green`',
    'Con eso te doy: escenario probable, claves tacticas, riesgos y lean principal.',
    'No hace falta mandar cuotas para este modo.',
  ].join('\n'),
  analyze_quotes: [
    '📸 Analizar cuotas',
    'Mandame screenshot completo de la pelea/evento (ML + O/U + metodo si aparece).',
    'Si preferis texto: evento, pelea, mercado, cuota.',
    'Con eso te devuelvo lectura + EV + stake sugerido.',
  ].join('\n'),
  bet_open: [
    '🚪 Abrir apuesta (setup, sin registrar todavía)',
    'Usalo para preparar la jugada antes de guardarla en ledger.',
    'Pasame: pelea + mercado + idea de entrada.',
    'Ejemplo: `Zellhuber vs Green, Under 2.5, entrar solo si @1.80+`.',
    'Te devuelvo plan de entrada (escenario, riesgos y trigger), pero no lo registra.',
  ].join('\n'),
  record_bet: [
    '🧾 Registrar apuesta al ledger',
    'Pasame estos datos:',
    '1) Evento',
    '2) Pelea',
    '3) Pick / mercado',
    '4) Cuota',
    '5) Stake o unidades',
    'Opcional: referencia/bookie.',
  ].join('\n'),
  settle_bet: [
    '✅ Cerrar apuesta',
    'Pasame: `bet_id` + resultado (`WON` o `LOST`).',
    'Ejemplo: `bet_id 31 WON`.',
    'Si no sabes el ID, usa "Ver pendientes".',
  ].join('\n'),
  config_stake: [
    '⚙️ Configurar stake minimo',
    'Mandame un mensaje como:',
    '- `mi stake minimo es $3000`',
    '- `minimo 4u por pick`',
    '- `mi stake minimo es $3000 y minimo 4u por pick`',
  ].join('\n'),
  config_profile: [
    '⚙️ Configurar perfil',
    'Podés pasarme datos como:',
    '- `unidad 600`',
    '- `riesgo moderado`',
    '- `bankroll 120000`',
    '- `timezone America/Argentina/Buenos_Aires`',
  ].join('\n'),
  config_unit: [
    '⚙️ Configurar unidad',
    'Mandame un mensaje como:',
    '- `unidad 600`',
    '- `mi unidad es 750`',
  ].join('\n'),
  config_risk: [
    '⚙️ Configurar riesgo',
    'Mandame un mensaje como:',
    '- `riesgo conservador`',
    '- `riesgo moderado`',
    '- `riesgo agresivo`',
  ].join('\n'),
  config_bankroll: [
    '⚙️ Configurar bankroll',
    'Mandame un mensaje como:',
    '- `bankroll 120000`',
    '- `mi bankroll es $90000`',
  ].join('\n'),
  config_timezone: [
    '⚙️ Configurar timezone',
    'Mandame un mensaje como:',
    '- `timezone America/Argentina/Buenos_Aires`',
    '- `tz America/Mexico_City`',
  ].join('\n'),
  config_utilization: [
    '⚙️ Configurar exposicion objetivo por evento',
    'Mandame un mensaje como:',
    '- `utilizacion objetivo 35%`',
    '- `exposicion objetivo evento 40`',
  ].join('\n'),
  help: [
    '🆘 Ayuda de botones',
    '',
    '📚 Apuestas',
    '- `Analizar pelea`: lectura cualitativa (sin cuotas).',
    '- `Analizar cuotas`: lectura + EV con odds/quotes.',
    '- `Abrir (setup)`: plan de entrada y riesgos sin registrar en ledger.',
    '- `Registrar`: guarda la apuesta en ledger.',
    '- `Pendientes`: lista apuestas abiertas con bet_id.',
    '- `Cerrar`: cierra una apuesta (`bet_id + WON/LOST`).',
    '- `Corregir ultima`: revierte la última mutación sensible.',
    '',
    '⚙️ Config',
    '- `Ver config`: muestra tus ajustes actuales.',
    '- `Stake minimo / Unidad / Riesgo / Bankroll / Timezone / Exposicion %`: actualizan tu perfil.',
    '- `Creditos`: muestra saldo y movimientos.',
    '',
    'Tip: podés seguir usando chat libre; los botones son atajos.',
  ].join('\n'),
};

const MENU_SCOPES = new Set(['main', 'bets', 'config']);

function normalizeMenuScope(scope = 'main') {
  const normalized = String(scope || '').trim().toLowerCase();
  return MENU_SCOPES.has(normalized) ? normalized : 'main';
}

function pickLargestPhoto(photos = []) {
  if (!photos.length) {
    return null;
  }

  return photos.reduce((largest, current) => {
    if (!largest) {
      return current;
    }
    const largestSize = largest.file_size ?? 0;
    const currentSize = current.file_size ?? 0;
    return currentSize > largestSize ? current : largest;
  }, null);
}

function fileExtension(filePath = '') {
  const ext = path.extname(filePath).toLowerCase().replace('.', '');
  return ext || '';
}

function guessImageMime(ext) {
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  return 'image/jpeg';
}

async function downloadTelegramFile(bot, token, fileId) {
  const file = await bot.getFile(fileId);
  const filePath = file.file_path;
  if (!filePath) {
    throw new Error('Telegram file_path missing.');
  }

  if (file.file_size && file.file_size > MAX_MEDIA_BYTES) {
    throw new Error('Archivo demasiado grande para procesar.');
  }

  const url = `https://api.telegram.org/file/bot${token}/${filePath}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`No pude descargar el archivo (${response.status}).`);
  }

  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength > MAX_MEDIA_BYTES) {
    throw new Error('Archivo demasiado grande para procesar.');
  }

  return {
    buffer: Buffer.from(arrayBuffer),
    filePath,
  };
}

async function convertAudioToMp3(buffer, inputExt = 'ogg') {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ufc-audio-'));
  const inputPath = path.join(tempDir, `input.${inputExt || 'ogg'}`);
  const outputPath = path.join(tempDir, 'output.mp3');

  try {
    await fs.writeFile(inputPath, buffer);
    await execFileAsync(FFMPEG_BINARY, ['-y', '-i', inputPath, outputPath]);
    const outBuffer = await fs.readFile(outputPath);
    return outBuffer;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

function buildImageInput(buffer, mimeType) {
  const base64 = buffer.toString('base64');
  return {
    type: 'input_image',
    image_url: `data:${mimeType};base64,${base64}`,
    detail: 'auto',
  };
}

function buildAudioInput(buffer, format = 'mp3') {
  return {
    type: 'input_audio',
    input_audio: {
      data: buffer.toString('base64'),
      format,
    },
  };
}

function getOpenAIClient() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY no esta configurada para transcribir audio.');
  }
  return new OpenAI({ apiKey });
}

async function transcribeAudio(buffer, filename = 'audio.mp3') {
  const client = getOpenAIClient();
  const file = await toFile(buffer, filename);
  const response = await client.audio.transcriptions.create({
    model: AUDIO_TRANSCRIBE_MODEL,
    file,
  });

  const text = typeof response === 'string' ? response : response?.text;
  if (!text) {
    throw new Error('Transcripcion vacia.');
  }

  return text.slice(0, MAX_AUDIO_TRANSCRIPT_CHARS);
}

export function startTelegramBot(router) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const bot = new TelegramBot(token, { polling: true });
  const pendingMediaGroups = new Map();
  const inFlightByChat = new Set();
  const menuScopeByChat = new Map();

  function getMenuScope(chatId) {
    const key = String(chatId || '').trim();
    if (!key) return 'main';
    return normalizeMenuScope(menuScopeByChat.get(key) || 'main');
  }

  function setMenuScope(chatId, scope = 'main') {
    const key = String(chatId || '').trim();
    if (!key) return 'main';
    const normalized = normalizeMenuScope(scope);
    menuScopeByChat.set(key, normalized);
    return normalized;
  }

  function buildQuickActionsMarkup(scope = 'main') {
    if (scope === 'bets') {
      return {
        inline_keyboard: BETS_MENU_ROWS,
      };
    }
    if (scope === 'config') {
      return {
        inline_keyboard: CONFIG_MENU_ROWS,
      };
    }
    return {
      inline_keyboard: MAIN_MENU_ROWS,
    };
  }

  async function sendBotMessage(chatId, text, { menuScope = null } = {}) {
    const rawText = String(text || '');
    const htmlText = toTelegramHtml(rawText);
    const plainText = toTelegramPlainText(rawText);
    const resolvedScope =
      menuScope === null || menuScope === undefined
        ? getMenuScope(chatId)
        : setMenuScope(chatId, menuScope);
    const replyMarkup = buildQuickActionsMarkup(resolvedScope);

    try {
      return await bot.sendMessage(chatId, htmlText || plainText || ' ', {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: replyMarkup,
      });
    } catch (error) {
      console.error('⚠️ Telegram parse_mode HTML failed, fallback to plain text:', error);
      return bot.sendMessage(chatId, plainText || rawText || ' ', {
        disable_web_page_preview: true,
        reply_markup: replyMarkup,
      });
    }
  }

  async function routeSyntheticAction(query, syntheticMessage = '') {
    const sourceMsg = query?.message;
    if (!sourceMsg) {
      return null;
    }

    const chatId = sourceMsg.chat?.id;
    if (!chatId || !syntheticMessage) {
      return null;
    }

    return router.routeMessage({
      chatId: String(chatId),
      message: syntheticMessage,
      user: {
        id: query?.from?.id ? String(query.from.id) : null,
        username: query?.from?.username || null,
        firstName: query?.from?.first_name || null,
        lastName: query?.from?.last_name || null,
      },
      chat: {
        id: sourceMsg.chat?.id ? String(sourceMsg.chat.id) : null,
        type: sourceMsg.chat?.type || null,
        title: sourceMsg.chat?.title || null,
      },
      originalAction: query?.data || null,
    });
  }

  async function sendMenu(chatId, scope = 'main') {
    if (scope === 'bets') {
      return sendBotMessage(chatId, '📚 Menu Apuestas', { menuScope: 'bets' });
    }
    if (scope === 'config') {
      return sendBotMessage(chatId, '⚙️ Menu Config', { menuScope: 'config' });
    }
    return sendBotMessage(chatId, 'Menu principal', { menuScope: 'main' });
  }

  async function deliverToRouter({
    msg,
    userMessage,
    inputItems,
    mediaStats,
    isAlbum = false,
  } = {}) {
    const chatId = msg.chat.id;
    const from = msg.from || {};
    const chatInfo = msg.chat || {};

    const cleanMessage = String(userMessage || '').trim();
    const hasMedia = Array.isArray(inputItems) && inputItems.length > 0;

    if (inFlightByChat.has(chatId)) {
      await sendBotMessage(
        chatId,
        '⏳ Estoy respondiendo tu mensaje anterior. Esperá mi respuesta y seguimos.'
      );
      return;
    }

    if (!cleanMessage && !hasMedia) {
      await sendBotMessage(
        chatId,
        'Por ahora puedo procesar texto, imagen o audio. Si queres, mandame tu consulta por mensaje o adjunta un archivo.'
      );
      return;
    }

    console.log(
      `📩 Mensaje recibido${isAlbum ? ' (album)' : ''}: ${cleanMessage || '[sin texto]'}`
    );

    inFlightByChat.add(chatId);
    let typingTimer = null;
    try {
      await bot.sendChatAction(chatId, 'typing');
      typingTimer = setInterval(() => {
        bot.sendChatAction(chatId, 'typing').catch(() => {});
      }, TYPING_ACTION_INTERVAL_MS);

      const reply = await router.routeMessage({
        chatId: String(chatId),
        message: cleanMessage,
        telegramMessageId: msg.message_id,
        inputItems,
        mediaStats,
        user: {
          id: from.id ? String(from.id) : null,
          username: from.username || null,
          firstName: from.first_name || null,
          lastName: from.last_name || null,
        },
        chat: {
          id: chatInfo.id ? String(chatInfo.id) : null,
          type: chatInfo.type || null,
          title: chatInfo.title || null,
        },
      });

      await sendBotMessage(chatId, reply || 'No tengo respuesta para eso aún 😅');
    } finally {
      if (typingTimer) {
        clearInterval(typingTimer);
      }
      inFlightByChat.delete(chatId);
    }
  }

  async function processSingleMessage(msg) {
    const chatId = msg.chat.id;
    let userMessage = msg.text || msg.caption || '';

    const inputItems = [];
    const mediaStats = { imageCount: 0, audioSeconds: 0 };

    try {
      if (Array.isArray(msg.photo) && msg.photo.length) {
        const bestPhoto = pickLargestPhoto(msg.photo);
        if (bestPhoto?.file_id) {
          const { buffer, filePath } = await downloadTelegramFile(
            bot,
            token,
            bestPhoto.file_id
          );
          const ext = fileExtension(filePath) || 'jpg';
          const mimeType = guessImageMime(ext);
          inputItems.push(buildImageInput(buffer, mimeType));
          mediaStats.imageCount += 1;
        }
      }

      const audioFile = msg.voice || msg.audio;
      if (audioFile?.file_id) {
        const { buffer, filePath } = await downloadTelegramFile(
          bot,
          token,
          audioFile.file_id
        );
        const ext = fileExtension(filePath);
        const audioBuffer =
          ext === 'mp3' || ext === 'wav'
            ? buffer
            : await convertAudioToMp3(buffer, ext || 'ogg');

        const transcript = await transcribeAudio(
          audioBuffer,
          `audio.${ext === 'wav' ? 'wav' : 'mp3'}`
        );
        if (transcript) {
          const transcriptBlock = `[TRANSCRIPCION_AUDIO]\\n${transcript}`;
          userMessage = userMessage.trim()
            ? `${userMessage}\\n\\n${transcriptBlock}`
            : transcriptBlock;
        }
        if (audioFile.duration) {
          mediaStats.audioSeconds = Number(audioFile.duration) || 0;
        }
      }
    } catch (error) {
      console.error('❌ Error procesando media:', error);
      await sendBotMessage(
        chatId,
        'No pude procesar el archivo multimedia. Si es audio, asegurate de que pueda convertirlo a mp3/wav (requiere ffmpeg).'
      );
      return;
    }

    await deliverToRouter({ msg, userMessage, inputItems, mediaStats });
  }

  function enqueueMediaGroup(msg) {
    const groupId = msg.media_group_id;
    if (!groupId) return;

    const entry = pendingMediaGroups.get(groupId) || { messages: [], timer: null };
    entry.messages.push(msg);

    if (entry.timer) {
      clearTimeout(entry.timer);
    }

    entry.timer = setTimeout(() => {
      flushMediaGroup(groupId).catch((error) => {
        console.error('❌ Error procesando album:', error);
      });
    }, MEDIA_GROUP_FLUSH_MS);

    pendingMediaGroups.set(groupId, entry);
  }

  async function flushMediaGroup(groupId) {
    const entry = pendingMediaGroups.get(groupId);
    if (!entry) return;
    pendingMediaGroups.delete(groupId);

    const messages = entry.messages || [];
    if (!messages.length) return;

    const first = messages[0];
    const chatId = first.chat.id;
    const inputItems = [];
    const textParts = [];
    const mediaStats = { imageCount: 0, audioSeconds: 0 };

    for (const msg of messages) {
      const text = String(msg.caption || msg.text || '').trim();
      if (text) {
        textParts.push(text);
      }
    }

    const uniqueText = textParts.filter((value, index, arr) => arr.indexOf(value) === index);
    const userMessage = uniqueText.join('\n\n');

    try {
      for (const msg of messages) {
        if (!Array.isArray(msg.photo) || !msg.photo.length) {
          continue;
        }
        const bestPhoto = pickLargestPhoto(msg.photo);
        if (!bestPhoto?.file_id) continue;
        const { buffer, filePath } = await downloadTelegramFile(
          bot,
          token,
          bestPhoto.file_id
        );
        const ext = fileExtension(filePath) || 'jpg';
        const mimeType = guessImageMime(ext);
        inputItems.push(buildImageInput(buffer, mimeType));
        mediaStats.imageCount += 1;
      }
    } catch (error) {
      console.error('❌ Error procesando album:', error);
      await sendBotMessage(
        chatId,
        'No pude procesar todas las fotos del album. Probá reenviarlas o mandar menos imágenes.'
      );
      return;
    }

    await deliverToRouter({
      msg: first,
      userMessage,
      inputItems,
      mediaStats,
      isAlbum: true,
    });
  }

  bot.on('message', async (msg) => {
    if (msg.media_group_id && Array.isArray(msg.photo) && msg.photo.length) {
      enqueueMediaGroup(msg);
      return;
    }

    await processSingleMessage(msg);
  });

  bot.on('callback_query', async (query) => {
    const data = String(query?.data || '');
    const chatId = query?.message?.chat?.id;
    if (!chatId) {
      return;
    }

    try {
      await bot.answerCallbackQuery(query.id);
    } catch (error) {
      console.error('⚠️ Error respondiendo callback_query:', error);
    }

    if (data === 'menu:main') {
      await sendMenu(chatId, 'main');
      return;
    }
    if (data === 'menu:bets') {
      await sendMenu(chatId, 'bets');
      return;
    }
    if (data === 'menu:config') {
      await sendMenu(chatId, 'config');
      return;
    }

    if (data === 'qa:analyze_quotes') {
      await sendBotMessage(chatId, QUICK_ACTION_HINTS.analyze_quotes, { menuScope: 'bets' });
      return;
    }

    if (data === 'qa:analyze_fight') {
      await sendBotMessage(chatId, QUICK_ACTION_HINTS.analyze_fight, { menuScope: 'bets' });
      return;
    }

    if (data === 'qa:help') {
      await sendBotMessage(chatId, QUICK_ACTION_HINTS.help, { menuScope: getMenuScope(chatId) });
      return;
    }

    if (data === 'qa:record_bet') {
      await sendBotMessage(chatId, QUICK_ACTION_HINTS.record_bet, { menuScope: 'bets' });
      return;
    }

    if (data === 'qa:settle_bet') {
      await sendBotMessage(chatId, QUICK_ACTION_HINTS.settle_bet, { menuScope: 'bets' });
      return;
    }

    if (data === 'act:bet_open') {
      await sendBotMessage(chatId, QUICK_ACTION_HINTS.bet_open, { menuScope: 'bets' });
      return;
    }

    if (data === 'act:bet_record') {
      await sendBotMessage(chatId, QUICK_ACTION_HINTS.record_bet, { menuScope: 'bets' });
      return;
    }

    if (data === 'act:cfg_stake') {
      await sendBotMessage(chatId, QUICK_ACTION_HINTS.config_stake, { menuScope: 'config' });
      return;
    }

    if (data === 'act:cfg_profile') {
      await sendBotMessage(chatId, QUICK_ACTION_HINTS.config_profile, { menuScope: 'config' });
      return;
    }

    if (data === 'act:cfg_unit') {
      await sendBotMessage(chatId, QUICK_ACTION_HINTS.config_unit, { menuScope: 'config' });
      return;
    }

    if (data === 'act:cfg_risk') {
      await sendBotMessage(chatId, QUICK_ACTION_HINTS.config_risk, { menuScope: 'config' });
      return;
    }

    if (data === 'act:cfg_bankroll') {
      await sendBotMessage(chatId, QUICK_ACTION_HINTS.config_bankroll, { menuScope: 'config' });
      return;
    }

    if (data === 'act:cfg_timezone') {
      await sendBotMessage(chatId, QUICK_ACTION_HINTS.config_timezone, { menuScope: 'config' });
      return;
    }

    if (data === 'act:cfg_utilization') {
      await sendBotMessage(chatId, QUICK_ACTION_HINTS.config_utilization, { menuScope: 'config' });
      return;
    }

    const syntheticByAction = {
      'qa:list_pending': 'mostrame mis apuestas pending del ledger con bet_id',
      'qa:undo_last': 'deshace la ultima mutacion del ledger',
      'qa:view_config':
        'mostrame mi configuracion actual (bankroll, unidad, riesgo, timezone y stake minimo)',
      'qa:view_credits': 'decime cuantos creditos tengo y mis ultimos movimientos',
    };

    const syntheticMessage = syntheticByAction[data];
    if (!syntheticMessage) {
      return;
    }

    const routed = await routeSyntheticAction(query, syntheticMessage);
    const menuScopeByAction = {
      'qa:list_pending': 'bets',
      'qa:undo_last': 'bets',
      'qa:view_config': 'config',
      'qa:view_credits': 'config',
    };
    const menuScope = menuScopeByAction[data] || getMenuScope(chatId);
    await sendBotMessage(chatId, routed || 'No pude completar esa accion ahora mismo.', {
      menuScope,
    });
  });

  console.log('🤖 Telegram bot iniciado y esperando mensajes...');

  return {
    bot,
    async sendSystemMessage({ chatId, text } = {}) {
      if (!chatId || !text) return null;
      return sendBotMessage(chatId, text);
    },
  };
}
