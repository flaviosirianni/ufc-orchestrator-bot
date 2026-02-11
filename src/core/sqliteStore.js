import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import '../core/env.js';

const DB_PATH =
  process.env.DB_PATH || path.resolve(process.cwd(), 'data', 'bot.db');

let dbInstance = null;

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      telegram_user_id TEXT PRIMARY KEY,
      username TEXT,
      first_name TEXT,
      last_name TEXT,
      created_at TEXT,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS chats (
      chat_id TEXT PRIMARY KEY,
      type TEXT,
      title TEXT,
      created_at TEXT,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      chat_id TEXT,
      telegram_user_id TEXT,
      started_at TEXT,
      last_activity_at TEXT,
      message_count INTEGER DEFAULT 0,
      last_event_json TEXT,
      last_card_json TEXT,
      last_resolved_fight_json TEXT
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      role TEXT,
      content TEXT,
      created_at TEXT
    );

    CREATE TABLE IF NOT EXISTS user_profiles (
      telegram_user_id TEXT PRIMARY KEY,
      bankroll REAL,
      unit_size REAL,
      risk_profile TEXT,
      currency TEXT,
      notes TEXT,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS bets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_user_id TEXT,
      event_name TEXT,
      fight TEXT,
      pick TEXT,
      odds REAL,
      stake REAL,
      units REAL,
      result TEXT,
      notes TEXT,
      created_at TEXT
    );

    CREATE TABLE IF NOT EXISTS ledger_summary (
      telegram_user_id TEXT PRIMARY KEY,
      total_staked REAL DEFAULT 0,
      total_units REAL DEFAULT 0,
      total_bets INTEGER DEFAULT 0,
      wins INTEGER DEFAULT 0,
      losses INTEGER DEFAULT 0,
      pushes INTEGER DEFAULT 0,
      last_updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS odds_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_user_id TEXT,
      event_id TEXT,
      event_name TEXT,
      event_date_utc TEXT,
      fight_id TEXT,
      division TEXT,
      scheduled_rounds INTEGER,
      fighter_red TEXT,
      fighter_blue TEXT,
      sportsbook TEXT,
      odds_hash TEXT,
      odds_json TEXT,
      source TEXT,
      currency TEXT,
      odds_format TEXT,
      scraped_at_utc TEXT,
      created_at TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS uniq_odds_user_hash
      ON odds_snapshots (telegram_user_id, odds_hash);
    CREATE INDEX IF NOT EXISTS idx_odds_user_fight
      ON odds_snapshots (telegram_user_id, fight_id);

    CREATE TABLE IF NOT EXISTS usage_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_user_id TEXT,
      session_id TEXT,
      model TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      total_tokens INTEGER,
      reasoning_tokens INTEGER,
      cached_tokens INTEGER,
      used_web_search INTEGER DEFAULT 0,
      input_images INTEGER DEFAULT 0,
      audio_seconds REAL,
      raw_usage_json TEXT,
      created_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_usage_user_time
      ON usage_records (telegram_user_id, created_at);

    CREATE TABLE IF NOT EXISTS user_credits (
      telegram_user_id TEXT PRIMARY KEY,
      paid_credits REAL DEFAULT 0,
      free_credits REAL DEFAULT 0,
      week_id TEXT,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS credit_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_user_id TEXT,
      amount REAL,
      type TEXT,
      reason TEXT,
      metadata TEXT,
      created_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_credit_tx_user_time
      ON credit_transactions (telegram_user_id, created_at);

    CREATE TABLE IF NOT EXISTS mp_processed_payments (
      payment_id TEXT PRIMARY KEY,
      telegram_user_id TEXT,
      credits REAL,
      amount REAL,
      status TEXT,
      raw_payload TEXT,
      created_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_mp_processed_user_time
      ON mp_processed_payments (telegram_user_id, created_at);
  `);
}

export function getDb() {
  if (dbInstance) {
    return dbInstance;
  }

  ensureDir(DB_PATH);
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initSchema(db);
  dbInstance = db;
  return dbInstance;
}

function nowIso() {
  return new Date().toISOString();
}

function toNumberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function hashOddsPayload(payload) {
  const json = JSON.stringify(payload);
  return crypto.createHash('sha256').update(json).digest('hex');
}

function getIsoWeekId(date = new Date()) {
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNumber = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - dayNumber);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((target - yearStart) / 86400000 + 1) / 7);
  return `${target.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

export function upsertUser({ userId, username, firstName, lastName } = {}) {
  if (!userId) return;
  const db = getDb();
  const existing = db
    .prepare('SELECT telegram_user_id FROM users WHERE telegram_user_id = ?')
    .get(userId);
  const ts = nowIso();
  if (existing) {
    db.prepare(
      `UPDATE users
       SET username = ?, first_name = ?, last_name = ?, updated_at = ?
       WHERE telegram_user_id = ?`
    ).run(username || null, firstName || null, lastName || null, ts, userId);
    return;
  }
  db.prepare(
    `INSERT INTO users (telegram_user_id, username, first_name, last_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(userId, username || null, firstName || null, lastName || null, ts, ts);
}

export function upsertChat({ chatId, type, title } = {}) {
  if (!chatId) return;
  const db = getDb();
  const existing = db.prepare('SELECT chat_id FROM chats WHERE chat_id = ?').get(chatId);
  const ts = nowIso();
  if (existing) {
    db.prepare(
      `UPDATE chats
       SET type = ?, title = ?, updated_at = ?
       WHERE chat_id = ?`
    ).run(type || null, title || null, ts, chatId);
    return;
  }
  db.prepare(
    `INSERT INTO chats (chat_id, type, title, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(chatId, type || null, title || null, ts, ts);
}

export function upsertSession({
  sessionId,
  chatId,
  userId,
  messageCount = 0,
  lastEvent = null,
  lastCard = null,
  lastResolvedFight = null,
} = {}) {
  if (!sessionId) return;
  const db = getDb();
  const existing = db
    .prepare('SELECT session_id, started_at FROM sessions WHERE session_id = ?')
    .get(sessionId);
  const ts = nowIso();
  if (existing) {
    db.prepare(
      `UPDATE sessions
       SET last_activity_at = ?,
           message_count = ?,
           last_event_json = ?,
           last_card_json = ?,
           last_resolved_fight_json = ?
       WHERE session_id = ?`
    ).run(
      ts,
      messageCount,
      lastEvent ? JSON.stringify(lastEvent) : null,
      lastCard ? JSON.stringify(lastCard) : null,
      lastResolvedFight ? JSON.stringify(lastResolvedFight) : null,
      sessionId
    );
    return;
  }
  db.prepare(
    `INSERT INTO sessions
      (session_id, chat_id, telegram_user_id, started_at, last_activity_at, message_count, last_event_json, last_card_json, last_resolved_fight_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    sessionId,
    chatId || null,
    userId || null,
    ts,
    ts,
    messageCount,
    lastEvent ? JSON.stringify(lastEvent) : null,
    lastCard ? JSON.stringify(lastCard) : null,
    lastResolvedFight ? JSON.stringify(lastResolvedFight) : null
  );
}

export function appendMessage({ sessionId, role, content } = {}) {
  if (!sessionId || !content) return;
  const db = getDb();
  db.prepare(
    `INSERT INTO messages (session_id, role, content, created_at)
     VALUES (?, ?, ?, ?)`
  ).run(sessionId, role || 'user', content, nowIso());
}

export function getUserProfile(userId) {
  if (!userId) {
    return {
      bankroll: null,
      unitSize: null,
      riskProfile: null,
      currency: null,
      notes: '',
    };
  }
  const db = getDb();
  const row = db
    .prepare(
      'SELECT bankroll, unit_size, risk_profile, currency, notes FROM user_profiles WHERE telegram_user_id = ?'
    )
    .get(userId);
  return {
    bankroll: row?.bankroll ?? null,
    unitSize: row?.unit_size ?? null,
    riskProfile: row?.risk_profile ?? null,
    currency: row?.currency ?? null,
    notes: row?.notes ?? '',
  };
}

export function updateUserProfile(userId, updates = {}) {
  if (!userId) return null;
  const db = getDb();
  const current = getUserProfile(userId);
  const next = {
    bankroll: updates.bankroll ?? current.bankroll,
    unitSize: updates.unitSize ?? current.unitSize,
    riskProfile: updates.riskProfile ?? current.riskProfile,
    currency: updates.currency ?? current.currency,
    notes: updates.notes ?? current.notes,
  };

  db.prepare(
    `INSERT INTO user_profiles (telegram_user_id, bankroll, unit_size, risk_profile, currency, notes, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(telegram_user_id) DO UPDATE SET
       bankroll = excluded.bankroll,
       unit_size = excluded.unit_size,
       risk_profile = excluded.risk_profile,
       currency = excluded.currency,
       notes = excluded.notes,
       updated_at = excluded.updated_at`
  ).run(
    userId,
    next.bankroll,
    next.unitSize,
    next.riskProfile,
    next.currency,
    next.notes,
    nowIso()
  );

  return next;
}

function normalizeResult(result = '') {
  const value = String(result || '').toLowerCase();
  if (value.includes('win') || value.includes('won')) return 'win';
  if (value.includes('loss') || value.includes('lose')) return 'loss';
  if (value.includes('push') || value.includes('draw')) return 'push';
  return null;
}

export function addBetRecord(userId, record = {}) {
  if (!userId) return null;
  const db = getDb();
  const ts = nowIso();
  db.prepare(
    `INSERT INTO bets
      (telegram_user_id, event_name, fight, pick, odds, stake, units, result, notes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    userId,
    record.eventName || null,
    record.fight || null,
    record.pick || null,
    record.odds ?? null,
    record.stake ?? null,
    record.units ?? null,
    record.result || null,
    record.notes || null,
    ts
  );

  const normalizedResult = normalizeResult(record.result);
  const existing = db
    .prepare('SELECT * FROM ledger_summary WHERE telegram_user_id = ?')
    .get(userId);

  const totalStaked = (existing?.total_staked || 0) + (Number(record.stake) || 0);
  const totalUnits = (existing?.total_units || 0) + (Number(record.units) || 0);
  const totalBets = (existing?.total_bets || 0) + 1;
  const wins = (existing?.wins || 0) + (normalizedResult === 'win' ? 1 : 0);
  const losses = (existing?.losses || 0) + (normalizedResult === 'loss' ? 1 : 0);
  const pushes = (existing?.pushes || 0) + (normalizedResult === 'push' ? 1 : 0);

  db.prepare(
    `INSERT INTO ledger_summary
      (telegram_user_id, total_staked, total_units, total_bets, wins, losses, pushes, last_updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(telegram_user_id) DO UPDATE SET
       total_staked = excluded.total_staked,
       total_units = excluded.total_units,
       total_bets = excluded.total_bets,
       wins = excluded.wins,
       losses = excluded.losses,
       pushes = excluded.pushes,
       last_updated_at = excluded.last_updated_at`
  ).run(userId, totalStaked, totalUnits, totalBets, wins, losses, pushes, ts);

  return {
    ...record,
    recordedAt: ts,
  };
}

export function getBetHistory(userId, limit = 20) {
  if (!userId) return [];
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT event_name, fight, pick, odds, stake, units, result, notes, created_at
       FROM bets WHERE telegram_user_id = ?
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(userId, limit);

  return rows.map((row) => ({
    eventName: row.event_name,
    fight: row.fight,
    pick: row.pick,
    odds: row.odds,
    stake: row.stake,
    units: row.units,
    result: row.result,
    notes: row.notes,
    recordedAt: row.created_at,
  }));
}

export function getLedgerSummary(userId) {
  if (!userId) return null;
  const db = getDb();
  const row = db
    .prepare(
      `SELECT total_staked, total_units, total_bets, wins, losses, pushes, last_updated_at
       FROM ledger_summary WHERE telegram_user_id = ?`
    )
    .get(userId);
  if (!row) return null;
  return {
    totalStaked: row.total_staked,
    totalUnits: row.total_units,
    totalBets: row.total_bets,
    wins: row.wins,
    losses: row.losses,
    pushes: row.pushes,
    lastUpdatedAt: row.last_updated_at,
  };
}

export function addOddsSnapshot(userId, payload = {}) {
  if (!userId) return { ok: false, error: 'userId no disponible.' };
  if (!payload || typeof payload !== 'object') {
    return { ok: false, error: 'payload invalido.' };
  }

  const event = payload.event || {};
  const fight = payload.fight || {};
  const meta = payload.meta || {};
  const sportsbook = payload.sportsbook || event.sportsbook || null;
  const oddsHash = hashOddsPayload(payload);
  const ts = nowIso();

  const db = getDb();
  const result = db.prepare(
    `INSERT OR IGNORE INTO odds_snapshots
      (telegram_user_id, event_id, event_name, event_date_utc, fight_id, division, scheduled_rounds,
       fighter_red, fighter_blue, sportsbook, odds_hash, odds_json, source, currency, odds_format,
       scraped_at_utc, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    userId,
    event.event_id || null,
    event.name || null,
    event.date_utc || null,
    fight.fight_id || null,
    fight.division || null,
    toNumberOrNull(fight.scheduled_rounds),
    fight.fighter_red || null,
    fight.fighter_blue || null,
    sportsbook,
    oddsHash,
    JSON.stringify(payload),
    meta.source || null,
    meta.currency || null,
    meta.odds_format || null,
    meta.scraped_at_utc || null,
    ts
  );

  return {
    ok: true,
    stored: result.changes > 0,
    oddsHash,
  };
}

export function addUsageRecord({
  userId,
  sessionId,
  model,
  usage,
  usedWebSearch = false,
  inputImages = 0,
  audioSeconds = null,
} = {}) {
  if (!userId) return { ok: false, error: 'userId no disponible.' };
  if (!usage || typeof usage !== 'object') {
    return { ok: false, error: 'usage invalido.' };
  }

  const totals = usage.totals || usage;
  const inputTokens = toNumberOrNull(
    totals.input_tokens ?? totals.prompt_tokens ?? totals.inputTokens
  );
  const outputTokens = toNumberOrNull(
    totals.output_tokens ?? totals.completion_tokens ?? totals.outputTokens
  );
  const totalTokens = toNumberOrNull(
    totals.total_tokens ?? totals.totalTokens ??
      (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null)
  );
  const reasoningTokens = toNumberOrNull(
    totals.reasoning_tokens ??
      totals.output_tokens_details?.reasoning_tokens ??
      totals.reasoningTokens
  );
  const cachedTokens = toNumberOrNull(
    totals.cached_tokens ??
      totals.input_tokens_details?.cached_tokens ??
      totals.cachedTokens
  );

  const db = getDb();
  db.prepare(
    `INSERT INTO usage_records
      (telegram_user_id, session_id, model, input_tokens, output_tokens, total_tokens,
       reasoning_tokens, cached_tokens, used_web_search, input_images, audio_seconds,
       raw_usage_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    userId,
    sessionId || null,
    model || null,
    inputTokens,
    outputTokens,
    totalTokens,
    reasoningTokens,
    cachedTokens,
    usedWebSearch ? 1 : 0,
    Number(inputImages) || 0,
    toNumberOrNull(audioSeconds),
    JSON.stringify(usage),
    nowIso()
  );

  return { ok: true };
}

export function getCreditState(userId, weeklyFreeCredits = 5) {
  if (!userId) return null;
  const db = getDb();
  const weekId = getIsoWeekId();
  const existing = db
    .prepare('SELECT * FROM user_credits WHERE telegram_user_id = ?')
    .get(userId);

  const ts = nowIso();

  if (!existing) {
    db.prepare(
      `INSERT INTO user_credits (telegram_user_id, paid_credits, free_credits, week_id, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(userId, 0, weeklyFreeCredits, weekId, ts);

    db.prepare(
      `INSERT INTO credit_transactions
        (telegram_user_id, amount, type, reason, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      userId,
      weeklyFreeCredits,
      'grant_free',
      'weekly_grant',
      JSON.stringify({ weekId }),
      ts
    );

    return {
      paidCredits: 0,
      freeCredits: weeklyFreeCredits,
      weekId,
      availableCredits: weeklyFreeCredits,
    };
  }

  if (existing.week_id !== weekId) {
    db.prepare(
      `UPDATE user_credits
       SET free_credits = ?, week_id = ?, updated_at = ?
       WHERE telegram_user_id = ?`
    ).run(weeklyFreeCredits, weekId, ts, userId);

    db.prepare(
      `INSERT INTO credit_transactions
        (telegram_user_id, amount, type, reason, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      userId,
      weeklyFreeCredits,
      'grant_free',
      'weekly_grant',
      JSON.stringify({ weekId }),
      ts
    );

    return {
      paidCredits: existing.paid_credits || 0,
      freeCredits: weeklyFreeCredits,
      weekId,
      availableCredits: (existing.paid_credits || 0) + weeklyFreeCredits,
    };
  }

  const paidCredits = existing.paid_credits || 0;
  const freeCredits = existing.free_credits || 0;
  return {
    paidCredits,
    freeCredits,
    weekId,
    availableCredits: paidCredits + freeCredits,
  };
}

export function spendCredits(userId, amount, { reason = 'usage', metadata = null } = {}) {
  if (!userId || !amount || amount <= 0) return { ok: false };
  const db = getDb();
  const state = getCreditState(userId, 0);
  if (!state) return { ok: false };

  let remaining = amount;
  let freeUsed = 0;
  let paidUsed = 0;

  if (state.freeCredits > 0) {
    freeUsed = Math.min(state.freeCredits, remaining);
    remaining -= freeUsed;
  }

  if (remaining > 0 && state.paidCredits > 0) {
    paidUsed = Math.min(state.paidCredits, remaining);
    remaining -= paidUsed;
  }

  if (remaining > 0) {
    return { ok: false, error: 'insufficient_credits' };
  }

  const newFree = (state.freeCredits || 0) - freeUsed;
  const newPaid = (state.paidCredits || 0) - paidUsed;
  const ts = nowIso();

  db.prepare(
    `UPDATE user_credits
     SET free_credits = ?, paid_credits = ?, updated_at = ?
     WHERE telegram_user_id = ?`
  ).run(newFree, newPaid, ts, userId);

  db.prepare(
    `INSERT INTO credit_transactions
      (telegram_user_id, amount, type, reason, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    userId,
    -amount,
    'spend',
    reason,
    metadata ? JSON.stringify(metadata) : null,
    ts
  );

  return {
    ok: true,
    freeUsed,
    paidUsed,
    remainingCredits: newFree + newPaid,
  };
}

export function addCredits(userId, amount, { reason = 'purchase', metadata = null } = {}) {
  if (!userId || !amount || amount <= 0) return { ok: false };
  const db = getDb();
  const state = getCreditState(userId, 0);
  const ts = nowIso();
  const newPaid = (state?.paidCredits || 0) + amount;

  db.prepare(
    `INSERT INTO user_credits (telegram_user_id, paid_credits, free_credits, week_id, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(telegram_user_id) DO UPDATE SET
       paid_credits = excluded.paid_credits,
       updated_at = excluded.updated_at`
  ).run(userId, newPaid, state?.freeCredits || 0, state?.weekId || getIsoWeekId(), ts);

  db.prepare(
    `INSERT INTO credit_transactions
      (telegram_user_id, amount, type, reason, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    userId,
    amount,
    'credit',
    reason,
    metadata ? JSON.stringify(metadata) : null,
    ts
  );

  return { ok: true, paidCredits: newPaid };
}

export function creditFromMercadoPagoPayment({
  paymentId,
  userId,
  credits,
  amount = null,
  status = 'approved',
  rawPayload = null,
} = {}) {
  const cleanPaymentId = String(paymentId || '').trim();
  const cleanUserId = String(userId || '').trim();
  const creditsAmount = Number(credits);
  const paymentAmount = toNumberOrNull(amount);

  if (!cleanPaymentId || !cleanUserId || !Number.isFinite(creditsAmount) || creditsAmount <= 0) {
    return { ok: false, error: 'invalid_mp_credit_input' };
  }

  const db = getDb();
  const ts = nowIso();

  const applyCredit = db.transaction(() => {
    const existing = db
      .prepare('SELECT payment_id FROM mp_processed_payments WHERE payment_id = ?')
      .get(cleanPaymentId);
    if (existing) {
      return { ok: true, alreadyProcessed: true };
    }

    const creditResult = addCredits(cleanUserId, creditsAmount, {
      reason: 'mercadopago_payment',
      metadata: {
        source: 'mercadopago',
        payment_id: cleanPaymentId,
        amount: paymentAmount,
        status: status || null,
      },
    });

    if (!creditResult.ok) {
      return { ok: false, error: 'credit_failed' };
    }

    db.prepare(
      `INSERT INTO mp_processed_payments
        (payment_id, telegram_user_id, credits, amount, status, raw_payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      cleanPaymentId,
      cleanUserId,
      creditsAmount,
      paymentAmount,
      status || null,
      rawPayload ? JSON.stringify(rawPayload) : null,
      ts
    );

    return {
      ok: true,
      alreadyProcessed: false,
      paidCredits: creditResult.paidCredits,
    };
  });

  return applyCredit();
}

export function getUsageCounters({
  userId,
  dayIso,
  weekStartIso,
  weekEndIso,
} = {}) {
  if (!userId) return { imagesToday: 0, audioSecondsWeek: 0 };
  const db = getDb();
  const imagesRow = db
    .prepare(
      `SELECT SUM(input_images) AS total
       FROM usage_records
       WHERE telegram_user_id = ?
         AND date(created_at) = ?`
    )
    .get(userId, dayIso);

  const audioRow = db
    .prepare(
      `SELECT SUM(audio_seconds) AS total
       FROM usage_records
       WHERE telegram_user_id = ?
         AND created_at >= ?
         AND created_at < ?`
    )
    .get(userId, weekStartIso, weekEndIso);

  return {
    imagesToday: Number(imagesRow?.total) || 0,
    audioSecondsWeek: Number(audioRow?.total) || 0,
  };
}

function normalizeName(value = '') {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function parseOddsRow(row) {
  if (!row) return null;
  let payload = null;
  try {
    payload = row.odds_json ? JSON.parse(row.odds_json) : null;
  } catch {
    payload = null;
  }

  return {
    id: row.id,
    oddsHash: row.odds_hash,
    createdAt: row.created_at,
    event: {
      event_id: row.event_id,
      name: row.event_name,
      date_utc: row.event_date_utc,
      sportsbook: row.sportsbook,
    },
    fight: {
      fight_id: row.fight_id,
      division: row.division,
      scheduled_rounds: row.scheduled_rounds,
      fighter_red: row.fighter_red,
      fighter_blue: row.fighter_blue,
    },
    odds: payload?.odds || payload || null,
    meta: payload?.meta || {
      source: row.source,
      currency: row.currency,
      odds_format: row.odds_format,
      scraped_at_utc: row.scraped_at_utc,
    },
    raw: payload,
  };
}

export function getLatestOddsSnapshot(userId, query = {}) {
  if (!userId) return null;
  const db = getDb();

  if (query.fightId) {
    const row = db
      .prepare(
        `SELECT * FROM odds_snapshots
         WHERE telegram_user_id = ? AND fight_id = ?
         ORDER BY created_at DESC
         LIMIT 1`
      )
      .get(userId, query.fightId);
    return parseOddsRow(row);
  }

  const fighterA = normalizeName(query.fighterA || query.fighterRed || '');
  const fighterB = normalizeName(query.fighterB || query.fighterBlue || '');

  if (fighterA && fighterB) {
    const row = db
      .prepare(
        `SELECT * FROM odds_snapshots
         WHERE telegram_user_id = ?
           AND (
             (lower(fighter_red) = ? AND lower(fighter_blue) = ?)
             OR (lower(fighter_red) = ? AND lower(fighter_blue) = ?)
           )
         ORDER BY created_at DESC
         LIMIT 1`
      )
      .get(userId, fighterA, fighterB, fighterB, fighterA);
    if (row) {
      return parseOddsRow(row);
    }
  }

  if (query.eventName || query.eventDate) {
    const eventName = query.eventName ? `%${query.eventName}%` : null;
    const eventDate = query.eventDate || null;
    const row = db
      .prepare(
        `SELECT * FROM odds_snapshots
         WHERE telegram_user_id = ?
           AND (? IS NULL OR event_name LIKE ?)
           AND (? IS NULL OR event_date_utc = ?)
         ORDER BY created_at DESC
         LIMIT 1`
      )
      .get(userId, eventName, eventName, eventDate, eventDate);
    return parseOddsRow(row);
  }

  return null;
}

export function getDbPath() {
  return DB_PATH;
}
