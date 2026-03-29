import '../core/env.js';
import { loadBotManifestFromFile } from './manifest.js';
import { loadBotModule, resolveBotManifestPath } from '../bots/registry.js';

function applyManifestEnvDefaults(manifest = {}) {
  const botId = String(manifest?.bot_id || '').trim();
  const interactionMode = String(manifest?.interaction_mode || '').trim();
  const policyPack = String(manifest?.risk_policy || '').trim();
  const dbPath = String(manifest?.storage?.db_path || '').trim();
  const telegramTokenEnv = String(manifest?.telegram_token_env || '').trim();

  if (botId && !process.env.BOT_ID) {
    process.env.BOT_ID = botId;
  }
  if (interactionMode && !process.env.INTERACTION_MODE) {
    process.env.INTERACTION_MODE = interactionMode;
  }
  if (interactionMode && !process.env.TELEGRAM_INTERACTION_MODE) {
    process.env.TELEGRAM_INTERACTION_MODE = interactionMode;
  }
  if (policyPack && !process.env.BOT_POLICY_PACK) {
    process.env.BOT_POLICY_PACK = policyPack;
  }
  if (dbPath && !process.env.DB_PATH) {
    process.env.DB_PATH = dbPath;
  }

  if (
    telegramTokenEnv &&
    process.env[telegramTokenEnv] &&
    !process.env.TELEGRAM_BOT_TOKEN
  ) {
    process.env.TELEGRAM_BOT_TOKEN = process.env[telegramTokenEnv];
  }
}

export async function launchBotRuntime({ botId = process.env.BOT_ID || 'ufc' } = {}) {
  const manifestPath = resolveBotManifestPath(botId);
  const manifest = loadBotManifestFromFile(manifestPath);
  applyManifestEnvDefaults(manifest);

  const { module, botId: normalizedBotId } = await loadBotModule(botId);

  if (module?.bootstrapBot && typeof module.bootstrapBot === 'function') {
    return module.bootstrapBot({
      botId: normalizedBotId,
      manifest,
    });
  }

  throw new Error(`Bot ${normalizedBotId} no exporta bootstrapBot.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  launchBotRuntime().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
