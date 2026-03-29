import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let isLoaded = false;

function parseLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) {
    return null;
  }

  const equalsIndex = trimmed.indexOf('=');
  if (equalsIndex === -1) {
    return null;
  }

  const key = trimmed.slice(0, equalsIndex).trim();
  const value = trimmed.slice(equalsIndex + 1).trim();
  return [key, value];
}

function resolveEnvPath() {
  const currentModulePath = fileURLToPath(import.meta.url);
  const projectRoot = path.resolve(path.dirname(currentModulePath), '..', '..');
  return {
    currentModulePath,
    projectRoot,
  };
}

function resolveCustomEnvPath(rawPath = '', projectRoot = process.cwd()) {
  const value = String(rawPath || '').trim();
  if (!value) return null;
  if (path.isAbsolute(value)) {
    return value;
  }
  return path.join(projectRoot, value);
}

function resolveEnvCandidates(projectRoot) {
  const botId = String(process.env.BOT_ID || '').trim();
  const candidates = [
    path.join(projectRoot, '.env'),
    path.join(projectRoot, '.env.local'),
  ];

  if (botId) {
    candidates.push(path.join(projectRoot, `.env.${botId}`));
    candidates.push(path.join(projectRoot, `.env.${botId}.local`));
  }

  const explicitEnv = resolveCustomEnvPath(process.env.ENV_FILE, projectRoot);
  if (explicitEnv) {
    candidates.push(explicitEnv);
  }

  const explicitBotEnv = resolveCustomEnvPath(process.env.BOT_ENV_FILE, projectRoot);
  if (explicitBotEnv) {
    candidates.push(explicitBotEnv);
  }

  return [...new Set(candidates)];
}

export function loadEnv() {
  if (isLoaded) {
    return;
  }

  isLoaded = true;
  const { projectRoot } = resolveEnvPath();
  const envCandidates = resolveEnvCandidates(projectRoot);
  const externalEnvKeys = new Set(Object.keys(process.env));

  for (const envPath of envCandidates) {
    if (!fs.existsSync(envPath)) {
      continue;
    }
    const contents = fs.readFileSync(envPath, 'utf-8');
    contents
      .split('\n')
      .map(parseLine)
      .filter(Boolean)
      .forEach(([key, value]) => {
        if (externalEnvKeys.has(key)) {
          return;
        }
        process.env[key] = value;
      });
  }
}

loadEnv();

export default loadEnv;
