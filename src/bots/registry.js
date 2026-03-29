import path from 'node:path';

function normalizeBotId(value = '') {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
}

export function normalizeRegistryBotId(value = '') {
  return normalizeBotId(value);
}

export function resolveBotManifestPath(botId = '') {
  const normalized = normalizeBotId(botId);
  if (!normalized) {
    throw new Error('BOT_ID invalido.');
  }
  return path.join('src', 'bots', normalized, 'bot.manifest.json');
}

export async function loadBotModule(botId = '') {
  const normalized = normalizeBotId(botId);
  if (!normalized) {
    throw new Error('BOT_ID invalido.');
  }

  try {
    const mod = await import(`./${normalized}/index.js`);
    return {
      botId: normalized,
      module: mod,
    };
  } catch (error) {
    throw new Error(`No existe bot registrado para BOT_ID="${normalized}".`);
  }
}
