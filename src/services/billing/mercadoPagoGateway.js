const MP_API_BASE_URL = 'https://api.mercadopago.com';

function toPositiveNumber(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function normalizeBaseUrl(url = '') {
  const value = String(url || '').trim();
  if (!value) return '';
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function parseTopupPacks(raw = '') {
  const map = new Map();
  const entries = String(raw || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (const entry of entries) {
    const [creditsRaw, amountRaw] = entry.split(':').map((part) => String(part || '').trim());
    const credits = toPositiveNumber(creditsRaw);
    const amount = toPositiveNumber(amountRaw);
    if (!credits || !amount) continue;
    map.set(credits, amount);
  }
  return [...map.entries()].map(([credits, amount]) => ({ pack_id: credits, credits, amount }));
}

function appendWebhookToken(rawUrl = '', token = '') {
  if (!rawUrl || !token) return rawUrl;
  try {
    const parsed = new URL(rawUrl);
    if (!parsed.searchParams.get('token')) {
      parsed.searchParams.set('token', token);
    }
    return parsed.toString();
  } catch {
    const separator = rawUrl.includes('?') ? '&' : '?';
    return `${rawUrl}${separator}token=${encodeURIComponent(token)}`;
  }
}

function parseExternalReference(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return null;

  if (raw.startsWith('bot_topup|')) {
    const [_, userId, botId, credits] = raw.split('|');
    return {
      userId: String(userId || '').trim(),
      botId: String(botId || '').trim() || null,
      credits: toPositiveNumber(credits),
    };
  }

  if (raw.startsWith('ufc_topup|')) {
    const [_, userId, credits] = raw.split('|');
    return {
      userId: String(userId || '').trim(),
      botId: 'ufc',
      credits: toPositiveNumber(credits),
    };
  }

  return null;
}

async function mpFetchJson({ accessToken = '', path = '', method = 'GET', body = null } = {}) {
  if (!accessToken) {
    return { ok: false, status: 500, error_code: 'missing_mp_access_token' };
  }

  const response = await fetch(`${MP_API_BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : null,
  });

  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error_code: payload?.message || 'mercadopago_api_error',
      payload,
    };
  }

  return {
    ok: true,
    status: response.status,
    payload,
  };
}

export function createMercadoPagoGateway({
  accessToken = process.env.MP_ACCESS_TOKEN || '',
  packsRaw = process.env.MP_TOPUP_PACKS || '',
  title = process.env.MP_TOPUP_TITLE || 'Recarga de creditos',
  currencyId = process.env.MP_CURRENCY_ID || 'ARS',
  webhookToken = process.env.MP_WEBHOOK_TOKEN || '',
  publicBaseUrl = process.env.BILLING_PUBLIC_URL || process.env.APP_PUBLIC_URL || '',
  notificationUrl = process.env.MP_NOTIFICATION_URL || '',
  successUrl = process.env.MP_SUCCESS_URL || '',
  pendingUrl = process.env.MP_PENDING_URL || '',
  failureUrl = process.env.MP_FAILURE_URL || '',
} = {}) {
  const packs = parseTopupPacks(packsRaw).sort((a, b) => a.pack_id - b.pack_id);
  const normalizedBase = normalizeBaseUrl(publicBaseUrl);

  function getBackUrls() {
    if (successUrl && pendingUrl && failureUrl) {
      return {
        success: successUrl,
        pending: pendingUrl,
        failure: failureUrl,
      };
    }
    if (!normalizedBase) return null;
    return {
      success: `${normalizedBase}/topup/result?status=success`,
      pending: `${normalizedBase}/topup/result?status=pending`,
      failure: `${normalizedBase}/topup/result?status=failure`,
    };
  }

  function getNotificationUrl() {
    if (notificationUrl) return appendWebhookToken(notificationUrl, webhookToken);
    if (!normalizedBase) return '';
    return appendWebhookToken(`${normalizedBase}/billing/topup/webhook/mercadopago`, webhookToken);
  }

  function resolvePack(packId) {
    const id = toPositiveNumber(packId);
    if (!id) return null;
    return packs.find((pack) => pack.pack_id === id) || null;
  }

  async function createCheckout({ userId, botId = 'ufc', packId } = {}) {
    const cleanUserId = String(userId || '').trim();
    const cleanBotId = String(botId || '').trim() || 'ufc';
    if (!cleanUserId) {
      return { ok: false, status: 400, error_code: 'missing_user_id' };
    }

    const pack = resolvePack(packId);
    if (!pack) {
      return { ok: false, status: 400, error_code: 'invalid_pack_id', packs };
    }

    const externalReference = `bot_topup|${cleanUserId}|${cleanBotId}|${pack.credits}|${Date.now()}`;
    const payload = {
      items: [
        {
          id: `credits_${pack.credits}`,
          title: `${title} (${pack.credits} creditos)`,
          quantity: 1,
          currency_id: currencyId,
          unit_price: pack.amount,
        },
      ],
      metadata: {
        source: 'bot_factory',
        telegram_user_id: cleanUserId,
        bot_id: cleanBotId,
        credits: pack.credits,
      },
      external_reference: externalReference,
      auto_return: 'approved',
      notification_url: getNotificationUrl() || undefined,
      back_urls: getBackUrls() || undefined,
    };

    const result = await mpFetchJson({
      accessToken,
      path: '/checkout/preferences',
      method: 'POST',
      body: payload,
    });

    if (!result.ok) return result;

    return {
      ok: true,
      status: result.status,
      user_id: cleanUserId,
      bot_id: cleanBotId,
      pack_id: pack.pack_id,
      credits: pack.credits,
      amount: pack.amount,
      preference_id: result.payload?.id || null,
      redirect_url: result.payload?.init_point || result.payload?.sandbox_init_point || null,
    };
  }

  async function getPayment(paymentId) {
    const cleanPaymentId = String(paymentId || '').trim();
    if (!cleanPaymentId) {
      return { ok: false, status: 400, error_code: 'missing_payment_id' };
    }
    return mpFetchJson({
      accessToken,
      path: `/v1/payments/${encodeURIComponent(cleanPaymentId)}`,
      method: 'GET',
    });
  }

  function extractPaymentCreditMeta(paymentPayload = {}) {
    const paymentId = String(paymentPayload?.id || '').trim();
    const status = String(paymentPayload?.status || '').trim().toLowerCase();
    const transactionAmount = Number(paymentPayload?.transaction_amount) || 0;

    const metadataUserId = String(paymentPayload?.metadata?.telegram_user_id || '').trim();
    const metadataBotId = String(paymentPayload?.metadata?.bot_id || '').trim();
    const metadataCredits = toPositiveNumber(paymentPayload?.metadata?.credits);

    const parsedReference = parseExternalReference(paymentPayload?.external_reference || '');

    const userId = metadataUserId || parsedReference?.userId || '';
    const botId = metadataBotId || parsedReference?.botId || 'ufc';
    const credits = metadataCredits || parsedReference?.credits || null;

    if (!paymentId || !userId || !credits) {
      return {
        ok: false,
        error_code: 'missing_credit_metadata',
        payment_id: paymentId,
        status,
      };
    }

    return {
      ok: true,
      payment_id: paymentId,
      status,
      user_id: userId,
      bot_id: botId,
      credits,
      amount: transactionAmount,
      raw_payload: paymentPayload,
    };
  }

  return {
    config: {
      enabled: Boolean(accessToken),
      title,
      currency_id: currencyId,
      packs,
      has_notification_url: Boolean(getNotificationUrl()),
      has_back_urls: Boolean(getBackUrls()),
    },
    packs,
    createCheckout,
    getPayment,
    extractPaymentCreditMeta,
  };
}
