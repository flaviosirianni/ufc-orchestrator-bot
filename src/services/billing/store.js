import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const OCI_DEFAULT_DB_PATH = '/home/ubuntu/bot-data/billing/billing.db';
const LOCAL_DEFAULT_DB_PATH = path.resolve(os.homedir(), '.bot-factory', 'billing.db');
const DEFAULT_DB_PATH =
  process.env.NODE_ENV === 'production' ? OCI_DEFAULT_DB_PATH : LOCAL_DEFAULT_DB_PATH;

function nowIso() {
  return new Date().toISOString();
}

function getIsoWeekId(date = new Date()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function parseJsonOrNull(raw = '') {
  const value = String(raw || '').trim();
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS wallets (
      telegram_user_id TEXT PRIMARY KEY,
      paid_credits REAL DEFAULT 0,
      free_credits REAL DEFAULT 0,
      week_id TEXT,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS credit_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_user_id TEXT NOT NULL,
      bot_id TEXT,
      amount REAL NOT NULL,
      type TEXT NOT NULL,
      reason TEXT,
      metadata TEXT,
      idempotency_key TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_credit_tx_user_time
      ON credit_transactions (telegram_user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS processed_payments (
      payment_id TEXT PRIMARY KEY,
      telegram_user_id TEXT NOT NULL,
      bot_id TEXT,
      credits REAL NOT NULL,
      amount REAL,
      status TEXT,
      raw_payload TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      idempotency_key TEXT NOT NULL UNIQUE,
      telegram_user_id TEXT NOT NULL,
      bot_id TEXT,
      amount REAL NOT NULL,
      reason TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_usage_user_time
      ON usage_events (telegram_user_id, created_at DESC);
  `);
}

export function createBillingStore({ dbPath = process.env.BILLING_DB_PATH || DEFAULT_DB_PATH } = {}) {
  ensureDir(dbPath);
  const db = new Database(dbPath);
  initSchema(db);

  function ensureWallet(userId, { weeklyFreeCredits = 0 } = {}) {
    const cleanUserId = String(userId || '').trim();
    if (!cleanUserId) return null;

    const row = db
      .prepare('SELECT telegram_user_id, paid_credits, free_credits, week_id FROM wallets WHERE telegram_user_id = ?')
      .get(cleanUserId);
    const weekId = getIsoWeekId();
    const ts = nowIso();
    const freeAmount = Math.max(0, Number(weeklyFreeCredits) || 0);

    if (!row) {
      db.prepare(
        `INSERT INTO wallets (telegram_user_id, paid_credits, free_credits, week_id, updated_at)
         VALUES (?, ?, ?, ?, ?)`
      ).run(cleanUserId, 0, freeAmount, weekId, ts);

      if (freeAmount > 0) {
        db.prepare(
          `INSERT INTO credit_transactions
            (telegram_user_id, bot_id, amount, type, reason, metadata, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(
          cleanUserId,
          null,
          freeAmount,
          'grant_free',
          'weekly_grant',
          JSON.stringify({ weekId }),
          ts
        );
      }

      return {
        telegram_user_id: cleanUserId,
        paid_credits: 0,
        free_credits: freeAmount,
        week_id: weekId,
      };
    }

    if (String(row.week_id || '') !== weekId) {
      db.prepare(
        `UPDATE wallets
         SET free_credits = ?, week_id = ?, updated_at = ?
         WHERE telegram_user_id = ?`
      ).run(freeAmount, weekId, ts, cleanUserId);

      if (freeAmount > 0) {
        db.prepare(
          `INSERT INTO credit_transactions
            (telegram_user_id, bot_id, amount, type, reason, metadata, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(
          cleanUserId,
          null,
          freeAmount,
          'grant_free',
          'weekly_grant',
          JSON.stringify({ weekId }),
          ts
        );
      }

      return {
        ...row,
        free_credits: freeAmount,
        week_id: weekId,
      };
    }

    return row;
  }

  function getState(userId, { weeklyFreeCredits = 0 } = {}) {
    const wallet = ensureWallet(userId, { weeklyFreeCredits });
    if (!wallet) return null;
    const paidCredits = Number(wallet.paid_credits) || 0;
    const freeCredits = Number(wallet.free_credits) || 0;
    return {
      paid_credits: paidCredits,
      free_credits: freeCredits,
      week_id: wallet.week_id || null,
      available_credits: paidCredits + freeCredits,
    };
  }

  function listTransactions(userId, { limit = 8 } = {}) {
    const cleanUserId = String(userId || '').trim();
    if (!cleanUserId) return [];
    const max = Math.max(1, Math.min(80, Number(limit) || 8));
    const rows = db
      .prepare(
        `SELECT id, telegram_user_id, bot_id, amount, type, reason, metadata, idempotency_key, created_at
         FROM credit_transactions
         WHERE telegram_user_id = ?
         ORDER BY created_at DESC, id DESC
         LIMIT ?`
      )
      .all(cleanUserId, max);

    return rows.map((row) => ({
      id: row.id,
      user_id: row.telegram_user_id,
      bot_id: row.bot_id || null,
      amount: Number(row.amount) || 0,
      type: row.type || null,
      reason: row.reason || null,
      metadata: parseJsonOrNull(row.metadata),
      idempotency_key: row.idempotency_key || null,
      created_at: row.created_at || null,
    }));
  }

  function listUsageCounters(userId) {
    const cleanUserId = String(userId || '').trim();
    if (!cleanUserId) {
      return { images_today: 0, audio_seconds_week: 0 };
    }

    const dayIso = new Date().toISOString().slice(0, 10);
    const weekStart = new Date();
    const day = weekStart.getUTCDay() || 7;
    weekStart.setUTCDate(weekStart.getUTCDate() - day + 1);
    weekStart.setUTCHours(0, 0, 0, 0);
    const weekEnd = new Date(weekStart);
    weekEnd.setUTCDate(weekEnd.getUTCDate() + 7);

    const rows = db
      .prepare(
        `SELECT metadata, created_at
         FROM usage_events
         WHERE telegram_user_id = ?
           AND created_at >= ?
           AND created_at < ?`
      )
      .all(cleanUserId, weekStart.toISOString(), weekEnd.toISOString());

    let imagesToday = 0;
    let audioSecondsWeek = 0;

    for (const row of rows) {
      const metadata = parseJsonOrNull(row.metadata) || {};
      const createdAt = String(row.created_at || '').slice(0, 10);
      const newImages = Number(metadata?.costBreakdown?.newImages ?? metadata?.newImages) || 0;
      const newAudioSeconds =
        Number(metadata?.costBreakdown?.newAudioSeconds ?? metadata?.newAudioSeconds) || 0;
      audioSecondsWeek += newAudioSeconds;
      if (createdAt === dayIso) {
        imagesToday += newImages;
      }
    }

    return {
      images_today: imagesToday,
      audio_seconds_week: audioSecondsWeek,
    };
  }

  function addCredits({
    userId,
    botId = null,
    amount,
    reason = 'purchase',
    metadata = null,
    weeklyFreeCredits = 0,
  } = {}) {
    const cleanUserId = String(userId || '').trim();
    const numericAmount = Number(amount);
    if (!cleanUserId || !Number.isFinite(numericAmount) || numericAmount <= 0) {
      return { ok: false, error_code: 'invalid_add_credits_input' };
    }

    const apply = db.transaction(() => {
      const wallet = ensureWallet(cleanUserId, { weeklyFreeCredits });
      const nextPaid = (Number(wallet?.paid_credits) || 0) + numericAmount;
      const ts = nowIso();

      db.prepare(
        `UPDATE wallets
         SET paid_credits = ?, updated_at = ?
         WHERE telegram_user_id = ?`
      ).run(nextPaid, ts, cleanUserId);

      db.prepare(
        `INSERT INTO credit_transactions
          (telegram_user_id, bot_id, amount, type, reason, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        cleanUserId,
        botId,
        numericAmount,
        'credit',
        reason,
        metadata ? JSON.stringify(metadata) : null,
        ts
      );

      return {
        ok: true,
        state: getState(cleanUserId, { weeklyFreeCredits }),
      };
    });

    return apply();
  }

  function spendCredits({
    userId,
    botId = null,
    amount,
    reason = 'usage',
    metadata = null,
    idempotencyKey,
    weeklyFreeCredits = 0,
  } = {}) {
    const cleanUserId = String(userId || '').trim();
    const numericAmount = Number(amount);
    const cleanIdempotency = String(idempotencyKey || '').trim();

    if (!cleanUserId || !cleanIdempotency || !Number.isFinite(numericAmount) || numericAmount <= 0) {
      return { ok: false, error_code: 'invalid_spend_input' };
    }

    const apply = db.transaction(() => {
      const existingUsage = db
        .prepare(
          'SELECT id, telegram_user_id, bot_id, amount, reason, metadata, created_at FROM usage_events WHERE idempotency_key = ?'
        )
        .get(cleanIdempotency);

      if (existingUsage) {
        return {
          ok: true,
          idempotency_status: 'replayed',
          state: getState(cleanUserId, { weeklyFreeCredits }),
        };
      }

      const state = getState(cleanUserId, { weeklyFreeCredits });
      if (!state) {
        return { ok: false, error_code: 'user_not_initialized' };
      }

      let remaining = numericAmount;
      const freeUsed = Math.min(state.free_credits || 0, remaining);
      remaining -= freeUsed;
      const paidUsed = Math.min(state.paid_credits || 0, remaining);
      remaining -= paidUsed;

      if (remaining > 0) {
        return {
          ok: false,
          error_code: 'insufficient_credits',
          state,
        };
      }

      const nextFree = (state.free_credits || 0) - freeUsed;
      const nextPaid = (state.paid_credits || 0) - paidUsed;
      const ts = nowIso();

      db.prepare(
        `UPDATE wallets
         SET free_credits = ?, paid_credits = ?, updated_at = ?
         WHERE telegram_user_id = ?`
      ).run(nextFree, nextPaid, ts, cleanUserId);

      db.prepare(
        `INSERT INTO usage_events
          (idempotency_key, telegram_user_id, bot_id, amount, reason, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        cleanIdempotency,
        cleanUserId,
        botId,
        numericAmount,
        reason,
        metadata ? JSON.stringify(metadata) : null,
        ts
      );

      db.prepare(
        `INSERT INTO credit_transactions
          (telegram_user_id, bot_id, amount, type, reason, metadata, idempotency_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        cleanUserId,
        botId,
        -numericAmount,
        'spend',
        reason,
        metadata ? JSON.stringify(metadata) : null,
        cleanIdempotency,
        ts
      );

      return {
        ok: true,
        idempotency_status: 'new',
        state: getState(cleanUserId, { weeklyFreeCredits }),
      };
    });

    return apply();
  }

  function creditFromPayment({
    paymentId,
    userId,
    botId = null,
    credits,
    amount = null,
    status = 'approved',
    rawPayload = null,
    weeklyFreeCredits = 0,
  } = {}) {
    const cleanPaymentId = String(paymentId || '').trim();
    const cleanUserId = String(userId || '').trim();
    const creditsAmount = Number(credits);
    const paymentAmount = Number.isFinite(Number(amount)) ? Number(amount) : null;

    if (!cleanPaymentId || !cleanUserId || !Number.isFinite(creditsAmount) || creditsAmount <= 0) {
      return { ok: false, error_code: 'invalid_payment_credit_input' };
    }

    const apply = db.transaction(() => {
      const existing = db
        .prepare('SELECT payment_id FROM processed_payments WHERE payment_id = ?')
        .get(cleanPaymentId);
      if (existing) {
        return {
          ok: true,
          alreadyProcessed: true,
          state: getState(cleanUserId, { weeklyFreeCredits }),
        };
      }

      const credited = addCredits({
        userId: cleanUserId,
        botId,
        amount: creditsAmount,
        reason: 'mercadopago_payment',
        metadata: {
          source: 'mercadopago',
          payment_id: cleanPaymentId,
          amount: paymentAmount,
          status,
        },
        weeklyFreeCredits,
      });

      if (!credited.ok) {
        return { ok: false, error_code: 'could_not_credit_payment' };
      }

      db.prepare(
        `INSERT INTO processed_payments
          (payment_id, telegram_user_id, bot_id, credits, amount, status, raw_payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        cleanPaymentId,
        cleanUserId,
        botId,
        creditsAmount,
        paymentAmount,
        status,
        rawPayload ? JSON.stringify(rawPayload) : null,
        nowIso()
      );

      return {
        ok: true,
        alreadyProcessed: false,
        state: getState(cleanUserId, { weeklyFreeCredits }),
      };
    });

    return apply();
  }

  function close() {
    db.close();
  }

  return {
    dbPath,
    getState,
    listTransactions,
    listUsageCounters,
    addCredits,
    spendCredits,
    creditFromPayment,
    close,
  };
}
