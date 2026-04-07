import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

function parseArgs(argv = []) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || '').trim();
    if (!token.startsWith('--')) continue;

    if (token.startsWith('--no-')) {
      options[token.slice(5)] = false;
      continue;
    }

    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !String(next).startsWith('--')) {
      options[key] = next;
      i += 1;
      continue;
    }
    options[key] = true;
  }
  return options;
}

function asString(value, fallback = '') {
  const normalized = String(value ?? '').trim();
  return normalized || fallback;
}

function asBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (value == null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(normalized);
}

function resolvePathFromCwd(rawPath = '') {
  const value = asString(rawPath);
  if (!value) return '';
  if (path.isAbsolute(value)) return value;
  return path.resolve(process.cwd(), value);
}

function readJsonFile(jsonPath = '') {
  const raw = fs.readFileSync(jsonPath, 'utf8');
  return JSON.parse(raw);
}

function parseEnvLine(line = '') {
  const trimmed = String(line || '').trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const separator = trimmed.indexOf('=');
  if (separator === -1) return null;
  const key = trimmed.slice(0, separator).trim();
  if (!key) return null;
  const value = trimmed.slice(separator + 1).trim();
  return [key, value];
}

function parseEnvText(contents = '') {
  const result = {};
  String(contents || '')
    .split('\n')
    .map(parseEnvLine)
    .filter(Boolean)
    .forEach(([key, value]) => {
      result[key] = value;
    });
  return result;
}

function resolveDefaultEnvFile(botId = 'nutrition') {
  const candidates = [
    `.env.${botId}`,
    `.env.${botId}.local`,
    '.env',
  ];
  for (const candidate of candidates) {
    const resolved = resolvePathFromCwd(candidate);
    if (fs.existsSync(resolved)) {
      return resolved;
    }
  }
  return resolvePathFromCwd(candidates[0]);
}

function readEnvMap(envFilePath = '') {
  if (!fs.existsSync(envFilePath)) {
    return { values: {}, missing: true };
  }
  const raw = fs.readFileSync(envFilePath, 'utf8');
  return { values: parseEnvText(raw), missing: false };
}

function expandEnvValue(rawValue = '') {
  const value = String(rawValue || '').trim();
  if (!value) return '';
  const expandedHome = value
    .replace(/^\$HOME\b/, process.env.HOME || '')
    .replace(/^\$\{HOME\}/, process.env.HOME || '');
  return expandedHome;
}

function toHashPreview(value = '') {
  const normalized = String(value || '').trim();
  if (!normalized) return '';
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

function shellEscapeSingle(value = '') {
  return String(value || '').replace(/'/g, `'\"'\"'`);
}

function readLiveEnvValue({
  server = '',
  liveEnvFile = '',
  key = '',
} = {}) {
  const escapedKey = shellEscapeSingle(key);
  const escapedEnvFile = shellEscapeSingle(liveEnvFile);
  const remoteCommand =
    `sudo awk -F= -v k='${escapedKey}' ` +
    `'$1 == k { print substr($0, index($0, "=") + 1); exit }' ` +
    `'${escapedEnvFile}'`;
  const output = execFileSync('ssh', [server, remoteCommand], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return asString(output);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const botId = asString(args.bot, 'nutrition');
  const envFilePath = resolvePathFromCwd(asString(args['env-file']) || resolveDefaultEnvFile(botId));
  const parityDir = resolvePathFromCwd(asString(args['parity-dir'], 'ops/parity'));
  const server = asString(args.server, 'ufc-oci');
  const liveEnvFile = asString(args['live-env-file'], `/etc/bot-factory/${botId}.env`);
  const enforceLiveTokenDiff = asBoolean(args['enforce-live-token-diff'], false);

  const requiredKeysPath = path.join(parityDir, `${botId}.required-keys.json`);
  const invariantsPath = path.join(parityDir, `${botId}.invariants.json`);
  const localSafetyPath = path.join(parityDir, `${botId}.local-safety.json`);

  const missingKeys = [];
  const invariantMismatches = [];
  const safetyViolations = [];
  const internalErrors = [];

  let requiredKeysConfig = {};
  let invariantsConfig = {};
  let localSafetyConfig = {};
  let localEnvValues = {};

  try {
    requiredKeysConfig = readJsonFile(requiredKeysPath);
  } catch (error) {
    internalErrors.push({
      type: 'missing_required_keys_config',
      path: requiredKeysPath,
      message: String(error?.message || error),
    });
  }
  try {
    invariantsConfig = readJsonFile(invariantsPath);
  } catch (error) {
    internalErrors.push({
      type: 'missing_invariants_config',
      path: invariantsPath,
      message: String(error?.message || error),
    });
  }
  try {
    localSafetyConfig = readJsonFile(localSafetyPath);
  } catch (error) {
    internalErrors.push({
      type: 'missing_local_safety_config',
      path: localSafetyPath,
      message: String(error?.message || error),
    });
  }

  const envRead = readEnvMap(envFilePath);
  localEnvValues = envRead.values;
  if (envRead.missing) {
    safetyViolations.push({
      type: 'env_file_missing',
      env_file: envFilePath,
      message: 'No se encontro el env file local para evaluar paridad.',
    });
  }

  const requiredKeys = Array.isArray(requiredKeysConfig?.required_keys)
    ? requiredKeysConfig.required_keys
    : [];
  requiredKeys.forEach((key) => {
    const value = asString(localEnvValues[key]);
    if (!value) {
      missingKeys.push(key);
    }
  });

  const invariants = invariantsConfig?.invariants && typeof invariantsConfig.invariants === 'object'
    ? invariantsConfig.invariants
    : {};
  Object.entries(invariants).forEach(([key, expectedRaw]) => {
    const expected = asString(expectedRaw);
    const actual = asString(localEnvValues[key]);
    if (expected && actual !== expected) {
      invariantMismatches.push({
        key,
        expected,
        actual,
      });
    }
  });

  const dbPathRule = localSafetyConfig?.db_path || {};
  const dbPathKey = asString(dbPathRule?.env_key, 'DB_PATH');
  const rawDbPath = asString(localEnvValues[dbPathKey]);
  const dbPath = expandEnvValue(rawDbPath);
  if (asBoolean(dbPathRule?.required, false) && !dbPath) {
    safetyViolations.push({
      type: 'db_path_missing',
      key: dbPathKey,
      message: 'DB_PATH obligatorio no informado.',
    });
  }
  const forbiddenPrefixes = Array.isArray(dbPathRule?.forbidden_prefixes)
    ? dbPathRule.forbidden_prefixes.map((value) => asString(value)).filter(Boolean)
    : [];
  forbiddenPrefixes.forEach((prefix) => {
    if (dbPath && dbPath.startsWith(prefix)) {
      safetyViolations.push({
        type: 'db_path_forbidden_prefix',
        key: dbPathKey,
        prefix,
        db_path: dbPath,
        message: `DB_PATH local no puede usar prefijo de prod (${prefix}).`,
      });
    }
  });

  const tokenDiffRule = localSafetyConfig?.token_diff || {};
  if (enforceLiveTokenDiff && tokenDiffRule && typeof tokenDiffRule === 'object') {
    const localTokenKey = asString(tokenDiffRule.local_env_key);
    const liveTokenKey = asString(tokenDiffRule.live_env_key, localTokenKey);
    const localToken = asString(localEnvValues[localTokenKey]);
    if (!localToken) {
      safetyViolations.push({
        type: 'local_token_missing',
        key: localTokenKey,
        message: `Token local requerido (${localTokenKey}) no informado.`,
      });
    } else {
      try {
        const liveToken = readLiveEnvValue({
          server,
          liveEnvFile,
          key: liveTokenKey,
        });
        const localHash = toHashPreview(localToken);
        const liveHash = toHashPreview(liveToken);
        if (!liveToken) {
          safetyViolations.push({
            type: 'live_token_missing',
            key: liveTokenKey,
            message: `No se pudo leer token live (${liveTokenKey}) para comparacion.`,
          });
        } else if (localHash === liveHash) {
          safetyViolations.push({
            type: 'token_matches_live',
            key: localTokenKey,
            message: 'Token local coincide con token live (comparacion por hash).',
            local_hash: localHash,
            live_hash: liveHash,
          });
        }
      } catch (error) {
        safetyViolations.push({
          type: 'live_token_check_failed',
          key: liveTokenKey,
          message: 'Fallo la comparacion de token local vs live.',
          detail: String(error?.message || error),
        });
      }
    }
  }

  const result = {
    bot: botId,
    env_file: envFilePath,
    server,
    live_env_file: liveEnvFile,
    enforce_live_token_diff: enforceLiveTokenDiff,
    checked_at: new Date().toISOString(),
    missing_keys: missingKeys,
    invariant_mismatches: invariantMismatches,
    safety_violations: safetyViolations,
    internal_errors: internalErrors,
    ok:
      missingKeys.length === 0 &&
      invariantMismatches.length === 0 &&
      safetyViolations.length === 0 &&
      internalErrors.length === 0,
  };

  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    process.exitCode = 1;
  }
}

main();
