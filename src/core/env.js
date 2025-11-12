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
  return path.join(projectRoot, '.env');
}

export function loadEnv() {
  if (isLoaded) {
    return;
  }

  isLoaded = true;
  const envPath = resolveEnvPath();

  if (!fs.existsSync(envPath)) {
    return;
  }

  const contents = fs.readFileSync(envPath, 'utf-8');
  contents
    .split('\n')
    .map(parseLine)
    .filter(Boolean)
    .forEach(([key, value]) => {
      if (!(key in process.env)) {
        process.env[key] = value;
      }
    });
}

loadEnv();

export default loadEnv;
