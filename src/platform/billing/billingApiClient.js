import crypto from 'node:crypto';

function normalizeBaseUrl(url = '') {
  const value = String(url || '').trim();
  if (!value) return '';
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function buildTraceId() {
  return crypto.randomUUID();
}

async function readJsonSafe(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { ok: false, error_code: 'invalid_json_response', raw: text };
  }
}

export function createBillingApiClient({
  baseUrl = process.env.BILLING_BASE_URL || '',
  apiToken = process.env.BILLING_API_TOKEN || '',
  botId = process.env.BOT_ID || 'ufc',
  timeoutMs = Number(process.env.BILLING_TIMEOUT_MS || '8000'),
} = {}) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);

  async function request(path, { method = 'GET', body = null } = {}) {
    if (!normalizedBaseUrl) {
      return { ok: false, error_code: 'billing_unavailable' };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const traceId = buildTraceId();

    try {
      const response = await fetch(`${normalizedBaseUrl}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'x-billing-token': apiToken,
          'x-trace-id': traceId,
        },
        body: body ? JSON.stringify(body) : null,
        signal: controller.signal,
      });

      const payload = await readJsonSafe(response);
      if (!response.ok) {
        return {
          ok: false,
          status: response.status,
          trace_id: payload?.trace_id || traceId,
          error_code: payload?.error_code || payload?.error || 'billing_http_error',
          payload,
        };
      }

      return {
        ok: payload?.ok !== false,
        status: response.status,
        trace_id: payload?.trace_id || traceId,
        ...payload,
      };
    } catch (error) {
      return {
        ok: false,
        error_code: error?.name === 'AbortError' ? 'billing_timeout' : 'billing_network_error',
        trace_id: traceId,
        message: error instanceof Error ? error.message : String(error),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    isEnabled() {
      return Boolean(normalizedBaseUrl);
    },
    async spend({ userId, amount, reason = 'usage', idempotencyKey, metadata = null } = {}) {
      return request('/billing/spend', {
        method: 'POST',
        body: {
          user_id: String(userId || '').trim(),
          bot_id: String(botId || '').trim() || 'ufc',
          amount: Number(amount) || 0,
          reason,
          idempotency_key: String(idempotencyKey || '').trim(),
          metadata,
        },
      });
    },
    async getState(userId) {
      const safeUserId = encodeURIComponent(String(userId || '').trim());
      return request(`/billing/state?user_id=${safeUserId}`);
    },
    async listTransactions(userId, { limit = 8 } = {}) {
      const safeUserId = encodeURIComponent(String(userId || '').trim());
      return request(`/billing/transactions?user_id=${safeUserId}&limit=${Number(limit) || 8}`);
    },
    async getUsage(userId) {
      const safeUserId = encodeURIComponent(String(userId || '').trim());
      return request(`/billing/usage?user_id=${safeUserId}`);
    },
    async createCheckout({ userId, packId } = {}) {
      return request('/billing/topup/create-checkout', {
        method: 'POST',
        body: {
          user_id: String(userId || '').trim(),
          bot_id: String(botId || '').trim() || 'ufc',
          pack_id: Number(packId) || 0,
        },
      });
    },
    async getTopupConfig() {
      return request('/billing/topup/config');
    },
    async addCredits({ userId, amount, reason = 'manual_topup', metadata = null } = {}) {
      return request('/billing/admin/add-credits', {
        method: 'POST',
        body: {
          user_id: String(userId || '').trim(),
          bot_id: String(botId || '').trim() || 'ufc',
          amount: Number(amount) || 0,
          reason,
          metadata,
        },
      });
    },
  };
}
