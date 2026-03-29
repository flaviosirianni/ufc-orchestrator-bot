import http from 'node:http';

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
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

function hasExpectedBillingToken(req) {
  const expected = String(process.env.BILLING_API_TOKEN || '').trim();
  if (!expected) return true;
  const provided = String(req.headers['x-billing-token'] || '').trim();
  return provided === expected;
}

function escapeHtml(value = '') {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatMoneyByCurrency(amount = 0, currencyId = 'ARS') {
  const value = Number(amount) || 0;
  const currency = String(currencyId || 'ARS').toUpperCase();
  try {
    return new Intl.NumberFormat('es-AR', {
      style: 'currency',
      currency,
      maximumFractionDigits: 0,
    }).format(value);
  } catch {
    return `$${Math.round(value).toLocaleString('es-AR')}`;
  }
}

function buildTopupChooserHtml({ userId = '', packs = [], currencyId = 'ARS', title = '' } = {}) {
  const encodedUserId = encodeURIComponent(String(userId || '').trim());
  const safeTitle = String(title || 'Recargar creditos');
  const packItems = (Array.isArray(packs) ? packs : [])
    .map((pack) => {
      const credits = Number(pack?.credits || pack?.pack_id) || 0;
      const amount = Number(pack?.amount) || 0;
      if (!credits || !amount) return '';
      const href = `/topup/checkout?user_id=${encodedUserId}&pack_id=${credits}`;
      return `<li><a href="${escapeHtml(href)}">${credits} creditos - ${escapeHtml(
        formatMoneyByCurrency(amount, currencyId)
      )}</a></li>`;
    })
    .filter(Boolean)
    .join('');

  return [
    '<!doctype html>',
    '<html lang="es">',
    '<head>',
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    `<title>${escapeHtml(safeTitle)}</title>`,
    '<style>',
    'body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 24px; color: #111827; }',
    'main { max-width: 560px; margin: 0 auto; }',
    'h1 { font-size: 1.35rem; margin-bottom: 0.5rem; }',
    'ul { list-style: none; padding: 0; margin: 1rem 0; display: grid; gap: 10px; }',
    'a { display: block; padding: 12px 14px; border: 1px solid #d1d5db; border-radius: 10px; text-decoration: none; color: #111827; font-weight: 600; }',
    'a:hover { border-color: #2563eb; background: #eff6ff; }',
    '</style>',
    '</head>',
    '<body>',
    '<main>',
    `<h1>${escapeHtml(safeTitle)}</h1>`,
    '<p>Elegí un pack. Luego se abre Mercado Pago para finalizar la recarga.</p>',
    `<ul>${packItems || '<li>No hay packs configurados.</li>'}</ul>`,
    '</main>',
    '</body>',
    '</html>',
  ].join('');
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
    `<h1>${escapeHtml(title)}</h1>`,
    '<p>Volvé al chat de Telegram para ver el estado actualizado de tus créditos.</p>',
    '</body>',
    '</html>',
  ].join('');
}

export function createHealthServer(
  port,
  {
    appName = 'Bot Factory runtime',
    botId = 'ufc',
    billingClient = null,
    onTopupApplied = null,
    legacyTopup = null,
  } = {}
) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const externalBillingEnabled = Boolean(billingClient?.isEnabled?.());

    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(`${appName} (${botId}) running.`);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/topup/config') {
      if (externalBillingEnabled) {
        const config = await billingClient.getTopupConfig();
        sendJson(res, config.ok ? 200 : 502, config);
        return;
      }

      if (legacyTopup?.getConfig) {
        const config = await legacyTopup.getConfig();
        sendJson(res, config?.ok ? 200 : 502, config || { ok: false, error_code: 'legacy_config_failed' });
        return;
      }

      sendJson(res, 200, { ok: true, enabled: false, packs: [] });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/topup/checkout') {
      const userId =
        url.searchParams.get('user_id') ||
        url.searchParams.get('telegram_user_id') ||
        '';
      const packId = Number(url.searchParams.get('pack_id') || url.searchParams.get('credits') || '0');
      const format = String(url.searchParams.get('format') || '').toLowerCase();

      if (externalBillingEnabled) {
        if (!packId && format !== 'json') {
          if (!String(userId || '').trim()) {
            sendJson(res, 400, { ok: false, error_code: 'missing_user_id' });
            return;
          }
          const config = await billingClient.getTopupConfig();
          const chooserHtml = buildTopupChooserHtml({
            userId,
            packs: config?.packs || [],
            currencyId: config?.currency_id || 'ARS',
            title: config?.title || 'Recargar creditos',
          });
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(chooserHtml);
          return;
        }

        const checkout = await billingClient.createCheckout({ userId, packId });
        if (!checkout.ok) {
          sendJson(res, 400, checkout);
          return;
        }

        if (format === 'json') {
          sendJson(res, 200, checkout);
          return;
        }

        if (!checkout.redirect_url) {
          sendJson(res, 500, { ok: false, error_code: 'missing_redirect_url' });
          return;
        }

        res.writeHead(302, { Location: checkout.redirect_url });
        res.end();
        return;
      }

      if (!legacyTopup?.createCheckout) {
        sendJson(res, 503, { ok: false, error_code: 'billing_unavailable' });
        return;
      }

      if (!packId && format !== 'json') {
        if (!String(userId || '').trim()) {
          sendJson(res, 400, { ok: false, error_code: 'missing_user_id' });
          return;
        }
        const config = legacyTopup?.getConfig ? await legacyTopup.getConfig() : { ok: true };
        const chooserHtml = buildTopupChooserHtml({
          userId,
          packs: config?.packs || [],
          currencyId: config?.currency_id || 'ARS',
          title: config?.title || 'Recargar creditos',
        });
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(chooserHtml);
        return;
      }

      const checkout = await legacyTopup.createCheckout({ userId, packId });
      if (!checkout?.ok) {
        sendJson(res, Number(checkout?.status) || 400, checkout || { ok: false, error_code: 'legacy_checkout_failed' });
        return;
      }

      if (format === 'json') {
        sendJson(res, 200, checkout);
        return;
      }

      if (!checkout.redirect_url) {
        sendJson(res, 500, { ok: false, error_code: 'missing_redirect_url' });
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

    if (req.method === 'POST' && url.pathname === '/webhooks/mercadopago') {
      const payload = await readJsonBody(req);

      if (externalBillingEnabled) {
        const forwarded = await fetch(`${process.env.BILLING_BASE_URL || ''}/billing/topup/webhook/mercadopago?bot_id=${encodeURIComponent(botId)}&${url.searchParams.toString()}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-billing-token': process.env.BILLING_API_TOKEN || '',
          },
          body: JSON.stringify(payload || {}),
        }).catch(() => null);

        if (!forwarded) {
          sendJson(res, 502, { ok: false, error_code: 'billing_forward_failed' });
          return;
        }

        const text = await forwarded.text();
        let responsePayload = {};
        try {
          responsePayload = text ? JSON.parse(text) : {};
        } catch {
          responsePayload = { ok: false, raw: text };
        }

        if (responsePayload?.ok && !responsePayload?.alreadyProcessed && typeof onTopupApplied === 'function') {
          await onTopupApplied(responsePayload).catch(() => {});
        }

        sendJson(res, forwarded.status, responsePayload);
        return;
      }

      if (!legacyTopup?.handleMercadoPagoWebhook) {
        sendJson(res, 503, { ok: false, error_code: 'billing_unavailable' });
        return;
      }

      const legacyResponse = await legacyTopup.handleMercadoPagoWebhook({
        payload,
        queryParams: url.searchParams,
      });

      const status = Number(legacyResponse?.status) || 200;
      const responsePayload = legacyResponse?.payload || { ok: false, error_code: 'legacy_webhook_failed' };
      const event = legacyResponse?.event || null;
      if (responsePayload?.ok && !responsePayload?.alreadyProcessed && event && typeof onTopupApplied === 'function') {
        await onTopupApplied(event).catch(() => {});
      }

      sendJson(res, status, responsePayload);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/webhooks/credits') {
      const payload = await readJsonBody(req);

      if (externalBillingEnabled) {
        const addResult = await billingClient.addCredits({
          userId: payload?.telegram_user_id || payload?.user_id,
          amount: payload?.credits,
          reason: payload?.reason || 'webhook_topup',
          metadata: payload?.metadata || null,
        });
        sendJson(res, addResult.ok ? 200 : 400, addResult);
        return;
      }

      if (!legacyTopup?.addCredits) {
        sendJson(res, 503, { ok: false, error_code: 'billing_unavailable' });
        return;
      }

      const addResult = await legacyTopup.addCredits({
        userId: payload?.telegram_user_id || payload?.user_id,
        credits: payload?.credits,
        reason: payload?.reason || 'webhook_topup',
        metadata: payload?.metadata || null,
      });
      if (addResult?.ok && typeof onTopupApplied === 'function') {
        await onTopupApplied({
          user_id: payload?.telegram_user_id || payload?.user_id,
          credits: Number(payload?.credits) || 0,
          payment_id: payload?.payment_id || payload?.paymentId || null,
        }).catch(() => {});
      }
      sendJson(res, addResult?.ok ? 200 : 400, addResult || { ok: false, error_code: 'legacy_credit_failed' });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/webhooks/billing-events') {
      if (!hasExpectedBillingToken(req)) {
        sendJson(res, 403, { ok: false, error_code: 'forbidden' });
        return;
      }

      const payload = await readJsonBody(req);
      if (!payload || String(payload.type || '').trim() !== 'topup_credited') {
        sendJson(res, 200, { ok: true, ignored: true, reason: 'unsupported_event' });
        return;
      }

      if (typeof onTopupApplied === 'function') {
        await onTopupApplied(payload).catch((error) => {
          console.error('[health] billing event callback failed:', error);
        });
      }

      sendJson(res, 200, { ok: true, processed: true });
      return;
    }

    sendJson(res, 404, { ok: false, error_code: 'not_found' });
  });

  server.listen(port, () => {
    console.log(`[health] ${appName} listening on ${port}`);
  });

  return server;
}
