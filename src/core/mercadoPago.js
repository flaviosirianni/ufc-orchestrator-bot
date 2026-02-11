import './env.js';

const MP_API_BASE_URL = 'https://api.mercadopago.com';
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || '';
const MP_TOPUP_PACKS = process.env.MP_TOPUP_PACKS || '';
const MP_TOPUP_DEFAULT_CREDITS = Number(process.env.MP_TOPUP_DEFAULT_CREDITS || '0');
const MP_TOPUP_TITLE = process.env.MP_TOPUP_TITLE || 'Recarga de creditos UFC';
const MP_CURRENCY_ID = process.env.MP_CURRENCY_ID || 'ARS';
const MP_NOTIFICATION_URL = process.env.MP_NOTIFICATION_URL || '';
const MP_WEBHOOK_TOKEN = process.env.MP_WEBHOOK_TOKEN || '';
const APP_PUBLIC_URL = process.env.APP_PUBLIC_URL || '';
const MP_SUCCESS_URL = process.env.MP_SUCCESS_URL || '';
const MP_PENDING_URL = process.env.MP_PENDING_URL || '';
const MP_FAILURE_URL = process.env.MP_FAILURE_URL || '';

function toPositiveNumber(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
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
    const [creditsRaw, amountRaw] = entry.split(':').map((part) => part?.trim());
    const credits = toPositiveNumber(creditsRaw);
    const amount = toPositiveNumber(amountRaw);
    if (!credits || !amount) {
      continue;
    }
    map.set(credits, amount);
  }

  return map;
}

const parsedPacks = parseTopupPacks(MP_TOPUP_PACKS);

function getTopupPacksList() {
  return [...parsedPacks.entries()]
    .map(([credits, amount]) => ({ credits, amount }))
    .sort((a, b) => a.credits - b.credits);
}

function resolveTopupSelection(creditsRequested) {
  const packs = getTopupPacksList();
  if (!packs.length) {
    return {
      ok: false,
      error: 'missing_topup_packs',
    };
  }

  const normalizedRequested = toPositiveNumber(creditsRequested);
  if (normalizedRequested) {
    const pack = packs.find((candidate) => candidate.credits === normalizedRequested);
    if (!pack) {
      return {
        ok: false,
        error: 'invalid_topup_credits',
        packs,
      };
    }
    return {
      ok: true,
      ...pack,
      packs,
    };
  }

  if (toPositiveNumber(MP_TOPUP_DEFAULT_CREDITS)) {
    const defaultPack = packs.find(
      (candidate) => candidate.credits === MP_TOPUP_DEFAULT_CREDITS
    );
    if (defaultPack) {
      return {
        ok: true,
        ...defaultPack,
        packs,
      };
    }
  }

  return {
    ok: true,
    ...packs[0],
    packs,
  };
}

function buildExternalReference({ userId, credits }) {
  const safeUserId = String(userId || '').trim();
  return `ufc_topup|${safeUserId}|${credits}|${Date.now()}`;
}

function buildBackUrls(baseUrl = '') {
  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized) {
    return null;
  }
  return {
    success: `${normalized}/topup/result?status=success`,
    pending: `${normalized}/topup/result?status=pending`,
    failure: `${normalized}/topup/result?status=failure`,
  };
}

function appendWebhookToken(rawUrl = '') {
  if (!rawUrl || !MP_WEBHOOK_TOKEN) {
    return rawUrl;
  }
  try {
    const parsed = new URL(rawUrl);
    if (!parsed.searchParams.get('token')) {
      parsed.searchParams.set('token', MP_WEBHOOK_TOKEN);
    }
    return parsed.toString();
  } catch {
    const delimiter = rawUrl.includes('?') ? '&' : '?';
    return `${rawUrl}${delimiter}token=${encodeURIComponent(MP_WEBHOOK_TOKEN)}`;
  }
}

function getNotificationUrl() {
  if (MP_NOTIFICATION_URL) {
    return appendWebhookToken(MP_NOTIFICATION_URL);
  }
  const normalized = normalizeBaseUrl(APP_PUBLIC_URL);
  if (!normalized) {
    return '';
  }
  return appendWebhookToken(`${normalized}/webhooks/mercadopago`);
}

function getBackUrls() {
  if (MP_SUCCESS_URL && MP_PENDING_URL && MP_FAILURE_URL) {
    return {
      success: MP_SUCCESS_URL,
      pending: MP_PENDING_URL,
      failure: MP_FAILURE_URL,
    };
  }
  return buildBackUrls(APP_PUBLIC_URL);
}

function getPreferencePayload({
  userId,
  credits,
  amount,
  notificationUrl,
  backUrls,
  externalReference,
}) {
  const payload = {
    items: [
      {
        id: `credits_${credits}`,
        title: `${MP_TOPUP_TITLE} (${credits} creditos)`,
        quantity: 1,
        currency_id: MP_CURRENCY_ID,
        unit_price: amount,
      },
    ],
    external_reference: externalReference,
    metadata: {
      source: 'ufc_orchestrator_bot',
      telegram_user_id: String(userId),
      credits,
    },
    auto_return: 'approved',
  };

  if (notificationUrl) {
    payload.notification_url = notificationUrl;
  }
  if (backUrls?.success && backUrls?.pending && backUrls?.failure) {
    payload.back_urls = backUrls;
  }

  return payload;
}

async function mpFetchJson(path, { method = 'GET', body = null } = {}) {
  if (!MP_ACCESS_TOKEN) {
    return { ok: false, status: 500, error: 'missing_mp_access_token' };
  }

  const response = await fetch(`${MP_API_BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : null,
  });

  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = null;
  }

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: json?.message || 'mercadopago_api_error',
      body: json || text,
    };
  }

  return {
    ok: true,
    status: response.status,
    body: json || {},
  };
}

export function getMercadoPagoConfig() {
  return {
    enabled: Boolean(MP_ACCESS_TOKEN),
    packs: getTopupPacksList(),
    hasNotificationUrl: Boolean(getNotificationUrl()),
    hasBackUrls: Boolean(getBackUrls()),
    currencyId: MP_CURRENCY_ID,
  };
}

export async function createTopupPreference({ userId, creditsRequested } = {}) {
  const cleanUserId = String(userId || '').trim();
  if (!cleanUserId) {
    return { ok: false, status: 400, error: 'missing_user_id' };
  }

  const selection = resolveTopupSelection(creditsRequested);
  if (!selection.ok) {
    return { ok: false, status: 400, error: selection.error, packs: selection.packs || [] };
  }

  const notificationUrl = getNotificationUrl();
  const backUrls = getBackUrls();
  const externalReference = buildExternalReference({
    userId: cleanUserId,
    credits: selection.credits,
  });

  const payload = getPreferencePayload({
    userId: cleanUserId,
    credits: selection.credits,
    amount: selection.amount,
    notificationUrl,
    backUrls,
    externalReference,
  });

  const preference = await mpFetchJson('/checkout/preferences', {
    method: 'POST',
    body: payload,
  });

  if (!preference.ok) {
    return preference;
  }

  return {
    ok: true,
    status: preference.status,
    credits: selection.credits,
    amount: selection.amount,
    preference: preference.body,
    redirectUrl: preference.body?.init_point || preference.body?.sandbox_init_point || '',
  };
}

export async function getPaymentById(paymentId) {
  const cleanId = String(paymentId || '').trim();
  if (!cleanId) {
    return { ok: false, status: 400, error: 'missing_payment_id' };
  }
  return mpFetchJson(`/v1/payments/${encodeURIComponent(cleanId)}`);
}

function parseExternalReference(externalReference = '') {
  const value = String(externalReference || '').trim();
  if (!value.startsWith('ufc_topup|')) {
    return null;
  }
  const parts = value.split('|');
  if (parts.length < 3) {
    return null;
  }

  const userId = String(parts[1] || '').trim();
  const credits = toPositiveNumber(parts[2]);
  if (!userId || !credits) {
    return null;
  }

  return { userId, credits };
}

export function extractTopupCreditFromPayment(payment = {}) {
  const status = String(payment?.status || '').toLowerCase();
  const paymentId = String(payment?.id || '').trim();
  const transactionAmount = toPositiveNumber(payment?.transaction_amount) || 0;
  const currencyId = String(payment?.currency_id || '').trim() || null;
  const externalReference = String(payment?.external_reference || '').trim();

  const metadataUserId = String(payment?.metadata?.telegram_user_id || '').trim();
  const metadataCredits = toPositiveNumber(payment?.metadata?.credits);
  const parsedRef = parseExternalReference(externalReference);

  const userId = metadataUserId || parsedRef?.userId || '';
  const credits = metadataCredits || parsedRef?.credits || null;

  if (!paymentId || !userId || !credits) {
    return {
      ok: false,
      error: 'missing_credit_metadata',
      paymentId,
      userId,
      credits,
      status,
    };
  }

  return {
    ok: true,
    paymentId,
    userId,
    credits,
    status,
    transactionAmount,
    currencyId,
    externalReference,
  };
}
