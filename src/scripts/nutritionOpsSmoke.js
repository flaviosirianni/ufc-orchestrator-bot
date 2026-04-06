const HEALTH_URL = process.env.NUTRITION_HEALTH_URL || 'http://127.0.0.1:3000/health';
const BOT_TOKEN =
  process.env.NUTRITION_TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.NUTRITION_SMOKE_CHAT_ID || '';

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  return { ok: response.ok, status: response.status, body };
}

async function sendTelegramMessage(token = '', chatId = '', text = '') {
  if (!token || !chatId || !text) return { ok: false, skipped: true };
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  return requestJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    }),
  });
}

async function main() {
  const health = await requestJson(HEALTH_URL);
  if (!health.ok || !health.body?.ok) {
    console.error('[smoke] health check failed', JSON.stringify(health, null, 2));
    process.exitCode = 1;
    return;
  }

  const runtime = health.body?.runtime?.telegram || {};
  console.log(
    JSON.stringify(
      {
        health_url: HEALTH_URL,
        health_ok: true,
        telegram_idle_ms: runtime?.idleMs ?? null,
        telegram_recoveries: runtime?.recoveryCount ?? null,
        telegram_last_error: runtime?.lastErrorMessage ?? null,
      },
      null,
      2
    )
  );

  if (!BOT_TOKEN || !CHAT_ID) {
    console.log('[smoke] skip telegram message send (missing token/chat_id env vars).');
    return;
  }

  const startResult = await sendTelegramMessage(BOT_TOKEN, CHAT_ID, '/start');
  const intakeResult = await sendTelegramMessage(BOT_TOKEN, CHAT_ID, 'ingestas de hoy');
  console.log(
    JSON.stringify(
      {
        sent_start: startResult.ok,
        sent_intake_probe: intakeResult.ok,
        start_status: startResult.status ?? null,
        intake_probe_status: intakeResult.status ?? null,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error('[smoke] unexpected failure', error);
  process.exitCode = 1;
});
