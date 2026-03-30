import '../../core/env.js';
import { createBillingStore } from './store.js';
import { createMercadoPagoGateway } from './mercadoPagoGateway.js';
import { createBillingServer } from './server.js';
import { startBillingDbReliabilityLoop } from './reliability.js';

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
  const reliability = startBillingDbReliabilityLoop({
    dbPath: store.dbPath,
  });

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

  const server = app.start();
  let shutdownInFlight = false;
  const shutdown = (signal = 'SIGTERM') => {
    if (shutdownInFlight) return;
    shutdownInFlight = true;
    console.log(`[billing] shutting down (${signal})`);
    reliability.stop();
    server.close(() => {
      try {
        store.close();
      } finally {
        process.exit(0);
      }
    });
    setTimeout(() => {
      try {
        store.close();
      } finally {
        process.exit(1);
      }
    }, 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

bootstrapBillingService();
