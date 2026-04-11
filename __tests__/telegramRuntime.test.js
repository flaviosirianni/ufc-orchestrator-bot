import assert from 'node:assert/strict';
import {
  createDisabledTelegramRuntime,
  resolveManifestTelegramToken,
} from '../src/platform/runtime/telegramRuntime.js';

export async function runTelegramRuntimeTests() {
  {
    const resolved = resolveManifestTelegramToken(
      { telegram_token_env: 'NUTRITION_TELEGRAM_BOT_TOKEN' },
      { TELEGRAM_BOT_TOKEN: 'shared-ufc-token' }
    );
    assert.equal(resolved.tokenEnvName, 'NUTRITION_TELEGRAM_BOT_TOKEN');
    assert.equal(resolved.token, '');
  }

  {
    const resolved = resolveManifestTelegramToken(
      { telegram_token_env: 'NUTRITION_TELEGRAM_BOT_TOKEN' },
      { NUTRITION_TELEGRAM_BOT_TOKEN: 'nutrition-token' }
    );
    assert.equal(resolved.tokenEnvName, 'NUTRITION_TELEGRAM_BOT_TOKEN');
    assert.equal(resolved.token, 'nutrition-token');
  }

  {
    const resolved = resolveManifestTelegramToken({}, { TELEGRAM_BOT_TOKEN: 'ufc-token' });
    assert.equal(resolved.tokenEnvName, 'TELEGRAM_BOT_TOKEN');
    assert.equal(resolved.token, 'ufc-token');
  }

  {
    const runtime = createDisabledTelegramRuntime({
      botId: 'nutrition',
      tokenEnvName: 'NUTRITION_TELEGRAM_BOT_TOKEN',
    });
    const status = runtime.getRuntimeStatus();
    assert.equal(status.disabled, true);
    assert.equal(status.reason, 'missing_telegram_token');
    assert.equal(status.botId, 'nutrition');
    assert.equal(status.tokenEnvName, 'NUTRITION_TELEGRAM_BOT_TOKEN');
    const sendResult = await runtime.sendSystemMessage({ chatId: '1', text: 'hola' });
    assert.equal(sendResult, null);
  }

  console.log('All telegram runtime tests passed.');
}

