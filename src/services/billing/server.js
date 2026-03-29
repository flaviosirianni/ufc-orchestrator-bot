import http from 'node:http';
import crypto from 'node:crypto';

function nowTraceId() {
  return crypto.randomUUID();
}

function sendJson(res, statusCode, payload = {}) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function sendBillingJson(res, statusCode, traceId, payload = {}, { okDefault = true } = {}) {
  const safePayload =
    payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const normalized = {
    ok: okDefault,
    error_code: null,
    idempotency_status: null,
    trace_id: traceId,
    ...safePayload,
  };
  if (normalized.ok === false && !normalized.error_code) {
    normalized.error_code = 'billing_error';
  }
  sendJson(res, statusCode, normalized);
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve(null);
      }
    });
  });
}

function requireInternalToken(req, expectedToken = '') {
  if (!expectedToken) return true;
  const provided = String(req.headers['x-billing-token'] || '').trim();
  return provided === expectedToken;
}

function toPositiveNumber(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function buildResultHtml(status = 'unknown') {
  const normalized = String(status || 'unknown').trim().toLowerCase();
  const titleByStatus = {
    success: '✅ Recarga acreditada',
    approved: '✅ Recarga acreditada',
    pending: '🕓 Pago pendiente',
    failure: '❌ Pago no completado',
    rejected: '❌ Pago rechazado',
    cancelled: '❌ Pago cancelado',
  };
  const title = titleByStatus[normalized] || 'ℹ️ Estado de recarga';
  return [
    '<!doctype html>',
    '<html lang="es">',
    '<head>',
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    '<title>Estado de recarga</title>',
    '</head>',
    '<body>',
    `<h1>${title}</h1>`,
    '<p>Volvé al chat de Telegram y revisá tus créditos.</p>',
    '</body>',
    '</html>',
  ].join('');
}

function buildChooserHtml({ userId = '', botId = '', packs = [] } = {}) {
  const safeUserId = encodeURIComponent(String(userId || '').trim());
  const safeBotId = encodeURIComponent(String(botId || '').trim() || 'ufc');
  const links = (Array.isArray(packs) ? packs : [])
    .map((pack) => {
      const packId = Number(pack?.pack_id || pack?.credits) || 0;
      const amount = Number(pack?.amount) || 0;
      if (!packId || !amount) return '';
      return `<li><a href="/topup/checkout?user_id=${safeUserId}&bot_id=${safeBotId}&pack_id=${packId}">${packId} creditos - $${amount.toLocaleString('es-AR')}</a></li>`;
    })
    .filter(Boolean)
    .join('');
  return [
    '<!doctype html>',
    '<html lang="es">',
    '<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>Elegir pack</title></head>',
    '<body>',
    '<h1>Elegí un pack de recarga</h1>',
    `<ul>${links || '<li>No hay packs configurados</li>'}</ul>`,
    '</body>',
    '</html>',
  ].join('');
}

export function createBillingServer({
  store,
  mercadoPago,
  port = Number(process.env.BILLING_PORT || process.env.PORT || '3200'),
  apiToken = process.env.BILLING_API_TOKEN || '',
  webhookToken = process.env.MP_WEBHOOK_TOKEN || '',
  weeklyFreeCredits = Number(process.env.BILLING_FREE_WEEKLY || process.env.CREDIT_FREE_WEEKLY || '5'),
  onTopupCredited = null,
} = {}) {
  if (!store) {
    throw new Error('createBillingServer requiere store.');
  }

  const server = http.createServer(async (req, res) => {
    const traceId = nowTraceId();
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/') {
      sendJson(res, 200, { ok: true, service: 'billing-service', trace_id: traceId });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/billing/topup/config') {
      if (!requireInternalToken(req, apiToken)) {
        sendBillingJson(res, 403, traceId, { ok: false, error_code: 'forbidden' });
        return;
      }
      sendBillingJson(res, 200, traceId, {
        ok: true,
        ...mercadoPago.config,
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/billing/state') {
      if (!requireInternalToken(req, apiToken)) {
        sendBillingJson(res, 403, traceId, { ok: false, error_code: 'forbidden' });
        return;
      }
      const userId = String(url.searchParams.get('user_id') || '').trim();
      if (!userId) {
        sendBillingJson(res, 400, traceId, { ok: false, error_code: 'missing_user_id' });
        return;
      }
      const state = store.getState(userId, { weeklyFreeCredits });
      sendBillingJson(res, 200, traceId, { ok: true, state });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/billing/transactions') {
      if (!requireInternalToken(req, apiToken)) {
        sendBillingJson(res, 403, traceId, { ok: false, error_code: 'forbidden' });
        return;
      }
      const userId = String(url.searchParams.get('user_id') || '').trim();
      const limit = Number(url.searchParams.get('limit') || '8');
      if (!userId) {
        sendBillingJson(res, 400, traceId, { ok: false, error_code: 'missing_user_id' });
        return;
      }
      const transactions = store.listTransactions(userId, { limit });
      sendBillingJson(res, 200, traceId, { ok: true, transactions });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/billing/usage') {
      if (!requireInternalToken(req, apiToken)) {
        sendBillingJson(res, 403, traceId, { ok: false, error_code: 'forbidden' });
        return;
      }
      const userId = String(url.searchParams.get('user_id') || '').trim();
      if (!userId) {
        sendBillingJson(res, 400, traceId, { ok: false, error_code: 'missing_user_id' });
        return;
      }
      const usage = store.listUsageCounters(userId);
      sendBillingJson(res, 200, traceId, { ok: true, usage });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/billing/spend') {
      if (!requireInternalToken(req, apiToken)) {
        sendBillingJson(res, 403, traceId, { ok: false, error_code: 'forbidden' });
        return;
      }

      const payload = await readJsonBody(req);
      if (!payload) {
        sendBillingJson(res, 400, traceId, { ok: false, error_code: 'invalid_payload' });
        return;
      }

      const result = store.spendCredits({
        userId: payload.user_id,
        botId: payload.bot_id || null,
        amount: payload.amount,
        reason: payload.reason || 'usage',
        metadata: payload.metadata || null,
        idempotencyKey: payload.idempotency_key,
        weeklyFreeCredits,
      });

      const statusCode = result?.ok ? 200 : result?.error_code === 'insufficient_credits' ? 402 : 400;
      sendBillingJson(res, statusCode, traceId, { ...result }, { okDefault: Boolean(result?.ok) });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/billing/admin/add-credits') {
      if (!requireInternalToken(req, apiToken)) {
        sendBillingJson(res, 403, traceId, { ok: false, error_code: 'forbidden' });
        return;
      }

      const payload = await readJsonBody(req);
      if (!payload) {
        sendBillingJson(res, 400, traceId, { ok: false, error_code: 'invalid_payload' });
        return;
      }

      const result = store.addCredits({
        userId: payload.user_id,
        botId: payload.bot_id || null,
        amount: payload.amount,
        reason: payload.reason || 'manual_topup',
        metadata: payload.metadata || null,
        weeklyFreeCredits,
      });

      sendBillingJson(
        res,
        result?.ok ? 200 : 400,
        traceId,
        { ...result },
        { okDefault: Boolean(result?.ok) }
      );
      return;
    }

    if (req.method === 'POST' && url.pathname === '/billing/topup/create-checkout') {
      if (!requireInternalToken(req, apiToken)) {
        sendBillingJson(res, 403, traceId, { ok: false, error_code: 'forbidden' });
        return;
      }

      const payload = await readJsonBody(req);
      if (!payload) {
        sendBillingJson(res, 400, traceId, { ok: false, error_code: 'invalid_payload' });
        return;
      }

      const packId = toPositiveNumber(payload.pack_id);
      const checkout = await mercadoPago.createCheckout({
        userId: payload.user_id,
        botId: payload.bot_id || 'ufc',
        packId,
      });

      sendBillingJson(
        res,
        checkout.ok ? 200 : checkout.status || 400,
        traceId,
        { ...checkout },
        { okDefault: Boolean(checkout?.ok) }
      );
      return;
    }

    if (req.method === 'POST' && url.pathname === '/billing/topup/webhook/mercadopago') {
      const token = String(url.searchParams.get('token') || '').trim();
      if (webhookToken && token !== webhookToken && !requireInternalToken(req, apiToken)) {
        sendBillingJson(res, 403, traceId, { ok: false, error_code: 'forbidden' });
        return;
      }

      const payload = await readJsonBody(req);
      const topic = String(
        payload?.type || url.searchParams.get('type') || url.searchParams.get('topic') || ''
      ).toLowerCase();
      const paymentId = String(
        payload?.data?.id ||
          (topic === 'payment' ? payload?.id : '') ||
          url.searchParams.get('id') ||
          ''
      ).trim();

      if (topic && topic !== 'payment') {
        sendBillingJson(res, 200, traceId, {
          ok: true,
          ignored: true,
          reason: 'non_payment_topic',
        });
        return;
      }

      if (!paymentId) {
        sendBillingJson(res, 200, traceId, {
          ok: true,
          ignored: true,
          reason: 'missing_payment_id',
        });
        return;
      }

      const paymentResponse = await mercadoPago.getPayment(paymentId);
      if (!paymentResponse.ok) {
        sendBillingJson(res, paymentResponse.status || 502, traceId, {
          ok: false,
          error_code: paymentResponse.error_code || 'could_not_fetch_payment',
        });
        return;
      }

      const parsed = mercadoPago.extractPaymentCreditMeta(paymentResponse.payload || {});
      if (!parsed.ok) {
        sendBillingJson(res, 200, traceId, {
          ok: true,
          ignored: true,
          reason: parsed.error_code || 'missing_credit_metadata',
        });
        return;
      }

      if (parsed.status !== 'approved') {
        sendBillingJson(res, 200, traceId, {
          ok: true,
          processed: false,
          payment_id: parsed.payment_id,
          payment_status: parsed.status,
        });
        return;
      }

      const credited = store.creditFromPayment({
        paymentId: parsed.payment_id,
        userId: parsed.user_id,
        botId: parsed.bot_id,
        credits: parsed.credits,
        amount: parsed.amount,
        status: parsed.status,
        rawPayload: parsed.raw_payload,
        weeklyFreeCredits,
      });

      if (!credited.ok) {
        sendBillingJson(res, 500, traceId, {
          ok: false,
          error_code: credited.error_code || 'could_not_credit_payment',
        });
        return;
      }

      if (!credited.alreadyProcessed && typeof onTopupCredited === 'function') {
        await onTopupCredited({
          user_id: parsed.user_id,
          bot_id: parsed.bot_id,
          credits: parsed.credits,
          amount: parsed.amount,
          payment_id: parsed.payment_id,
          state: credited.state,
        }).catch((error) => {
          console.error('[billing] onTopupCredited failed:', error);
        });
      }

      sendBillingJson(res, 200, traceId, {
        ok: true,
        payment_id: parsed.payment_id,
        user_id: parsed.user_id,
        bot_id: parsed.bot_id,
        credits: parsed.credits,
        alreadyProcessed: Boolean(credited.alreadyProcessed),
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/topup/checkout') {
      const userId = String(url.searchParams.get('user_id') || '').trim();
      const botId = String(url.searchParams.get('bot_id') || 'ufc').trim();
      const packId = toPositiveNumber(url.searchParams.get('pack_id') || url.searchParams.get('credits'));
      const format = String(url.searchParams.get('format') || '').toLowerCase();

      if (!packId && format !== 'json') {
        const chooserHtml = buildChooserHtml({ userId, botId, packs: mercadoPago.packs || [] });
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(chooserHtml);
        return;
      }

      const checkout = await mercadoPago.createCheckout({ userId, botId, packId });
      if (!checkout.ok) {
        sendJson(res, checkout.status || 400, { ...checkout, trace_id: traceId });
        return;
      }

      if (format === 'json') {
        sendJson(res, 200, { ...checkout, trace_id: traceId });
        return;
      }

      if (!checkout.redirect_url) {
        sendJson(res, 500, { ok: false, error_code: 'missing_redirect_url', trace_id: traceId });
        return;
      }

      res.writeHead(302, { Location: checkout.redirect_url });
      res.end();
      return;
    }

    if (req.method === 'GET' && url.pathname === '/topup/result') {
      const status = String(url.searchParams.get('status') || 'unknown');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(buildResultHtml(status));
      return;
    }

    sendJson(res, 404, { ok: false, error_code: 'not_found', trace_id: traceId });
  });

  return {
    server,
    start() {
      server.listen(port, () => {
        console.log(`[billing] listening on port ${port}`);
      });
      return server;
    },
  };
}
