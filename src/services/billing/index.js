import '../../core/env.js';
import { createBillingStore } from './store.js';
import { createMercadoPagoGateway } from './mercadoPagoGateway.js';
import { createBillingServer } from './server.js';

function resolveEventHooks() {
  const fromList = String(process.env.BILLING_EVENT_WEBHOOK_URLS || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const single = String(process.env.BILLING_EVENT_WEBHOOK_URL || '').trim();
  if (single) {
    fromList.push(single);
  }
  return [...new Set(fromList)];
}

function bootstrapBillingService() {
  const store = createBillingStore();
  const mercadoPago = createMercadoPagoGateway();
  const eventHooks = resolveEventHooks();

  const app = createBillingServer({
    store,
    mercadoPago,
    onTopupCredited: async (event) => {
      if (!eventHooks.length) return;
      await Promise.allSettled(
        eventHooks.map((hookUrl) =>
          fetch(hookUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-billing-token': process.env.BILLING_API_TOKEN || '',
            },
            body: JSON.stringify({
              type: 'topup_credited',
              ...event,
            }),
          }).catch((error) => {
            console.error(`[billing] failed to emit topup event (${hookUrl}):`, error);
          })
        )
      );
    },
  });

  app.start();
}

bootstrapBillingService();
