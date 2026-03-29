import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const TEMPLATE_ROOT = path.join(ROOT, 'src', 'bots', 'templates');
const ALLOWED_TEMPLATES = new Set(['expert_advisor', 'document_reader']);

function getArg(flag, fallback = '') {
  const args = process.argv.slice(2);
  const key = `--${flag}`;
  const index = args.findIndex((item) => item === key || item.startsWith(`${key}=`));
  if (index === -1) return fallback;
  const item = args[index];
  if (item.includes('=')) {
    return item.split('=').slice(1).join('=').trim() || fallback;
  }
  const next = args[index + 1];
  if (!next || next.startsWith('--')) return fallback;
  return String(next).trim() || fallback;
}

function assertValidBotId(botId) {
  const normalized = String(botId || '').trim().toLowerCase();
  if (!/^[a-z0-9_-]+$/.test(normalized)) {
    throw new Error('`--id` invalido. Usa solo [a-z0-9_-].');
  }
  return normalized;
}

function toDisplayName(botId = '') {
  return String(botId || '')
    .split(/[_-]+/g)
    .filter(Boolean)
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
    .join(' ');
}

async function readTemplateFile(templateName, filename) {
  const filePath = path.join(TEMPLATE_ROOT, templateName, filename);
  return fs.readFile(filePath, 'utf8');
}

function replaceTokens(text, tokens = {}) {
  let result = String(text || '');
  for (const [key, value] of Object.entries(tokens)) {
    result = result.replaceAll(key, String(value));
  }
  return result;
}

async function ensureMissing(targetPath) {
  const stat = await fs
    .stat(targetPath)
    .then((value) => value)
    .catch(() => null);
  if (stat) {
    throw new Error(`La ruta ya existe: ${targetPath}`);
  }
}

async function writeIfMissing(filePath, contents) {
  await ensureMissing(filePath);
  await fs.writeFile(filePath, contents, 'utf8');
}

async function main() {
  const rawTemplate = getArg('template');
  const template = String(rawTemplate || '').trim().toLowerCase();
  if (!ALLOWED_TEMPLATES.has(template)) {
    throw new Error('Template invalido. Usa --template expert_advisor|document_reader');
  }

  const botId = assertValidBotId(getArg('id'));
  const displayName = getArg('name', toDisplayName(botId));
  const tokenEnv = getArg(
    'token-env',
    `${botId.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_TELEGRAM_BOT_TOKEN`
  );

  const botDir = path.join(ROOT, 'src', 'bots', botId);
  await ensureMissing(botDir);

  const manifestTemplate = await readTemplateFile(template, 'bot.manifest.template.json');
  const promptTemplate = await readTemplateFile(template, 'prompt.template.md');
  const indexTemplate = await readTemplateFile(template, 'index.template.js');

  const manifestText = replaceTokens(manifestTemplate, {
    '__BOT_ID__': botId,
    '__DISPLAY_NAME__': displayName,
    '__TELEGRAM_TOKEN_ENV__': tokenEnv,
  });

  const manifest = JSON.parse(manifestText);
  const policyPack = String(manifest?.risk_policy || 'general_safe_advice');

  await fs.mkdir(botDir, { recursive: true });
  await writeIfMissing(path.join(botDir, 'bot.manifest.json'), `${manifestText.trim()}\n`);
  await writeIfMissing(path.join(botDir, 'prompt.md'), `${promptTemplate.trim()}\n`);
  await writeIfMissing(path.join(botDir, 'index.js'), `${indexTemplate.trim()}\n`);

  const envExamplePath = path.join(ROOT, `.env.${botId}.example`);
  const envExample = [
    `# ${displayName}`,
    `BOT_ID=${botId}`,
    `INTERACTION_MODE=guided_strict`,
    `TELEGRAM_INTERACTION_MODE=guided_strict`,
    `BOT_POLICY_PACK=${policyPack}`,
    `DB_PATH=/home/ubuntu/bot-data/${botId}/bot.db`,
    `${tokenEnv}=`,
    'OPENAI_API_KEY=',
    'BILLING_BASE_URL=http://127.0.0.1:3200',
    'BILLING_API_TOKEN=',
    'APP_PUBLIC_URL=https://tu-dominio.com',
    'PORT=3000',
    '',
  ].join('\n');
  await writeIfMissing(envExamplePath, envExample);

  console.log(`Bot scaffold creado: src/bots/${botId}`);
  console.log(`Manifest: src/bots/${botId}/bot.manifest.json`);
  console.log(`Env example: .env.${botId}.example`);
  console.log('Siguientes pasos sugeridos:');
  console.log(`1) Completar .env.${botId}.example y crear .env.${botId}`);
  console.log(`2) Exportar BOT_ID=${botId} y lanzar: npm run start:bot`);
  console.log(`3) Registrar servicio systemd bot-factory@${botId}.service en OCI`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
