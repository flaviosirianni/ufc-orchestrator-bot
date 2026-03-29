import fs from 'node:fs';
import path from 'node:path';

const INTERACTION_MODES = new Set(['guided_strict', 'hybrid']);

function cloneObject(value = {}) {
  return JSON.parse(JSON.stringify(value));
}

function asString(value, fallback = '') {
  const str = String(value ?? '').trim();
  return str || fallback;
}

function normalizeInteractionMode(value = '') {
  const normalized = asString(value, 'guided_strict').toLowerCase();
  return INTERACTION_MODES.has(normalized) ? normalized : 'guided_strict';
}

function assertRequiredObject(value, keyPath) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Manifest invalido: ${keyPath} debe ser un objeto.`);
  }
}

export function validateBotManifest(raw = {}, { source = 'inline' } = {}) {
  assertRequiredObject(raw, 'root');

  const botId = asString(raw.bot_id);
  if (!botId) {
    throw new Error(`Manifest invalido (${source}): falta bot_id.`);
  }

  const displayName = asString(raw.display_name, botId);
  const telegramTokenEnv = asString(raw.telegram_token_env, 'TELEGRAM_BOT_TOKEN');
  const interactionMode = normalizeInteractionMode(raw.interaction_mode);

  const domainPack = cloneObject(raw.domain_pack || {});
  assertRequiredObject(domainPack, 'domain_pack');
  domainPack.prompt_file = asString(domainPack.prompt_file || domainPack.knowledge_file || '');

  const creditPolicy = cloneObject(raw.credit_policy || {});
  assertRequiredObject(creditPolicy, 'credit_policy');
  if (!creditPolicy.costs || typeof creditPolicy.costs !== 'object') {
    creditPolicy.costs = {};
  }

  const riskPolicy = asString(raw.risk_policy || raw.risk_policy_pack, 'general_safe_advice');

  const storage = cloneObject(raw.storage || {});
  assertRequiredObject(storage, 'storage');
  storage.db_path = asString(
    storage.db_path || process.env.DB_PATH || `/home/ubuntu/bot-data/${botId}/bot.db`
  );

  return {
    bot_id: botId,
    display_name: displayName,
    telegram_token_env: telegramTokenEnv,
    interaction_mode: interactionMode,
    domain_pack: domainPack,
    credit_policy: creditPolicy,
    risk_policy: riskPolicy,
    storage,
  };
}

export function loadBotManifestFromFile(manifestPath) {
  const resolved = path.resolve(process.cwd(), String(manifestPath || ''));
  const rawText = fs.readFileSync(resolved, 'utf8');
  const parsed = JSON.parse(rawText);
  return validateBotManifest(parsed, { source: resolved });
}
