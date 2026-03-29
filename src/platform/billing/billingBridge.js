import crypto from 'node:crypto';

function normalizeStatePayload(payload = {}) {
  const weekValue = payload.week_id ?? payload.weekId ?? '';
  return {
    paidCredits: Number(payload.paid_credits ?? payload.paidCredits) || 0,
    freeCredits: Number(payload.free_credits ?? payload.freeCredits) || 0,
    weekId: String(weekValue).trim() || null,
    availableCredits: Number(payload.available_credits ?? payload.availableCredits) || 0,
  };
}

function normalizeTransactions(items = []) {
  if (!Array.isArray(items)) return [];
  return items.map((row) => ({
    id: row.id || null,
    amount: Number(row.amount) || 0,
    type: row.type || null,
    reason: row.reason || null,
    metadata: row.metadata || null,
    createdAt: row.created_at || row.createdAt || null,
  }));
}

function normalizeUsage(payload = {}) {
  return {
    imagesToday: Number(payload.images_today ?? payload.imagesToday) || 0,
    audioSecondsWeek: Number(payload.audio_seconds_week ?? payload.audioSecondsWeek) || 0,
  };
}

function buildIdempotencyKey({ userId, amount, reason }) {
  const seed = `${String(userId || '').trim()}|${Number(amount) || 0}|${String(reason || '').trim()}|${Date.now()}|${crypto.randomUUID()}`;
  return crypto.createHash('sha256').update(seed).digest('hex').slice(0, 40);
}

export function createBillingUserStoreBridge({
  billingClient,
  fallbackUserStore = {},
} = {}) {
  const clientEnabled = Boolean(billingClient?.isEnabled?.());

  async function resolveStateAsync(userId) {
    if (!clientEnabled) return null;
    const result = await billingClient.getState(userId);
    if (!result?.ok || !result.state) return null;
    return normalizeStatePayload(result.state);
  }

  return {
    isExternalBillingEnabled: clientEnabled,

    getCreditState(userId, weeklyFreeCredits = 5) {
      if (!clientEnabled) {
        return fallbackUserStore?.getCreditState?.(userId, weeklyFreeCredits) || null;
      }
      return fallbackUserStore?.getCreditState?.(userId, 0) || {
        paidCredits: 0,
        freeCredits: 0,
        availableCredits: 0,
        weekId: null,
      };
    },

    async refreshCreditState(userId) {
      const state = await resolveStateAsync(userId);
      if (state) return state;
      return fallbackUserStore?.getCreditState?.(userId, 0) || null;
    },

    listCreditTransactions(userId, options = {}) {
      if (!clientEnabled) {
        return fallbackUserStore?.listCreditTransactions?.(userId, options) || [];
      }
      return fallbackUserStore?.listCreditTransactions?.(userId, options) || [];
    },

    async refreshCreditTransactions(userId, options = {}) {
      if (!clientEnabled) {
        return fallbackUserStore?.listCreditTransactions?.(userId, options) || [];
      }
      const result = await billingClient.listTransactions(userId, options);
      if (!result?.ok) {
        return fallbackUserStore?.listCreditTransactions?.(userId, options) || [];
      }
      return normalizeTransactions(result.transactions || []);
    },

    getUsageCounters(params = {}) {
      if (!clientEnabled) {
        return fallbackUserStore?.getUsageCounters?.(params) || {
          imagesToday: 0,
          audioSecondsWeek: 0,
        };
      }
      return fallbackUserStore?.getUsageCounters?.(params) || {
        imagesToday: 0,
        audioSecondsWeek: 0,
      };
    },

    async refreshUsageCounters(userId) {
      if (!clientEnabled) {
        return {
          imagesToday: 0,
          audioSecondsWeek: 0,
        };
      }
      const result = await billingClient.getUsage(userId);
      if (!result?.ok || !result.usage) {
        return {
          imagesToday: 0,
          audioSecondsWeek: 0,
        };
      }
      return normalizeUsage(result.usage);
    },

    spendCredits(userId, amount, { reason = 'usage', metadata = null, idempotencyKey = '' } = {}) {
      if (!clientEnabled) {
        return (
          fallbackUserStore?.spendCredits?.(userId, amount, { reason, metadata }) || {
            ok: false,
            error: 'billing_unavailable',
          }
        );
      }

      const key = String(idempotencyKey || '').trim() || buildIdempotencyKey({ userId, amount, reason });

      return billingClient.spend({
        userId,
        amount,
        reason,
        metadata,
        idempotencyKey: key,
      });
    },

    addCredits(userId, amount, { reason = 'manual_topup', metadata = null } = {}) {
      if (!clientEnabled) {
        return (
          fallbackUserStore?.addCredits?.(userId, amount, { reason, metadata }) || {
            ok: false,
            error: 'billing_unavailable',
          }
        );
      }
      return billingClient.addCredits({ userId, amount, reason, metadata });
    },
  };
}
