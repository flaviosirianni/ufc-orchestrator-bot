import TelegramBot from 'node-telegram-bot-api';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import OpenAI, { toFile } from 'openai';
import ffmpegPath from 'ffmpeg-static';

const execFileAsync = promisify(execFile);

const MAX_MEDIA_BYTES = Number(process.env.MAX_MEDIA_BYTES ?? String(25 * 1024 * 1024));
const AUDIO_TRANSCRIBE_MODEL = process.env.AUDIO_TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe';
const MAX_AUDIO_TRANSCRIPT_CHARS = Number(
  process.env.MAX_AUDIO_TRANSCRIPT_CHARS ?? '4000'
);
const MEDIA_GROUP_FLUSH_MS = Number(process.env.MEDIA_GROUP_FLUSH_MS ?? '900');
const FFMPEG_BINARY = ffmpegPath || 'ffmpeg';

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

    if (!cleanMessage && !hasMedia) {
      await bot.sendMessage(
        chatId,
        'Por ahora puedo procesar texto, imagen o audio. Si queres, mandame tu consulta por mensaje o adjunta un archivo.'
      );
      return;
    }

    console.log(
      `📩 Mensaje recibido${isAlbum ? ' (album)' : ''}: ${cleanMessage || '[sin texto]'}`
    );

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

    bot.sendMessage(chatId, reply || 'No tengo respuesta para eso aún 😅');
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
      await bot.sendMessage(
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
      await bot.sendMessage(
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

  console.log('🤖 Telegram bot iniciado y esperando mensajes...');
}
