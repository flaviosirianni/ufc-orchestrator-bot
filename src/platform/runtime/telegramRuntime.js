export function resolveManifestTelegramToken(manifest = {}, env = process.env) {
  const tokenEnvName =
    String(manifest?.telegram_token_env || 'TELEGRAM_BOT_TOKEN').trim() || 'TELEGRAM_BOT_TOKEN';
  const token = String(env?.[tokenEnvName] || '').trim();
  return {
    tokenEnvName,
    token,
  };
}

export function createDisabledTelegramRuntime({ botId = '', tokenEnvName = '' } = {}) {
  const normalizedBotId = String(botId || '').trim();
  const normalizedTokenEnvName = String(tokenEnvName || '').trim() || 'TELEGRAM_BOT_TOKEN';
  const startedAt = Date.now();

  return {
    bot: null,
    interactionMode: 'disabled',
    getRuntimeStatus() {
      return {
        startedAt,
        disabled: true,
        reason: 'missing_telegram_token',
        botId: normalizedBotId,
        tokenEnvName: normalizedTokenEnvName,
      };
    },
    async sendSystemMessage() {
      return null;
    },
    close() {},
  };
}
