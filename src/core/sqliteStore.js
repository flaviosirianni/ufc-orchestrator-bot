import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import '../core/env.js';

const DB_PATH =
  process.env.DB_PATH || path.resolve(os.homedir(), '.ufc-orchestrator-bot', 'bot.db');
const LEDGER_UNDO_WINDOW_MINUTES = Number(process.env.LEDGER_UNDO_WINDOW_MINUTES ?? '30');
const DB_STARTUP_QUICK_CHECK =
  String(process.env.DB_STARTUP_QUICK_CHECK ?? 'true').toLowerCase() !== 'false';
const ODDS_CACHE_SELF_HEAL_ENABLED =
  String(process.env.ODDS_CACHE_SELF_HEAL_ENABLED ?? 'true').toLowerCase() !== 'false';
const SQLITE_BUSY_TIMEOUT_MS = Number(process.env.SQLITE_BUSY_TIMEOUT_MS ?? '5000');
const SQLITE_WAL_AUTOCHECKPOINT_PAGES = Number(
  process.env.SQLITE_WAL_AUTOCHECKPOINT_PAGES ?? '1000'
);

function normalizeSynchronousMode(raw = '') {
  const value = String(raw || 'FULL').trim().toUpperCase();
  if (value === 'OFF' || value === 'NORMAL' || value === 'FULL' || value === 'EXTRA') {
    return value;
  }
  return 'FULL';
}

const SQLITE_SYNCHRONOUS_MODE = normalizeSynchronousMode(process.env.SQLITE_SYNCHRONOUS || 'FULL');

let dbInstance = null;
let oddsCacheRecoveryInFlight = false;

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
      timezone TEXT,
      min_stake_amount REAL,
      min_units_per_bet REAL,
      target_event_utilization_pct REAL,
      notes TEXT,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS event_budget_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_user_id TEXT NOT NULL,
      event_id TEXT,
      event_name TEXT NOT NULL,
      event_norm_key TEXT NOT NULL,
      event_date_utc TEXT,
      currency TEXT,
      budget_amount REAL NOT NULL,
      base_stake_hint REAL,
      notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      closed_at TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS uniq_event_budget_active
      ON event_budget_sessions (telegram_user_id, event_norm_key)
      WHERE closed_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_event_budget_user_updated
      ON event_budget_sessions (telegram_user_id, updated_at DESC);

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
      created_at TEXT,
      updated_at TEXT,
      settled_at TEXT,
      archived_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_bets_user_created
      ON bets (telegram_user_id, created_at);

    CREATE TABLE IF NOT EXISTS bet_mutations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_user_id TEXT,
      bet_id INTEGER,
      action TEXT,
      prev_result TEXT,
      new_result TEXT,
      prev_archived_at TEXT,
      new_archived_at TEXT,
      metadata TEXT,
      created_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_bet_mutations_user_time
      ON bet_mutations (telegram_user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_bet_mutations_bet_time
      ON bet_mutations (bet_id, created_at);

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

    CREATE TABLE IF NOT EXISTS fight_history_cache (
      cache_key TEXT PRIMARY KEY,
      sheet_id TEXT,
      range_name TEXT,
      row_count INTEGER DEFAULT 0,
      hash TEXT,
      rows_json TEXT,
      last_sync_at TEXT,
      last_sync_updated_cache INTEGER DEFAULT 0,
      latest_fight_date TEXT,
      sheet_age_days INTEGER,
      potential_gap INTEGER DEFAULT 0,
      updated_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_fight_history_cache_updated
      ON fight_history_cache (updated_at);

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

    CREATE TABLE IF NOT EXISTS odds_api_cache (
      cache_key TEXT PRIMARY KEY,
      endpoint TEXT NOT NULL,
      params_json TEXT,
      response_json TEXT NOT NULL,
      status_code INTEGER,
      requests_remaining INTEGER,
      requests_used INTEGER,
      requests_last INTEGER,
      fetched_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_odds_api_cache_expires
      ON odds_api_cache (expires_at);

    CREATE TABLE IF NOT EXISTS odds_api_usage_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      endpoint TEXT NOT NULL,
      cache_key TEXT,
      status_code INTEGER,
      requests_remaining INTEGER,
      requests_used INTEGER,
      requests_last INTEGER,
      metadata_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_odds_api_usage_time
      ON odds_api_usage_log (created_at DESC);

    CREATE TABLE IF NOT EXISTS odds_events_index (
      event_id TEXT PRIMARY KEY,
      sport_key TEXT NOT NULL,
      event_name TEXT,
      event_norm_key TEXT,
      commence_time TEXT,
      home_team TEXT,
      away_team TEXT,
      completed INTEGER NOT NULL DEFAULT 0,
      scores_json TEXT,
      last_odds_sync_at TEXT,
      last_scores_sync_at TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_odds_events_sport_time
      ON odds_events_index (sport_key, commence_time);

    CREATE TABLE IF NOT EXISTS odds_market_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      sport_key TEXT NOT NULL,
      event_id TEXT NOT NULL,
      event_name TEXT,
      event_norm_key TEXT,
      commence_time TEXT,
      home_team TEXT,
      away_team TEXT,
      fighter_a_norm TEXT,
      fighter_b_norm TEXT,
      bookmaker_key TEXT,
      bookmaker_title TEXT,
      market_key TEXT NOT NULL,
      outcome_a_name TEXT,
      outcome_a_price REAL,
      outcome_b_name TEXT,
      outcome_b_price REAL,
      draw_price REAL,
      source_last_update TEXT,
      fetched_at TEXT NOT NULL,
      payload_json TEXT,
      dedupe_key TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS uniq_odds_market_dedupe
      ON odds_market_snapshots (dedupe_key);
    CREATE INDEX IF NOT EXISTS idx_odds_market_event_time
      ON odds_market_snapshots (event_id, market_key, fetched_at DESC);
    CREATE INDEX IF NOT EXISTS idx_odds_market_fight_time
      ON odds_market_snapshots (fighter_a_norm, fighter_b_norm, market_key, fetched_at DESC);

    CREATE TABLE IF NOT EXISTS event_watch_state (
      watch_key TEXT PRIMARY KEY,
      event_id TEXT,
      event_name TEXT NOT NULL,
      event_date_utc TEXT,
      event_status TEXT,
      source_primary TEXT,
      source_secondary TEXT,
      main_card_json TEXT NOT NULL,
      monitored_fighters_json TEXT NOT NULL,
      last_reconciled_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS fighter_news_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL,
      fighter_slug TEXT NOT NULL,
      fighter_name_display TEXT NOT NULL,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      source_domain TEXT,
      published_at TEXT,
      fetched_at TEXT NOT NULL,
      summary TEXT,
      impact_level TEXT NOT NULL,
      impact_score REAL NOT NULL,
      confidence_score REAL NOT NULL,
      tags_json TEXT,
      content_hash TEXT NOT NULL,
      dedupe_key TEXT NOT NULL,
      is_relevant INTEGER NOT NULL DEFAULT 1
    );

    CREATE UNIQUE INDEX IF NOT EXISTS uniq_news_dedupe_key
      ON fighter_news_items (dedupe_key);
    CREATE INDEX IF NOT EXISTS idx_news_event_fighter_time
      ON fighter_news_items (event_id, fighter_slug, fetched_at DESC);
    CREATE INDEX IF NOT EXISTS idx_news_impact_time
      ON fighter_news_items (impact_level, fetched_at DESC);

    CREATE TABLE IF NOT EXISTS fight_projection_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL,
      fight_id TEXT NOT NULL,
      fighter_a TEXT NOT NULL,
      fighter_b TEXT NOT NULL,
      predicted_winner TEXT,
      predicted_method TEXT,
      confidence_pct REAL NOT NULL,
      key_factors_json TEXT NOT NULL,
      relevant_news_ids_json TEXT,
      reasoning_version TEXT NOT NULL,
      changed_from_prev INTEGER NOT NULL DEFAULT 0,
      change_summary TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_projection_event_fight_time
      ON fight_projection_snapshots (event_id, fight_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS fight_bet_scoring_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL,
      fight_id TEXT NOT NULL,
      fighter_a TEXT NOT NULL,
      fighter_b TEXT NOT NULL,
      market_key TEXT NOT NULL,
      selection TEXT,
      recommendation TEXT NOT NULL,
      edge_pct REAL NOT NULL,
      confidence_pct REAL NOT NULL,
      risk_level TEXT NOT NULL,
      suggested_stake_units REAL,
      suggested_stake_amount REAL,
      no_bet_reason TEXT,
      model_probability_pct REAL,
      implied_probability_pct REAL,
      consensus_odds REAL,
      books_count INTEGER NOT NULL DEFAULT 0,
      inputs_json TEXT NOT NULL,
      reasoning_version TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_bet_scoring_event_fight_market_time
      ON fight_bet_scoring_snapshots (event_id, fight_id, market_key, created_at DESC);

    CREATE TABLE IF NOT EXISTS user_intel_prefs (
      telegram_user_id TEXT PRIMARY KEY,
      news_alerts_enabled INTEGER NOT NULL DEFAULT 1,
      alert_min_impact TEXT NOT NULL DEFAULT 'high',
      confidence_delta_threshold REAL NOT NULL DEFAULT 8,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS intel_alert_dispatch_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_user_id TEXT NOT NULL,
      alert_type TEXT NOT NULL,
      event_id TEXT NOT NULL,
      fight_id TEXT,
      news_id INTEGER,
      projection_snapshot_id INTEGER,
      dedupe_key TEXT NOT NULL,
      dispatched_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS uniq_alert_dispatch_dedupe
      ON intel_alert_dispatch_log (telegram_user_id, dedupe_key);

    CREATE TABLE IF NOT EXISTS event_fight_mirror (
      watch_key       TEXT NOT NULL,
      event_id        TEXT NOT NULL,
      fight_id        TEXT NOT NULL,
      fighter_a       TEXT NOT NULL,
      fighter_b       TEXT NOT NULL,
      weight_class    TEXT,
      card_position   INTEGER,
      stats_pack_json TEXT,
      built_at        TEXT NOT NULL,
      PRIMARY KEY (watch_key, fight_id)
    );
    CREATE INDEX IF NOT EXISTS idx_event_fight_mirror_watch_key
      ON event_fight_mirror (watch_key, built_at DESC);

    CREATE TABLE IF NOT EXISTS event_fighter_mirror (
      watch_key       TEXT NOT NULL,
      event_id        TEXT NOT NULL,
      fighter_slug    TEXT NOT NULL,
      fighter_name    TEXT NOT NULL,
      stats_pack_json TEXT,
      built_at        TEXT NOT NULL,
      PRIMARY KEY (watch_key, fighter_slug)
    );
    CREATE INDEX IF NOT EXISTS idx_event_fighter_mirror_watch_key
      ON event_fighter_mirror (watch_key, built_at DESC);
  `);
}

function ensureBetSchema(db) {
  const columns = db.prepare("PRAGMA table_info('bets')").all();
  const names = new Set(columns.map((row) => row?.name).filter(Boolean));

  if (!names.has('updated_at')) {
    db.exec('ALTER TABLE bets ADD COLUMN updated_at TEXT');
  }
  if (!names.has('settled_at')) {
    db.exec('ALTER TABLE bets ADD COLUMN settled_at TEXT');
  }
  if (!names.has('archived_at')) {
    db.exec('ALTER TABLE bets ADD COLUMN archived_at TEXT');
  }

  db.exec(
    "UPDATE bets SET updated_at = COALESCE(updated_at, created_at) WHERE updated_at IS NULL"
  );
  db.exec(
    "UPDATE bets SET result = 'pending' WHERE result IS NULL OR TRIM(result) = ''"
  );

  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_bets_user_active
      ON bets (telegram_user_id, archived_at, created_at)`
  );
}

function ensureUserProfileSchema(db) {
  const columns = db.prepare("PRAGMA table_info('user_profiles')").all();
  const names = new Set(columns.map((row) => row?.name).filter(Boolean));

  if (!names.has('timezone')) {
    db.exec('ALTER TABLE user_profiles ADD COLUMN timezone TEXT');
  }
  if (!names.has('min_stake_amount')) {
    db.exec('ALTER TABLE user_profiles ADD COLUMN min_stake_amount REAL');
  }
  if (!names.has('min_units_per_bet')) {
    db.exec('ALTER TABLE user_profiles ADD COLUMN min_units_per_bet REAL');
  }
  if (!names.has('target_event_utilization_pct')) {
    db.exec('ALTER TABLE user_profiles ADD COLUMN target_event_utilization_pct REAL');
  }
}

function ensureOddsApiCacheSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS odds_api_cache (
      cache_key TEXT PRIMARY KEY,
      endpoint TEXT NOT NULL,
      params_json TEXT,
      response_json TEXT NOT NULL,
      status_code INTEGER,
      requests_remaining INTEGER,
      requests_used INTEGER,
      requests_last INTEGER,
      fetched_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_odds_api_cache_expires
      ON odds_api_cache (expires_at);

    CREATE TABLE IF NOT EXISTS odds_api_usage_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      endpoint TEXT NOT NULL,
      cache_key TEXT,
      status_code INTEGER,
      requests_remaining INTEGER,
      requests_used INTEGER,
      requests_last INTEGER,
      metadata_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_odds_api_usage_time
      ON odds_api_usage_log (created_at DESC);
  `);
}

function isSqliteCorruptionError(error) {
  const code = String(error?.code || '').toUpperCase();
  const message = String(error?.message || '');
  if (code === 'SQLITE_CORRUPT' || code === 'SQLITE_NOTADB') {
    return true;
  }
  return /database disk image is malformed|malformed|not a database|corrupt/i.test(message);
}

function pragmaMessages(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => {
      if (!row || typeof row !== 'object') return '';
      const firstValue = Object.values(row)[0];
      return String(firstValue || '').trim();
    })
    .filter(Boolean);
}

function resetOddsCacheArtifacts(db, { reason = 'unknown' } = {}) {
  if (!ODDS_CACHE_SELF_HEAL_ENABLED) return false;
  if (oddsCacheRecoveryInFlight) return false;
  oddsCacheRecoveryInFlight = true;
  try {
    console.warn(`[sqliteStore] odds cache self-heal triggered (${reason}).`);
    db.exec('BEGIN IMMEDIATE');
    db.exec('DROP INDEX IF EXISTS idx_odds_api_cache_expires');
    db.exec('DROP TABLE IF EXISTS odds_api_cache');
    db.exec('DROP INDEX IF EXISTS idx_odds_api_usage_time');
    db.exec('DROP TABLE IF EXISTS odds_api_usage_log');
    ensureOddsApiCacheSchema(db);
    db.exec('COMMIT');
    console.warn('[sqliteStore] odds cache self-heal completed.');
    return true;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // noop
    }
    console.error('[sqliteStore] odds cache self-heal failed:', error);
    return false;
  } finally {
    oddsCacheRecoveryInFlight = false;
  }
}

function runStartupDbHealthCheck(db) {
  let shouldRecoverOddsCache = false;
  let reason = '';

  try {
    db.prepare('SELECT cache_key FROM odds_api_cache ORDER BY fetched_at DESC LIMIT 1').get();
    db.prepare('SELECT id FROM odds_api_usage_log ORDER BY created_at DESC LIMIT 1').get();
  } catch (error) {
    if (!isSqliteCorruptionError(error)) {
      throw error;
    }
    shouldRecoverOddsCache = true;
    reason = 'startup_odds_cache_probe_failed';
  }

  if (!shouldRecoverOddsCache && DB_STARTUP_QUICK_CHECK) {
    try {
      const messages = pragmaMessages(db.prepare('PRAGMA quick_check').all());
      const hasErrors = messages.some((message) => message.toLowerCase() !== 'ok');
      if (hasErrors) {
        shouldRecoverOddsCache = true;
        reason = `startup_quick_check:${messages[0] || 'unknown'}`;
      }
    } catch (error) {
      if (!isSqliteCorruptionError(error)) {
        throw error;
      }
      shouldRecoverOddsCache = true;
      reason = 'startup_quick_check_failed';
    }
  }

  if (!shouldRecoverOddsCache) {
    return;
  }

  const recovered = resetOddsCacheArtifacts(db, { reason });
  if (!recovered) {
    return;
  }

  if (DB_STARTUP_QUICK_CHECK) {
    try {
      const messages = pragmaMessages(db.prepare('PRAGMA quick_check').all());
      const hasErrors = messages.some((message) => message.toLowerCase() !== 'ok');
      if (hasErrors) {
        console.error(
          `[sqliteStore] quick_check still reports issues after odds cache self-heal: ${
            messages[0] || 'unknown'
          }`
        );
      }
    } catch (error) {
      console.error('[sqliteStore] quick_check failed after odds cache self-heal:', error);
    }
  }
}

function withOddsCacheAutoHeal(db, contextLabel, operation) {
  try {
    return operation();
  } catch (error) {
    if (!isSqliteCorruptionError(error) || !ODDS_CACHE_SELF_HEAL_ENABLED) {
      throw error;
    }

    const recovered = resetOddsCacheArtifacts(db, {
      reason: `runtime_${String(contextLabel || 'unknown')}`,
    });
    if (!recovered) {
      throw error;
    }

    return operation();
  }
}

export function getDb() {
  if (dbInstance) {
    return dbInstance;
  }

  ensureDir(DB_PATH);
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma(`busy_timeout = ${Math.max(1000, Number(SQLITE_BUSY_TIMEOUT_MS) || 5000)}`);
  db.pragma(`wal_autocheckpoint = ${Math.max(100, Number(SQLITE_WAL_AUTOCHECKPOINT_PAGES) || 1000)}`);
  db.pragma(`synchronous = ${SQLITE_SYNCHRONOUS_MODE}`);
  db.pragma('foreign_keys = ON');
  initSchema(db);
  ensureBetSchema(db);
  ensureUserProfileSchema(db);
  ensureOddsApiCacheSchema(db);
  runStartupDbHealthCheck(db);
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
      timezone: null,
      minStakeAmount: null,
      minUnitsPerBet: null,
      targetEventUtilizationPct: null,
    };
  }
  const db = getDb();
  const row = db
    .prepare(
      `SELECT bankroll, unit_size, risk_profile, currency, timezone,
              min_stake_amount, min_units_per_bet, target_event_utilization_pct, notes
       FROM user_profiles
       WHERE telegram_user_id = ?`
    )
    .get(userId);
  return {
    bankroll: row?.bankroll ?? null,
    unitSize: row?.unit_size ?? null,
    riskProfile: row?.risk_profile ?? null,
    currency: row?.currency ?? null,
    timezone: row?.timezone ?? null,
    minStakeAmount: row?.min_stake_amount ?? null,
    minUnitsPerBet: row?.min_units_per_bet ?? null,
    targetEventUtilizationPct: row?.target_event_utilization_pct ?? null,
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
    timezone: updates.timezone ?? current.timezone,
    minStakeAmount: updates.minStakeAmount ?? current.minStakeAmount,
    minUnitsPerBet: updates.minUnitsPerBet ?? current.minUnitsPerBet,
    targetEventUtilizationPct:
      updates.targetEventUtilizationPct ?? current.targetEventUtilizationPct,
    notes: updates.notes ?? current.notes,
  };

  db.prepare(
    `INSERT INTO user_profiles (
      telegram_user_id, bankroll, unit_size, risk_profile, currency, timezone,
      min_stake_amount, min_units_per_bet, target_event_utilization_pct, notes, updated_at
    )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(telegram_user_id) DO UPDATE SET
       bankroll = excluded.bankroll,
       unit_size = excluded.unit_size,
       risk_profile = excluded.risk_profile,
       currency = excluded.currency,
       timezone = excluded.timezone,
       min_stake_amount = excluded.min_stake_amount,
       min_units_per_bet = excluded.min_units_per_bet,
       target_event_utilization_pct = excluded.target_event_utilization_pct,
       notes = excluded.notes,
       updated_at = excluded.updated_at`
  ).run(
    userId,
    next.bankroll,
    next.unitSize,
    next.riskProfile,
    next.currency,
    next.timezone,
    next.minStakeAmount,
    next.minUnitsPerBet,
    next.targetEventUtilizationPct,
    next.notes,
    nowIso()
  );

  return next;
}

export function getActiveEventBudgetSession(userId, scope = {}) {
  if (!userId) return null;
  const db = getDb();
  const cleanUserId = String(userId || '').trim();
  if (!cleanUserId) return null;

  const cleanEventId = String(scope?.eventId || '').trim();
  if (cleanEventId) {
    const byEventId = db
      .prepare(
        `SELECT id, telegram_user_id, event_id, event_name, event_norm_key, event_date_utc,
                currency, budget_amount, base_stake_hint, notes, created_at, updated_at, closed_at
         FROM event_budget_sessions
         WHERE telegram_user_id = ?
           AND event_id = ?
           AND closed_at IS NULL
         ORDER BY updated_at DESC, id DESC
         LIMIT 1`
      )
      .get(cleanUserId, cleanEventId);
    if (byEventId) {
      return mapEventBudgetSessionRow(byEventId);
    }
  }

  const byNormKeys = Array.from(
    new Set(
      [
        buildEventBudgetNormKey(scope),
        buildEventBudgetNormKey({
          eventNormKey: scope?.eventNormKey,
          eventName: scope?.eventName,
          eventDateUtc: scope?.eventDateUtc,
        }),
      ].filter(Boolean)
    )
  );
  for (const normKey of byNormKeys) {
    const byNorm = db
      .prepare(
        `SELECT id, telegram_user_id, event_id, event_name, event_norm_key, event_date_utc,
                currency, budget_amount, base_stake_hint, notes, created_at, updated_at, closed_at
         FROM event_budget_sessions
         WHERE telegram_user_id = ?
           AND event_norm_key = ?
           AND closed_at IS NULL
         ORDER BY updated_at DESC, id DESC
         LIMIT 1`
      )
      .get(cleanUserId, normKey);
    if (byNorm) {
      return mapEventBudgetSessionRow(byNorm);
    }
  }

  if (scope?.allowAnyActive === true) {
    const latest = db
      .prepare(
        `SELECT id, telegram_user_id, event_id, event_name, event_norm_key, event_date_utc,
                currency, budget_amount, base_stake_hint, notes, created_at, updated_at, closed_at
         FROM event_budget_sessions
         WHERE telegram_user_id = ?
           AND closed_at IS NULL
         ORDER BY updated_at DESC, id DESC
         LIMIT 1`
      )
      .get(cleanUserId);
    return mapEventBudgetSessionRow(latest);
  }

  return null;
}

export function upsertEventBudgetSession(userId, payload = {}) {
  if (!userId || !payload || typeof payload !== 'object') return null;
  const db = getDb();
  const cleanUserId = String(userId || '').trim();
  if (!cleanUserId) return null;

  const budgetAmount = Number(payload.budgetAmount);
  if (!Number.isFinite(budgetAmount) || budgetAmount <= 0) {
    return null;
  }

  const cleanEventId = String(payload.eventId || '').trim() || null;
  const cleanEventDateUtc = toIsoDateOrNull(payload.eventDateUtc || '');
  const cleanEventNormKey = buildEventBudgetNormKey({
    eventId: cleanEventId,
    eventNormKey: payload.eventNormKey,
    eventName: payload.eventName,
    eventDateUtc: cleanEventDateUtc,
  });
  if (!cleanEventNormKey) {
    return null;
  }

  const providedEventName = String(payload.eventName || '').trim();
  const currencyRaw = String(payload.currency || '').trim().toUpperCase();
  const parsedBaseStakeHint = Number(payload.baseStakeHint);
  const hasBaseStakeHint = Object.prototype.hasOwnProperty.call(payload, 'baseStakeHint');
  const hasNotes = Object.prototype.hasOwnProperty.call(payload, 'notes');
  const notesValue = hasNotes ? String(payload.notes || '').trim() || null : undefined;
  const ts = nowIso();

  const write = db.transaction(() => {
    const existing = db
      .prepare(
        `SELECT id, event_id, event_name, event_date_utc, currency, budget_amount, base_stake_hint, notes
         FROM event_budget_sessions
         WHERE telegram_user_id = ?
           AND event_norm_key = ?
           AND closed_at IS NULL
         ORDER BY id DESC
         LIMIT 1`
      )
      .get(cleanUserId, cleanEventNormKey);

    if (existing?.id) {
      const nextEventId = cleanEventId || existing.event_id || null;
      const nextEventName =
        providedEventName || existing.event_name || cleanEventId || 'Evento UFC';
      const nextEventDateUtc = cleanEventDateUtc || existing.event_date_utc || null;
      const nextCurrency = currencyRaw || existing.currency || null;
      const nextBaseStakeHint = hasBaseStakeHint
        ? Number.isFinite(parsedBaseStakeHint) && parsedBaseStakeHint > 0
          ? parsedBaseStakeHint
          : null
        : existing.base_stake_hint ?? null;
      const nextNotes = hasNotes ? notesValue : existing.notes ?? null;

      db.prepare(
        `UPDATE event_budget_sessions
         SET event_id = ?,
             event_name = ?,
             event_date_utc = ?,
             currency = ?,
             budget_amount = ?,
             base_stake_hint = ?,
             notes = ?,
             updated_at = ?
         WHERE id = ?`
      ).run(
        nextEventId,
        nextEventName,
        nextEventDateUtc,
        nextCurrency,
        budgetAmount,
        nextBaseStakeHint,
        nextNotes,
        ts,
        Number(existing.id)
      );

      return Number(existing.id);
    }

    const eventName = providedEventName || cleanEventId || 'Evento UFC';
    const currency = currencyRaw || null;
    const baseStakeHint =
      Number.isFinite(parsedBaseStakeHint) && parsedBaseStakeHint > 0 ? parsedBaseStakeHint : null;
    const notes = hasNotes ? notesValue : null;

    const inserted = db.prepare(
      `INSERT INTO event_budget_sessions
        (telegram_user_id, event_id, event_name, event_norm_key, event_date_utc, currency,
         budget_amount, base_stake_hint, notes, created_at, updated_at, closed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
    ).run(
      cleanUserId,
      cleanEventId,
      eventName,
      cleanEventNormKey,
      cleanEventDateUtc,
      currency,
      budgetAmount,
      baseStakeHint,
      notes,
      ts,
      ts
    );
    return Number(inserted.lastInsertRowid);
  });

  const rowId = write();
  const row = db
    .prepare(
      `SELECT id, telegram_user_id, event_id, event_name, event_norm_key, event_date_utc,
              currency, budget_amount, base_stake_hint, notes, created_at, updated_at, closed_at
       FROM event_budget_sessions
       WHERE id = ?`
    )
    .get(rowId);
  return mapEventBudgetSessionRow(row);
}

function normalizeResult(result = '') {
  const value = String(result || '').toLowerCase();
  if (!value.trim()) return 'pending';
  if (
    value.includes('pending') ||
    value.includes('pend') ||
    value.includes('open') ||
    value.includes('abierta')
  ) {
    return 'pending';
  }
  if (
    value.includes('win') ||
    value.includes('won') ||
    value.includes('gan')
  ) {
    return 'win';
  }
  if (
    value.includes('loss') ||
    value.includes('lose') ||
    value.includes('lost') ||
    value.includes('perd')
  ) {
    return 'loss';
  }
  if (
    value.includes('push') ||
    value.includes('draw') ||
    value.includes('void') ||
    value.includes('nula')
  ) {
    return 'push';
  }
  return null;
}

function normalizeLooseText(value = '') {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function toIsoDateOrNull(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString().slice(0, 10);
}

function normalizeEventBudgetNormKey(value = '') {
  return normalizeLooseText(value)
    .replace(/[^a-z0-9:_\-\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildEventBudgetNormKey({
  eventId = null,
  eventNormKey = null,
  eventName = null,
  eventDateUtc = null,
} = {}) {
  const providedNormKey = normalizeEventBudgetNormKey(eventNormKey || '');
  if (providedNormKey) {
    return providedNormKey;
  }

  const cleanEventName = normalizeEventBudgetNormKey(eventName || '');
  const cleanEventDate = toIsoDateOrNull(eventDateUtc || '');
  if (cleanEventName && cleanEventDate) {
    return `${cleanEventName}::${cleanEventDate}`;
  }
  if (cleanEventName) {
    return `name:${cleanEventName}`;
  }
  const cleanEventId = normalizeEventBudgetNormKey(eventId || '');
  if (cleanEventId) {
    return `id:${cleanEventId}`;
  }
  return '';
}

function mapEventBudgetSessionRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    telegramUserId: String(row.telegram_user_id || ''),
    eventId: row.event_id || null,
    eventName: row.event_name || null,
    eventNormKey: row.event_norm_key || null,
    eventDateUtc: row.event_date_utc || null,
    currency: row.currency || null,
    budgetAmount:
      row.budget_amount === null || row.budget_amount === undefined
        ? null
        : Number(row.budget_amount),
    baseStakeHint:
      row.base_stake_hint === null || row.base_stake_hint === undefined
        ? null
        : Number(row.base_stake_hint),
    notes: row.notes || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    closedAt: row.closed_at || null,
  };
}

function isSettledResult(result = '') {
  return result === 'win' || result === 'loss' || result === 'push';
}

function mapBetRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    eventName: row.event_name,
    fight: row.fight,
    pick: row.pick,
    odds: row.odds,
    stake: row.stake,
    units: row.units,
    result: normalizeResult(row.result) || 'pending',
    notes: row.notes,
    recordedAt: row.created_at,
    updatedAt: row.updated_at || row.created_at,
    settledAt: row.settled_at || null,
    archivedAt: row.archived_at || null,
  };
}

function mapPendingBetForAuto(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    telegramUserId: row.telegram_user_id ? String(row.telegram_user_id) : null,
    eventName: row.event_name || null,
    fight: row.fight || null,
    pick: row.pick || null,
    odds: row.odds ?? null,
    stake: row.stake ?? null,
    units: row.units ?? null,
    result: normalizeResult(row.result) || 'pending',
    recordedAt: row.created_at || null,
    updatedAt: row.updated_at || row.created_at || null,
  };
}

function listBetRowsForUser(
  db,
  userId,
  { includeArchived = false, limit = 300 } = {}
) {
  if (!userId) return [];
  const rows = db
    .prepare(
      `SELECT id, event_name, fight, pick, odds, stake, units, result, notes, created_at, updated_at, settled_at, archived_at
       FROM bets
       WHERE telegram_user_id = ?
       ORDER BY id DESC
       LIMIT ?`
    )
    .all(userId, Math.max(1, Number(limit) || 300));

  if (includeArchived) {
    return rows;
  }
  return rows.filter((row) => !row.archived_at);
}

function filterBetRows(rows = [], filter = {}) {
  const eventNameNorm = normalizeLooseText(filter.eventName || '');
  const fightNorm = normalizeLooseText(filter.fight || '');
  const pickNorm = normalizeLooseText(filter.pick || '');
  const rawStatus = String(filter.status ?? '').trim();
  const wantedStatus = rawStatus ? normalizeResult(rawStatus) : null;
  const wantedIds = new Set(
    Array.isArray(filter.betIds)
      ? filter.betIds
          .map((value) => Number(value))
          .filter((value) => Number.isInteger(value) && value > 0)
      : []
  );

  return rows.filter((row) => {
    if (wantedIds.size && !wantedIds.has(Number(row.id))) {
      return false;
    }

    if (eventNameNorm) {
      const rowEvent = normalizeLooseText(row.event_name || '');
      if (!rowEvent.includes(eventNameNorm)) {
        return false;
      }
    }

    if (fightNorm) {
      const rowFight = normalizeLooseText(row.fight || '');
      if (!rowFight.includes(fightNorm)) {
        return false;
      }
    }

    if (pickNorm) {
      const rowPick = normalizeLooseText(row.pick || '');
      if (!rowPick.includes(pickNorm)) {
        return false;
      }
    }

    if (wantedStatus) {
      const rowStatus = normalizeResult(row.result) || 'pending';
      if (rowStatus !== wantedStatus) {
        return false;
      }
    }

    return true;
  });
}

function logBetMutation(db, {
  userId,
  betId,
  action,
  prevResult = null,
  nextResult = null,
  prevArchivedAt = null,
  nextArchivedAt = null,
  metadata = null,
  at = nowIso(),
} = {}) {
  db.prepare(
    `INSERT INTO bet_mutations
      (telegram_user_id, bet_id, action, prev_result, new_result, prev_archived_at, new_archived_at, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    userId || null,
    betId || null,
    action || null,
    prevResult || null,
    nextResult || null,
    prevArchivedAt || null,
    nextArchivedAt || null,
    metadata ? JSON.stringify(metadata) : null,
    at
  );
}

function parseJsonSafe(value, fallback = null) {
  if (!value || typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function rebuildLedgerSummaryWithDb(db, userId, { at = nowIso(), limit = 2000 } = {}) {
  const rows = listBetRowsForUser(db, userId, { includeArchived: false, limit });

  let totalStaked = 0;
  let totalUnits = 0;
  let wins = 0;
  let losses = 0;
  let pushes = 0;

  for (const row of rows) {
    totalStaked += Number(row.stake) || 0;
    totalUnits += Number(row.units) || 0;
    const status = normalizeResult(row.result) || 'pending';
    if (status === 'win') wins += 1;
    if (status === 'loss') losses += 1;
    if (status === 'push') pushes += 1;
  }

  const totalBets = rows.length;

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
  ).run(userId, totalStaked, totalUnits, totalBets, wins, losses, pushes, at);

  return {
    totalStaked,
    totalUnits,
    totalBets,
    wins,
    losses,
    pushes,
    lastUpdatedAt: at,
  };
}

export function rebuildLedgerSummary(userId) {
  if (!userId) return null;
  const db = getDb();
  return rebuildLedgerSummaryWithDb(db, userId, { at: nowIso() });
}

export function listUserBets(userId, options = {}) {
  if (!userId) return [];
  const db = getDb();
  const rows = listBetRowsForUser(db, userId, {
    includeArchived: Boolean(options.includeArchived),
    limit: options.limit ?? 300,
  });
  const filtered = filterBetRows(rows, options);
  const limit = Math.max(1, Number(options.limit) || 50);
  return filtered.slice(0, limit).map(mapBetRow);
}

export function listPendingBetsForAutoSettlement({ limit = 300 } = {}) {
  const db = getDb();
  const max = Math.max(1, Number(limit) || 300);
  const rows = db
    .prepare(
      `SELECT id, telegram_user_id, event_name, fight, pick, odds, stake, units, result, created_at, updated_at
       FROM bets
       WHERE archived_at IS NULL
         AND lower(coalesce(result, 'pending')) IN ('pending', 'open')
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(max);

  return rows.map(mapPendingBetForAuto).filter(Boolean);
}

export function getLatestChatIdForUser(userId) {
  if (!userId) return null;
  const db = getDb();
  const row = db
    .prepare(
      `SELECT chat_id
       FROM sessions
       WHERE telegram_user_id = ?
         AND chat_id IS NOT NULL
         AND trim(chat_id) <> ''
       ORDER BY last_activity_at DESC
       LIMIT 1`
    )
    .get(String(userId));

  return row?.chat_id ? String(row.chat_id) : null;
}

function buildMutationPreview(userId, payload = {}) {
  const operation = String(payload.operation || '').trim().toLowerCase();
  if (!operation) {
    return { ok: false, error: 'missing_operation' };
  }

  if (!['settle', 'set_pending', 'archive'].includes(operation)) {
    return { ok: false, error: 'invalid_operation' };
  }

  const normalizedResult = normalizeResult(payload.result);
  if (operation === 'settle' && !isSettledResult(normalizedResult)) {
    return { ok: false, error: 'invalid_settle_result' };
  }

  const rawStatus = String(payload.status ?? '').trim();
  const explicitStatus = rawStatus ? normalizeResult(rawStatus) : null;
  const statusFilter =
    operation === 'settle'
      ? (explicitStatus || 'pending')
      : explicitStatus;

  const explicitIds = Array.isArray(payload.betIds)
    ? payload.betIds
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value > 0)
    : [];
  const explicitIdsSet = new Set(explicitIds);

  const candidates = listUserBets(userId, {
    includeArchived: false,
    betIds: payload.betIds,
    eventName: payload.eventName,
    fight: payload.fight,
    pick: payload.pick,
    status: statusFilter,
    limit: payload.limit ?? 100,
  });

  if (!candidates.length) {
    return {
      ok: false,
      error: 'no_matching_bets',
      operation,
      statusFilter,
    };
  }

  const hasExplicitIds = explicitIdsSet.size > 0;
  if (hasExplicitIds) {
    const matched = new Set(
      candidates
        .map((item) => Number(item?.id))
        .filter((value) => Number.isInteger(value) && value > 0)
    );
    const missingIds = explicitIds.filter((id) => !matched.has(id));
    if (missingIds.length) {
      return {
        ok: false,
        error: 'explicit_ids_not_found',
        missingIds,
        operation,
      };
    }
  }

  const explicitIdCount = explicitIds.length;
  const hasSingleExplicitId = hasExplicitIds && explicitIdCount === 1;
  const isBulkSelection = candidates.length > 1 || explicitIdCount > 1;

  let requiresConfirmation = false;
  let confirmationReason = null;

  if (operation === 'archive') {
    if (!hasSingleExplicitId) {
      requiresConfirmation = true;
      confirmationReason = isBulkSelection
        ? 'bulk_archive'
        : 'archive_requires_explicit_confirmation';
    }
  } else if (operation === 'settle' || operation === 'set_pending') {
    if (!hasSingleExplicitId) {
      requiresConfirmation = true;
      confirmationReason = isBulkSelection
        ? 'bulk_state_change'
        : 'state_change_without_explicit_bet_id';
    }
  }

  return {
    ok: true,
    operation,
    result: normalizedResult || null,
    requiresConfirmation,
    confirmationReason,
    hasExplicitIds,
    hasSingleExplicitId,
    explicitIdCount,
    candidates,
  };
}

export function previewBetMutation(userId, payload = {}) {
  if (!userId) return { ok: false, error: 'missing_user_id' };
  return buildMutationPreview(userId, payload);
}

function normalizeCompositeTransactionPolicy(value = '') {
  const policy = String(value || '')
    .trim()
    .toLowerCase();
  if (!policy) return 'all_or_nothing';
  if (policy === 'all_or_nothing') return policy;
  return null;
}

function buildCompositeMutationPreview(userId, payload = {}) {
  const transactionPolicy = normalizeCompositeTransactionPolicy(payload.transactionPolicy);
  if (!transactionPolicy) {
    return { ok: false, error: 'invalid_transaction_policy' };
  }

  const steps = Array.isArray(payload.steps)
    ? payload.steps
        .map((step) => (step && typeof step === 'object' ? step : null))
        .filter(Boolean)
    : [];
  if (!steps.length) {
    return { ok: false, error: 'missing_steps' };
  }
  if (steps.length > 12) {
    return { ok: false, error: 'too_many_steps', maxSteps: 12 };
  }

  const stepResults = [];
  const stepPreviews = [];
  let requiresConfirmation = false;

  for (let index = 0; index < steps.length; index += 1) {
    const stepPayload = steps[index];
    const preview = buildMutationPreview(userId, stepPayload);
    if (!preview?.ok) {
      stepResults.push({
        index,
        ok: false,
        operation: String(stepPayload?.operation || '')
          .trim()
          .toLowerCase(),
        result: normalizeResult(stepPayload?.result) || null,
        error: preview?.error || 'invalid_step',
      });

      return {
        ok: false,
        error: 'composite_preview_failed',
        transactionPolicy,
        failedStepIndex: index,
        stepResults,
      };
    }

    const stepResult = {
      index,
      ok: true,
      operation: preview.operation,
      result: preview.result || null,
      requiresConfirmation: Boolean(preview.requiresConfirmation),
      confirmationReason: preview.confirmationReason || null,
      candidateCount: preview.candidates?.length || 0,
      candidates: preview.candidates || [],
    };

    requiresConfirmation = requiresConfirmation || stepResult.requiresConfirmation;
    stepResults.push(stepResult);
    stepPreviews.push({
      index,
      payload: stepPayload,
      preview,
    });
  }

  return {
    ok: true,
    transactionPolicy,
    requiresConfirmation,
    stepResults,
    stepPreviews,
  };
}

function applyMutationPreviewInTransaction(
  db,
  userId,
  preview,
  { metadata = null, at = nowIso(), strictCandidates = false } = {}
) {
  const operation = preview.operation;
  const nextResult =
    operation === 'settle'
      ? preview.result
      : operation === 'set_pending'
      ? 'pending'
      : null;

  const receipts = [];
  for (const candidate of preview.candidates) {
    const before = db
      .prepare(
        `SELECT id, result, archived_at
         FROM bets
         WHERE id = ? AND telegram_user_id = ?`
      )
      .get(candidate.id, userId);
    if (!before) {
      if (strictCandidates) {
        const error = new Error('mutation_candidate_not_found');
        error.code = 'mutation_candidate_not_found';
        error.betId = candidate.id;
        throw error;
      }
      continue;
    }

    if (operation === 'archive') {
      db.prepare(
        `UPDATE bets
         SET archived_at = ?, updated_at = ?
         WHERE id = ? AND telegram_user_id = ?`
      ).run(at, at, candidate.id, userId);
    } else if (operation === 'set_pending') {
      db.prepare(
        `UPDATE bets
         SET result = ?, settled_at = NULL, updated_at = ?
         WHERE id = ? AND telegram_user_id = ?`
      ).run('pending', at, candidate.id, userId);
    } else {
      db.prepare(
        `UPDATE bets
         SET result = ?, settled_at = ?, updated_at = ?
         WHERE id = ? AND telegram_user_id = ?`
      ).run(nextResult, at, at, candidate.id, userId);
    }

    const after = db
      .prepare(
        `SELECT id, event_name, fight, pick, result, archived_at, updated_at
         FROM bets
         WHERE id = ? AND telegram_user_id = ?`
      )
      .get(candidate.id, userId);
    if (!after) {
      const error = new Error('mutation_candidate_missing_after_apply');
      error.code = 'mutation_candidate_missing_after_apply';
      error.betId = candidate.id;
      throw error;
    }

    logBetMutation(db, {
      userId,
      betId: candidate.id,
      action: operation,
      prevResult: normalizeResult(before.result) || 'pending',
      nextResult: normalizeResult(after?.result) || 'pending',
      prevArchivedAt: before.archived_at || null,
      nextArchivedAt: after?.archived_at || null,
      metadata,
      at,
    });

    receipts.push({
      action: operation,
      betId: candidate.id,
      eventName: after?.event_name || null,
      fight: after?.fight || null,
      pick: after?.pick || null,
      previousResult: normalizeResult(before.result) || 'pending',
      newResult: normalizeResult(after?.result) || 'pending',
      previousArchivedAt: before.archived_at || null,
      newArchivedAt: after?.archived_at || null,
      updatedAt: after?.updated_at || at,
    });
  }

  return receipts;
}

export function applyBetMutation(userId, payload = {}) {
  if (!userId) return { ok: false, error: 'missing_user_id' };
  const preview = buildMutationPreview(userId, payload);
  if (!preview.ok) {
    return preview;
  }

  if (preview.requiresConfirmation && !payload.confirm) {
    return {
      ok: false,
      error: 'confirmation_required',
      preview,
    };
  }

  const db = getDb();
  const ts = nowIso();
  const operation = preview.operation;

  let receipts = [];
  let ledgerSummary = null;
  try {
    const apply = db.transaction(() => {
      const txReceipts = applyMutationPreviewInTransaction(db, userId, preview, {
        metadata: payload.metadata || null,
        at: ts,
        strictCandidates: false,
      });
      const txSummary = rebuildLedgerSummaryWithDb(db, userId, { at: ts });
      return {
        receipts: txReceipts,
        ledgerSummary: txSummary,
      };
    });
    const applied = apply();
    receipts = applied.receipts;
    ledgerSummary = applied.ledgerSummary;
  } catch (error) {
    return {
      ok: false,
      error: error?.code || 'mutation_apply_failed',
      message: error instanceof Error ? error.message : String(error),
      operation,
    };
  }

  return {
    ok: true,
    operation,
    affectedCount: receipts.length,
    receipts,
    ledgerSummary,
  };
}

export function previewCompositeBetMutations(userId, payload = {}) {
  if (!userId) return { ok: false, error: 'missing_user_id' };
  const preview = buildCompositeMutationPreview(userId, payload);
  if (!preview.ok) {
    return preview;
  }

  return {
    ok: true,
    transactionPolicy: preview.transactionPolicy,
    requiresConfirmation: preview.requiresConfirmation,
    stepResults: preview.stepResults,
  };
}

export function applyCompositeBetMutations(userId, payload = {}) {
  if (!userId) return { ok: false, error: 'missing_user_id' };

  const preview = buildCompositeMutationPreview(userId, payload);
  if (!preview.ok) {
    return preview;
  }

  if (preview.requiresConfirmation && !payload.confirm) {
    return {
      ok: false,
      error: 'confirmation_required',
      preview: {
        transactionPolicy: preview.transactionPolicy,
        requiresConfirmation: true,
        stepResults: preview.stepResults,
      },
    };
  }

  const db = getDb();
  const ts = nowIso();

  let stepResults = [];
  let receipts = [];
  let ledgerSummary = null;
  try {
    const apply = db.transaction(() => {
      const nextStepResults = [];
      const allReceipts = [];
      for (const step of preview.stepPreviews) {
        const baseMetadata =
          payload.metadata && typeof payload.metadata === 'object'
            ? payload.metadata
            : null;
        const stepMetadata =
          step.payload?.metadata && typeof step.payload.metadata === 'object'
            ? step.payload.metadata
            : null;
        const metadata = {
          ...(baseMetadata || {}),
          ...(stepMetadata || {}),
          transactionPolicy: preview.transactionPolicy,
          compositeStepIndex: step.index,
        };

        let appliedStepReceipts = [];
        try {
          appliedStepReceipts = applyMutationPreviewInTransaction(
            db,
            userId,
            step.preview,
            {
              metadata,
              at: ts,
              strictCandidates: true,
            }
          );
        } catch (error) {
          if (error && typeof error === 'object') {
            error.failedStepIndex = step.index;
          }
          throw error;
        }

        nextStepResults.push({
          index: step.index,
          operation: step.preview.operation,
          result: step.preview.result || null,
          affectedCount: appliedStepReceipts.length,
          receipts: appliedStepReceipts,
        });
        allReceipts.push(...appliedStepReceipts);
      }
      const txSummary = rebuildLedgerSummaryWithDb(db, userId, { at: ts });
      return {
        stepResults: nextStepResults,
        receipts: allReceipts,
        ledgerSummary: txSummary,
      };
    });

    const applied = apply();
    stepResults = applied.stepResults;
    receipts = applied.receipts;
    ledgerSummary = applied.ledgerSummary;
  } catch (error) {
    return {
      ok: false,
      error: error?.code || 'composite_apply_failed',
      message: error instanceof Error ? error.message : String(error),
      transactionPolicy: preview.transactionPolicy,
      failedStepIndex:
        Number.isInteger(error?.failedStepIndex) && error.failedStepIndex >= 0
          ? error.failedStepIndex
          : null,
      failedBetId:
        Number.isInteger(error?.betId) && error.betId > 0 ? error.betId : null,
    };
  }

  return {
    ok: true,
    transactionPolicy: preview.transactionPolicy,
    affectedCount: receipts.length,
    stepResults,
    receipts,
    ledgerSummary,
  };
}

export function undoLastBetMutation(
  userId,
  { windowMinutes = LEDGER_UNDO_WINDOW_MINUTES } = {}
) {
  if (!userId) return { ok: false, error: 'missing_user_id' };

  const db = getDb();
  const now = nowIso();
  const windowMs = Math.max(1, Number(windowMinutes) || LEDGER_UNDO_WINDOW_MINUTES) * 60 * 1000;
  const minCreatedAtMs = Date.now() - windowMs;

  const undoRows = db
    .prepare(
      `SELECT metadata
       FROM bet_mutations
       WHERE telegram_user_id = ? AND action = 'undo'
       ORDER BY id DESC
       LIMIT 200`
    )
    .all(userId);
  const undoneMutationIds = new Set();
  for (const row of undoRows) {
    const metadata = parseJsonSafe(row?.metadata, {});
    const undoneId = Number(metadata?.undoneMutationId);
    if (Number.isInteger(undoneId) && undoneId > 0) {
      undoneMutationIds.add(undoneId);
    }
  }

  const candidates = db
    .prepare(
      `SELECT id, bet_id, action, prev_result, new_result, prev_archived_at, new_archived_at, metadata, created_at
       FROM bet_mutations
       WHERE telegram_user_id = ?
         AND action IN ('archive', 'settle', 'set_pending')
       ORDER BY id DESC
       LIMIT 200`
    )
    .all(userId);

  const target = candidates.find((row) => {
    if (undoneMutationIds.has(Number(row.id))) {
      return false;
    }
    const createdAtMs = Date.parse(row.created_at || '');
    if (!Number.isFinite(createdAtMs)) {
      return false;
    }
    return createdAtMs >= minCreatedAtMs;
  });

  if (!target) {
    return {
      ok: false,
      error: 'no_undo_candidate',
      message: 'No encontre una mutacion reciente reversible dentro de la ventana permitida.',
    };
  }

  const betId = Number(target.bet_id);
  if (!Number.isInteger(betId) || betId <= 0) {
    return {
      ok: false,
      error: 'invalid_target_bet',
    };
  }

  const current = db
    .prepare(
      `SELECT id, event_name, fight, pick, result, archived_at, settled_at, updated_at
       FROM bets
       WHERE id = ? AND telegram_user_id = ?`
    )
    .get(betId, userId);

  if (!current) {
    return {
      ok: false,
      error: 'target_bet_not_found',
    };
  }

  const nextResult = normalizeResult(target.prev_result) || 'pending';
  const nextArchivedAt = target.prev_archived_at || null;
  const nextSettledAt = isSettledResult(nextResult) ? current.settled_at || now : null;

  const applyUndo = db.transaction(() => {
    db.prepare(
      `UPDATE bets
       SET result = ?, archived_at = ?, settled_at = ?, updated_at = ?
       WHERE id = ? AND telegram_user_id = ?`
    ).run(nextResult, nextArchivedAt, nextSettledAt, now, betId, userId);

    const undoMetadata = {
      undoneMutationId: Number(target.id),
      undoneAction: target.action,
      undoneCreatedAt: target.created_at,
      originalMetadata: parseJsonSafe(target.metadata, null),
    };

    logBetMutation(db, {
      userId,
      betId,
      action: 'undo',
      prevResult: normalizeResult(current.result) || 'pending',
      nextResult,
      prevArchivedAt: current.archived_at || null,
      nextArchivedAt,
      metadata: undoMetadata,
      at: now,
    });

    const after = db
      .prepare(
        `SELECT id, event_name, fight, pick, result, archived_at, updated_at
         FROM bets
         WHERE id = ? AND telegram_user_id = ?`
      )
      .get(betId, userId);
    const ledgerSummary = rebuildLedgerSummaryWithDb(db, userId, { at: now });
    return {
      after,
      ledgerSummary,
    };
  });

  const applied = applyUndo();
  const after = applied?.after || null;
  const ledgerSummary = applied?.ledgerSummary || null;

  return {
    ok: true,
    undoneMutationId: Number(target.id),
    undoneAction: target.action,
    receipt: {
      action: 'undo',
      betId,
      eventName: after?.event_name || null,
      fight: after?.fight || null,
      pick: after?.pick || null,
      previousResult: normalizeResult(current.result) || 'pending',
      newResult: normalizeResult(after?.result) || 'pending',
      previousArchivedAt: current.archived_at || null,
      newArchivedAt: after?.archived_at || null,
      updatedAt: after?.updated_at || now,
    },
    ledgerSummary,
  };
}

export function addBetRecord(userId, record = {}) {
  if (!userId) return null;
  const db = getDb();
  const ts = nowIso();
  const normalizedResult = normalizeResult(record.result) || 'pending';
  const settledAt = isSettledResult(normalizedResult) ? ts : null;

  const insertRecord = db.transaction(() => {
    const result = db.prepare(
      `INSERT INTO bets
        (telegram_user_id, event_name, fight, pick, odds, stake, units, result, notes, created_at, updated_at, settled_at, archived_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
    ).run(
      userId,
      record.eventName || null,
      record.fight || null,
      record.pick || null,
      record.odds ?? null,
      record.stake ?? null,
      record.units ?? null,
      normalizedResult,
      record.notes || null,
      ts,
      ts,
      settledAt
    );

    const betId = Number(result.lastInsertRowid);
    logBetMutation(db, {
      userId,
      betId,
      action: 'create',
      prevResult: null,
      nextResult: normalizedResult,
      prevArchivedAt: null,
      nextArchivedAt: null,
      metadata: { source: 'record_user_bet' },
      at: ts,
    });

    rebuildLedgerSummaryWithDb(db, userId, { at: ts });

    const row = db
      .prepare(
        `SELECT id, event_name, fight, pick, odds, stake, units, result, notes, created_at, updated_at, settled_at, archived_at
         FROM bets
         WHERE id = ? AND telegram_user_id = ?`
      )
      .get(betId, userId);
    return row;
  });

  const row = insertRecord();

  return mapBetRow(row);
}

export function getBetHistory(userId, limit = 20, options = {}) {
  if (!userId) return [];
  const bets = listUserBets(userId, {
    includeArchived: Boolean(options.includeArchived),
    limit,
  });
  return bets;
}

export function getLedgerSummary(userId) {
  if (!userId) return null;
  const db = getDb();
  let row = db
    .prepare(
      `SELECT total_staked, total_units, total_bets, wins, losses, pushes, last_updated_at
       FROM ledger_summary WHERE telegram_user_id = ?`
    )
    .get(userId);

  if (!row) {
    return rebuildLedgerSummary(userId);
  }

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

function parseJsonOrNull(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function listCreditTransactions(userId, { limit = 8 } = {}) {
  if (!userId) return [];
  const db = getDb();
  const max = Math.max(1, Math.min(50, Number(limit) || 8));
  const rows = db
    .prepare(
      `SELECT id, amount, type, reason, metadata, created_at
       FROM credit_transactions
       WHERE telegram_user_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT ?`
    )
    .all(String(userId), max);

  return rows.map((row) => ({
    id: row.id,
    amount: Number(row.amount) || 0,
    type: row.type || null,
    reason: row.reason || null,
    metadata: parseJsonOrNull(row.metadata),
    createdAt: row.created_at || null,
  }));
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

function parseOddsApiCacheRow(row) {
  if (!row) return null;
  return {
    cacheKey: row.cache_key || null,
    endpoint: row.endpoint || null,
    params: parseJsonSafe(row.params_json, {}),
    responseJson: parseJsonSafe(row.response_json, null),
    statusCode: row.status_code === null || row.status_code === undefined ? null : Number(row.status_code),
    requestsRemaining:
      row.requests_remaining === null || row.requests_remaining === undefined
        ? null
        : Number(row.requests_remaining),
    requestsUsed:
      row.requests_used === null || row.requests_used === undefined
        ? null
        : Number(row.requests_used),
    requestsLast:
      row.requests_last === null || row.requests_last === undefined
        ? null
        : Number(row.requests_last),
    fetchedAt: row.fetched_at || null,
    expiresAt: row.expires_at || null,
  };
}

function getOddsApiCacheRowByKey(db, cleanKey) {
  return db
    .prepare(
      `SELECT cache_key, endpoint, params_json, response_json, status_code,
              requests_remaining, requests_used, requests_last,
              fetched_at, expires_at
       FROM odds_api_cache
       WHERE cache_key = ?`
    )
    .get(cleanKey);
}

export function getOddsApiCacheEntry(cacheKey = '') {
  const cleanKey = String(cacheKey || '').trim();
  if (!cleanKey) return null;
  const db = getDb();
  return withOddsCacheAutoHeal(db, 'getOddsApiCacheEntry', () =>
    parseOddsApiCacheRow(getOddsApiCacheRowByKey(db, cleanKey))
  );
}

export function upsertOddsApiCacheEntry(entry = {}) {
  const cacheKey = String(entry.cacheKey || '').trim();
  if (!cacheKey) return null;
  const db = getDb();

  return withOddsCacheAutoHeal(db, 'upsertOddsApiCacheEntry', () => {
    db.prepare(
      `INSERT INTO odds_api_cache
        (cache_key, endpoint, params_json, response_json, status_code,
         requests_remaining, requests_used, requests_last, fetched_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(cache_key) DO UPDATE SET
         endpoint = excluded.endpoint,
         params_json = excluded.params_json,
         response_json = excluded.response_json,
         status_code = excluded.status_code,
         requests_remaining = excluded.requests_remaining,
         requests_used = excluded.requests_used,
         requests_last = excluded.requests_last,
         fetched_at = excluded.fetched_at,
         expires_at = excluded.expires_at`
    ).run(
      cacheKey,
      entry.endpoint || null,
      JSON.stringify(entry.params || {}),
      JSON.stringify(entry.responseJson ?? null),
      entry.statusCode === null || entry.statusCode === undefined
        ? null
        : Number(entry.statusCode),
      entry.requestsRemaining === null || entry.requestsRemaining === undefined
        ? null
        : Number(entry.requestsRemaining),
      entry.requestsUsed === null || entry.requestsUsed === undefined
        ? null
        : Number(entry.requestsUsed),
      entry.requestsLast === null || entry.requestsLast === undefined
        ? null
        : Number(entry.requestsLast),
      entry.fetchedAt || nowIso(),
      entry.expiresAt || nowIso()
    );

    return parseOddsApiCacheRow(getOddsApiCacheRowByKey(db, cacheKey));
  });
}

export function logOddsApiUsage(sample = {}) {
  const endpoint = String(sample.endpoint || '').trim();
  if (!endpoint) return null;
  const db = getDb();
  const ts = sample.createdAt || nowIso();

  return withOddsCacheAutoHeal(db, 'logOddsApiUsage', () => {
    const result = db
      .prepare(
        `INSERT INTO odds_api_usage_log
          (endpoint, cache_key, status_code, requests_remaining, requests_used, requests_last, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        endpoint,
        sample.cacheKey || null,
        sample.statusCode === null || sample.statusCode === undefined
          ? null
          : Number(sample.statusCode),
        sample.requestsRemaining === null || sample.requestsRemaining === undefined
          ? null
          : Number(sample.requestsRemaining),
        sample.requestsUsed === null || sample.requestsUsed === undefined
          ? null
          : Number(sample.requestsUsed),
        sample.requestsLast === null || sample.requestsLast === undefined
          ? null
          : Number(sample.requestsLast),
        sample.metadata ? JSON.stringify(sample.metadata) : null,
        ts
      );

    return {
      id: Number(result.lastInsertRowid),
      createdAt: ts,
    };
  });
}

export function listRecentOddsApiUsage(limit = 20) {
  const db = getDb();
  const max = Math.max(1, Math.min(200, Number(limit) || 20));
  return withOddsCacheAutoHeal(db, 'listRecentOddsApiUsage', () => {
    const rows = db
      .prepare(
        `SELECT id, endpoint, cache_key, status_code, requests_remaining, requests_used, requests_last, metadata_json, created_at
         FROM odds_api_usage_log
         ORDER BY created_at DESC, id DESC
         LIMIT ?`
      )
      .all(max);

    return rows.map((row) => ({
      id: Number(row.id),
      endpoint: row.endpoint || null,
      cacheKey: row.cache_key || null,
      statusCode:
        row.status_code === null || row.status_code === undefined
          ? null
          : Number(row.status_code),
      requestsRemaining:
        row.requests_remaining === null || row.requests_remaining === undefined
          ? null
          : Number(row.requests_remaining),
      requestsUsed:
        row.requests_used === null || row.requests_used === undefined
          ? null
          : Number(row.requests_used),
      requestsLast:
        row.requests_last === null || row.requests_last === undefined
          ? null
          : Number(row.requests_last),
      metadata: parseJsonSafe(row.metadata_json, null),
      createdAt: row.created_at || null,
    }));
  });
}

export function getLatestOddsApiQuotaState() {
  const db = getDb();
  const row = withOddsCacheAutoHeal(db, 'getLatestOddsApiQuotaState', () =>
    db
      .prepare(
        `SELECT requests_remaining, requests_used, requests_last, endpoint, created_at
         FROM odds_api_usage_log
         WHERE requests_remaining IS NOT NULL
         ORDER BY created_at DESC, id DESC
         LIMIT 1`
      )
      .get()
  );

  if (!row) {
    return {
      requestsRemaining: null,
      requestsUsed: null,
      requestsLast: null,
      endpoint: null,
      createdAt: null,
    };
  }

  return {
    requestsRemaining:
      row.requests_remaining === null || row.requests_remaining === undefined
        ? null
        : Number(row.requests_remaining),
    requestsUsed:
      row.requests_used === null || row.requests_used === undefined
        ? null
        : Number(row.requests_used),
    requestsLast:
      row.requests_last === null || row.requests_last === undefined
        ? null
        : Number(row.requests_last),
    endpoint: row.endpoint || null,
    createdAt: row.created_at || null,
  };
}

function parseOddsEventIndexRow(row) {
  if (!row) return null;
  return {
    eventId: row.event_id || null,
    sportKey: row.sport_key || null,
    eventName: row.event_name || null,
    eventNormKey: row.event_norm_key || null,
    commenceTime: row.commence_time || null,
    homeTeam: row.home_team || null,
    awayTeam: row.away_team || null,
    completed: Boolean(row.completed),
    scores: parseJsonSafe(row.scores_json, null),
    lastOddsSyncAt: row.last_odds_sync_at || null,
    lastScoresSyncAt: row.last_scores_sync_at || null,
    updatedAt: row.updated_at || null,
  };
}

export function upsertOddsEventsIndex(
  events = [],
  { markOddsSyncAt = false, markScoresSyncAt = false } = {}
) {
  const rows = Array.isArray(events) ? events : [];
  if (!rows.length) {
    return { upsertedCount: 0 };
  }
  const db = getDb();
  const ts = nowIso();

  const upsert = db.prepare(
    `INSERT INTO odds_events_index
      (event_id, sport_key, event_name, event_norm_key, commence_time, home_team, away_team,
       completed, scores_json, last_odds_sync_at, last_scores_sync_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(event_id) DO UPDATE SET
       sport_key = excluded.sport_key,
       event_name = excluded.event_name,
       event_norm_key = excluded.event_norm_key,
       commence_time = excluded.commence_time,
       home_team = excluded.home_team,
       away_team = excluded.away_team,
       completed = excluded.completed,
       scores_json = excluded.scores_json,
       last_odds_sync_at = excluded.last_odds_sync_at,
       last_scores_sync_at = excluded.last_scores_sync_at,
       updated_at = excluded.updated_at`
  );

  const run = db.transaction((inputRows) => {
    let upsertedCount = 0;
    for (const row of inputRows) {
      const eventId = String(row?.eventId || row?.id || '').trim();
      if (!eventId) continue;
      upsert.run(
        eventId,
        row.sportKey || null,
        row.eventName || null,
        row.eventNormKey || null,
        row.commenceTime || null,
        row.homeTeam || null,
        row.awayTeam || null,
        row.completed ? 1 : 0,
        row.scores ? JSON.stringify(row.scores) : null,
        markOddsSyncAt ? ts : row.lastOddsSyncAt || null,
        markScoresSyncAt ? ts : row.lastScoresSyncAt || null,
        ts
      );
      upsertedCount += 1;
    }
    return { upsertedCount };
  });

  return run(rows);
}

export function listUpcomingOddsEvents({
  sportKey = 'mma_mixed_martial_arts',
  fromIso = null,
  limit = 30,
} = {}) {
  const db = getDb();
  const max = Math.max(1, Math.min(300, Number(limit) || 30));
  const from = String(fromIso || nowIso()).trim();
  const rows = db
    .prepare(
      `SELECT event_id, sport_key, event_name, event_norm_key, commence_time, home_team, away_team,
              completed, scores_json, last_odds_sync_at, last_scores_sync_at, updated_at
       FROM odds_events_index
       WHERE sport_key = ?
         AND completed = 0
         AND (commence_time IS NULL OR commence_time >= ?)
       ORDER BY commence_time ASC
       LIMIT ?`
    )
    .all(String(sportKey || 'mma_mixed_martial_arts'), from, max);

  return rows.map(parseOddsEventIndexRow).filter(Boolean);
}

export function listRecentOddsEvents({
  sportKey = 'mma_mixed_martial_arts',
  fromIso = null,
  toIso = null,
  limit = 120,
  includeCompleted = true,
} = {}) {
  const db = getDb();
  const max = Math.max(1, Math.min(500, Number(limit) || 120));
  const from = fromIso ? String(fromIso).trim() : null;
  const to = toIso ? String(toIso).trim() : null;
  const completedValue = includeCompleted ? null : 0;

  const rows = db
    .prepare(
      `SELECT event_id, sport_key, event_name, event_norm_key, commence_time, home_team, away_team,
              completed, scores_json, last_odds_sync_at, last_scores_sync_at, updated_at
       FROM odds_events_index
       WHERE sport_key = ?
         AND (? IS NULL OR completed = ?)
         AND (? IS NULL OR commence_time >= ?)
         AND (? IS NULL OR commence_time <= ?)
       ORDER BY commence_time DESC, updated_at DESC
       LIMIT ?`
    )
    .all(
      String(sportKey || 'mma_mixed_martial_arts'),
      completedValue,
      completedValue,
      from,
      from,
      to,
      to,
      max
    );

  return rows.map(parseOddsEventIndexRow).filter(Boolean);
}

function parseOddsMarketSnapshotRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    provider: row.provider || null,
    sportKey: row.sport_key || null,
    eventId: row.event_id || null,
    eventName: row.event_name || null,
    eventNormKey: row.event_norm_key || null,
    commenceTime: row.commence_time || null,
    homeTeam: row.home_team || null,
    awayTeam: row.away_team || null,
    fighterANorm: row.fighter_a_norm || null,
    fighterBNorm: row.fighter_b_norm || null,
    bookmakerKey: row.bookmaker_key || null,
    bookmakerTitle: row.bookmaker_title || null,
    marketKey: row.market_key || null,
    outcomeAName: row.outcome_a_name || null,
    outcomeAPrice:
      row.outcome_a_price === null || row.outcome_a_price === undefined
        ? null
        : Number(row.outcome_a_price),
    outcomeBName: row.outcome_b_name || null,
    outcomeBPrice:
      row.outcome_b_price === null || row.outcome_b_price === undefined
        ? null
        : Number(row.outcome_b_price),
    drawPrice:
      row.draw_price === null || row.draw_price === undefined
        ? null
        : Number(row.draw_price),
    sourceLastUpdate: row.source_last_update || null,
    fetchedAt: row.fetched_at || null,
    payload: parseJsonSafe(row.payload_json, null),
    dedupeKey: row.dedupe_key || null,
  };
}

export function insertOddsMarketSnapshots(items = []) {
  const rows = Array.isArray(items) ? items : [];
  if (!rows.length) {
    return { insertedCount: 0 };
  }
  const db = getDb();

  const insert = db.prepare(
    `INSERT OR IGNORE INTO odds_market_snapshots
      (provider, sport_key, event_id, event_name, event_norm_key, commence_time,
       home_team, away_team, fighter_a_norm, fighter_b_norm,
       bookmaker_key, bookmaker_title, market_key, outcome_a_name, outcome_a_price,
       outcome_b_name, outcome_b_price, draw_price, source_last_update, fetched_at,
       payload_json, dedupe_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const run = db.transaction((inputRows) => {
    let insertedCount = 0;
    for (const row of inputRows) {
      const dedupeKey = String(row?.dedupeKey || '').trim();
      if (!dedupeKey) continue;
      const result = insert.run(
        row.provider || 'the_odds_api',
        row.sportKey || 'mma_mixed_martial_arts',
        row.eventId || null,
        row.eventName || null,
        row.eventNormKey || null,
        row.commenceTime || null,
        row.homeTeam || null,
        row.awayTeam || null,
        row.fighterANorm || null,
        row.fighterBNorm || null,
        row.bookmakerKey || null,
        row.bookmakerTitle || null,
        row.marketKey || 'h2h',
        row.outcomeAName || null,
        row.outcomeAPrice === null || row.outcomeAPrice === undefined
          ? null
          : Number(row.outcomeAPrice),
        row.outcomeBName || null,
        row.outcomeBPrice === null || row.outcomeBPrice === undefined
          ? null
          : Number(row.outcomeBPrice),
        row.drawPrice === null || row.drawPrice === undefined ? null : Number(row.drawPrice),
        row.sourceLastUpdate || null,
        row.fetchedAt || nowIso(),
        row.payloadJson || null,
        dedupeKey
      );
      if (Number(result.changes) > 0) {
        insertedCount += 1;
      }
    }
    return { insertedCount };
  });

  return run(rows);
}

export function listLatestOddsMarketsForEvent({
  eventId = '',
  sportKey = 'mma_mixed_martial_arts',
  marketKey = 'h2h',
  limit = 80,
  maxAgeHours = 72,
} = {}) {
  const cleanEventId = String(eventId || '').trim();
  if (!cleanEventId) return [];

  const db = getDb();
  const max = Math.max(1, Math.min(500, Number(limit) || 80));
  const cutoff = new Date(Date.now() - Math.max(1, Number(maxAgeHours) || 72) * 3600 * 1000).toISOString();
  const rows = db
    .prepare(
      `SELECT id, provider, sport_key, event_id, event_name, event_norm_key, commence_time,
              home_team, away_team, fighter_a_norm, fighter_b_norm,
              bookmaker_key, bookmaker_title, market_key,
              outcome_a_name, outcome_a_price, outcome_b_name, outcome_b_price,
              draw_price, source_last_update, fetched_at, payload_json, dedupe_key
       FROM odds_market_snapshots
       WHERE event_id = ?
         AND sport_key = ?
         AND market_key = ?
         AND fetched_at >= ?
       ORDER BY fetched_at DESC, id DESC
       LIMIT ?`
    )
    .all(
      cleanEventId,
      String(sportKey || 'mma_mixed_martial_arts'),
      String(marketKey || 'h2h'),
      cutoff,
      max
    );

  return rows.map(parseOddsMarketSnapshotRow).filter(Boolean);
}

export function listLatestOddsMarketsForFight({
  fighterA = '',
  fighterB = '',
  sportKey = 'mma_mixed_martial_arts',
  marketKey = 'h2h',
  limit = 40,
  maxAgeHours = 72,
} = {}) {
  const normA = normalizeName(fighterA);
  const normB = normalizeName(fighterB);
  if (!normA || !normB) return [];
  const db = getDb();
  const max = Math.max(1, Math.min(500, Number(limit) || 40));
  const cutoff = new Date(Date.now() - Math.max(1, Number(maxAgeHours) || 72) * 3600 * 1000).toISOString();

  const rows = db
    .prepare(
      `SELECT id, provider, sport_key, event_id, event_name, event_norm_key, commence_time,
              home_team, away_team, fighter_a_norm, fighter_b_norm,
              bookmaker_key, bookmaker_title, market_key,
              outcome_a_name, outcome_a_price, outcome_b_name, outcome_b_price,
              draw_price, source_last_update, fetched_at, payload_json, dedupe_key
       FROM odds_market_snapshots
       WHERE sport_key = ?
         AND market_key = ?
         AND fetched_at >= ?
         AND (
           (fighter_a_norm = ? AND fighter_b_norm = ?)
           OR
           (fighter_a_norm = ? AND fighter_b_norm = ?)
         )
       ORDER BY fetched_at DESC, id DESC
       LIMIT ?`
    )
    .all(
      String(sportKey || 'mma_mixed_martial_arts'),
      String(marketKey || 'h2h'),
      cutoff,
      normA,
      normB,
      normB,
      normA,
      max
    );

  return rows.map(parseOddsMarketSnapshotRow).filter(Boolean);
}

function parseProjectionSnapshotRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    eventId: row.event_id || null,
    fightId: row.fight_id || null,
    fighterA: row.fighter_a || null,
    fighterB: row.fighter_b || null,
    predictedWinner: row.predicted_winner || null,
    predictedMethod: row.predicted_method || null,
    confidencePct:
      row.confidence_pct === null || row.confidence_pct === undefined
        ? null
        : Number(row.confidence_pct),
    keyFactors: parseJsonSafe(row.key_factors_json, []),
    relevantNewsIds: parseJsonSafe(row.relevant_news_ids_json, []),
    reasoningVersion: row.reasoning_version || null,
    changedFromPrev: Boolean(row.changed_from_prev),
    changeSummary: row.change_summary || null,
    createdAt: row.created_at || null,
  };
}

function parseBetScoringSnapshotRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    eventId: row.event_id || null,
    fightId: row.fight_id || null,
    fighterA: row.fighter_a || null,
    fighterB: row.fighter_b || null,
    marketKey: row.market_key || null,
    selection: row.selection || null,
    recommendation: row.recommendation || 'no_bet',
    edgePct:
      row.edge_pct === null || row.edge_pct === undefined ? 0 : Number(row.edge_pct),
    confidencePct:
      row.confidence_pct === null || row.confidence_pct === undefined
        ? 0
        : Number(row.confidence_pct),
    riskLevel: row.risk_level || 'high',
    suggestedStakeUnits:
      row.suggested_stake_units === null || row.suggested_stake_units === undefined
        ? null
        : Number(row.suggested_stake_units),
    suggestedStakeAmount:
      row.suggested_stake_amount === null || row.suggested_stake_amount === undefined
        ? null
        : Number(row.suggested_stake_amount),
    noBetReason: row.no_bet_reason || null,
    modelProbabilityPct:
      row.model_probability_pct === null || row.model_probability_pct === undefined
        ? null
        : Number(row.model_probability_pct),
    impliedProbabilityPct:
      row.implied_probability_pct === null || row.implied_probability_pct === undefined
        ? null
        : Number(row.implied_probability_pct),
    consensusOdds:
      row.consensus_odds === null || row.consensus_odds === undefined
        ? null
        : Number(row.consensus_odds),
    booksCount:
      row.books_count === null || row.books_count === undefined ? 0 : Number(row.books_count),
    inputs: parseJsonSafe(row.inputs_json, {}),
    reasoningVersion: row.reasoning_version || null,
    createdAt: row.created_at || null,
  };
}

export function insertFightProjectionSnapshots(items = []) {
  const rows = Array.isArray(items) ? items : [];
  if (!rows.length) {
    return { insertedCount: 0 };
  }
  const db = getDb();
  const ts = nowIso();

  const insert = db.prepare(
    `INSERT INTO fight_projection_snapshots
      (event_id, fight_id, fighter_a, fighter_b, predicted_winner, predicted_method,
       confidence_pct, key_factors_json, relevant_news_ids_json, reasoning_version,
       changed_from_prev, change_summary, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const run = db.transaction((inputRows) => {
    let insertedCount = 0;
    for (const row of inputRows) {
      const eventId = String(row?.eventId || '').trim();
      const fightId = String(row?.fightId || '').trim();
      const fighterA = String(row?.fighterA || '').trim();
      const fighterB = String(row?.fighterB || '').trim();
      if (!eventId || !fightId || !fighterA || !fighterB) continue;

      insert.run(
        eventId,
        fightId,
        fighterA,
        fighterB,
        row.predictedWinner || null,
        row.predictedMethod || null,
        row.confidencePct === null || row.confidencePct === undefined
          ? 0
          : Number(row.confidencePct),
        JSON.stringify(Array.isArray(row.keyFactors) ? row.keyFactors : []),
        JSON.stringify(Array.isArray(row.relevantNewsIds) ? row.relevantNewsIds : []),
        row.reasoningVersion || 'v1',
        row.changedFromPrev ? 1 : 0,
        row.changeSummary || null,
        row.createdAt || ts
      );
      insertedCount += 1;
    }
    return { insertedCount };
  });

  return run(rows);
}

export function getLatestProjectionForFight({
  eventId = '',
  fightId = '',
  fighterA = '',
  fighterB = '',
} = {}) {
  const cleanEventId = String(eventId || '').trim();
  if (!cleanEventId) return null;
  const db = getDb();

  if (fightId) {
    const row = db
      .prepare(
        `SELECT id, event_id, fight_id, fighter_a, fighter_b, predicted_winner, predicted_method,
                confidence_pct, key_factors_json, relevant_news_ids_json, reasoning_version,
                changed_from_prev, change_summary, created_at
         FROM fight_projection_snapshots
         WHERE event_id = ? AND fight_id = ?
         ORDER BY created_at DESC, id DESC
         LIMIT 1`
      )
      .get(cleanEventId, String(fightId));
    return parseProjectionSnapshotRow(row);
  }

  const normA = normalizeName(fighterA);
  const normB = normalizeName(fighterB);
  if (!normA || !normB) return null;

  const row = db
    .prepare(
      `SELECT id, event_id, fight_id, fighter_a, fighter_b, predicted_winner, predicted_method,
              confidence_pct, key_factors_json, relevant_news_ids_json, reasoning_version,
              changed_from_prev, change_summary, created_at
       FROM fight_projection_snapshots
       WHERE event_id = ?
         AND (
           (lower(fighter_a) = ? AND lower(fighter_b) = ?)
           OR
           (lower(fighter_a) = ? AND lower(fighter_b) = ?)
         )
       ORDER BY created_at DESC, id DESC
       LIMIT 1`
    )
    .get(cleanEventId, normA, normB, normB, normA);
  return parseProjectionSnapshotRow(row);
}

export function listLatestProjectionSnapshotsForEvent({
  eventId = '',
  limit = 20,
  latestPerFight = true,
} = {}) {
  const cleanEventId = String(eventId || '').trim();
  if (!cleanEventId) return [];
  const db = getDb();
  const max = Math.max(1, Math.min(200, Number(limit) || 20));
  const rows = db
    .prepare(
      `SELECT id, event_id, fight_id, fighter_a, fighter_b, predicted_winner, predicted_method,
              confidence_pct, key_factors_json, relevant_news_ids_json, reasoning_version,
              changed_from_prev, change_summary, created_at
       FROM fight_projection_snapshots
       WHERE event_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT ?`
    )
    .all(cleanEventId, Math.max(max * 4, max));

  const parsed = rows.map(parseProjectionSnapshotRow).filter(Boolean);
  if (!latestPerFight) {
    return parsed.slice(0, max);
  }

  const byFight = new Map();
  for (const row of parsed) {
    const fightKey = String(row.fightId || '').trim() || `${row.fighterA}::${row.fighterB}`;
    if (!fightKey || byFight.has(fightKey)) continue;
    byFight.set(fightKey, row);
    if (byFight.size >= max) break;
  }
  return Array.from(byFight.values());
}

export function insertFightBetScoringSnapshots(items = []) {
  const rows = Array.isArray(items) ? items : [];
  if (!rows.length) {
    return { insertedCount: 0 };
  }

  const db = getDb();
  const ts = nowIso();
  const insert = db.prepare(
    `INSERT INTO fight_bet_scoring_snapshots
      (event_id, fight_id, fighter_a, fighter_b, market_key, selection, recommendation,
       edge_pct, confidence_pct, risk_level, suggested_stake_units, suggested_stake_amount,
       no_bet_reason, model_probability_pct, implied_probability_pct, consensus_odds, books_count,
       inputs_json, reasoning_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const run = db.transaction((inputRows) => {
    let insertedCount = 0;
    for (const row of inputRows) {
      const eventId = String(row?.eventId || '').trim();
      const fightId = String(row?.fightId || '').trim();
      const fighterA = String(row?.fighterA || '').trim();
      const fighterB = String(row?.fighterB || '').trim();
      const marketKey = String(row?.marketKey || '').trim();
      if (!eventId || !fightId || !fighterA || !fighterB || !marketKey) continue;

      insert.run(
        eventId,
        fightId,
        fighterA,
        fighterB,
        marketKey,
        row.selection || null,
        row.recommendation || 'no_bet',
        row.edgePct === null || row.edgePct === undefined ? 0 : Number(row.edgePct),
        row.confidencePct === null || row.confidencePct === undefined
          ? 0
          : Number(row.confidencePct),
        row.riskLevel || 'high',
        row.suggestedStakeUnits === null || row.suggestedStakeUnits === undefined
          ? null
          : Number(row.suggestedStakeUnits),
        row.suggestedStakeAmount === null || row.suggestedStakeAmount === undefined
          ? null
          : Number(row.suggestedStakeAmount),
        row.noBetReason || null,
        row.modelProbabilityPct === null || row.modelProbabilityPct === undefined
          ? null
          : Number(row.modelProbabilityPct),
        row.impliedProbabilityPct === null || row.impliedProbabilityPct === undefined
          ? null
          : Number(row.impliedProbabilityPct),
        row.consensusOdds === null || row.consensusOdds === undefined
          ? null
          : Number(row.consensusOdds),
        row.booksCount === null || row.booksCount === undefined ? 0 : Number(row.booksCount),
        JSON.stringify(
          row.inputs && typeof row.inputs === 'object' ? row.inputs : {}
        ),
        row.reasoningVersion || 'v1_market_pack',
        row.createdAt || ts
      );
      insertedCount += 1;
    }
    return { insertedCount };
  });

  return run(rows);
}

export function getLatestBetScoringForFight({
  eventId = '',
  fightId = '',
  fighterA = '',
  fighterB = '',
  marketKey = '',
} = {}) {
  const cleanEventId = String(eventId || '').trim();
  if (!cleanEventId) return null;
  const cleanMarketKey = String(marketKey || '').trim();
  const db = getDb();

  if (fightId) {
    const row = db
      .prepare(
        `SELECT id, event_id, fight_id, fighter_a, fighter_b, market_key, selection, recommendation,
                edge_pct, confidence_pct, risk_level, suggested_stake_units, suggested_stake_amount,
                no_bet_reason, model_probability_pct, implied_probability_pct, consensus_odds, books_count,
                inputs_json, reasoning_version, created_at
         FROM fight_bet_scoring_snapshots
         WHERE event_id = ?
           AND fight_id = ?
           AND (? = '' OR market_key = ?)
         ORDER BY created_at DESC, id DESC
         LIMIT 1`
      )
      .get(cleanEventId, String(fightId), cleanMarketKey, cleanMarketKey);
    return parseBetScoringSnapshotRow(row);
  }

  const normA = normalizeName(fighterA);
  const normB = normalizeName(fighterB);
  if (!normA || !normB) return null;

  const row = db
    .prepare(
      `SELECT id, event_id, fight_id, fighter_a, fighter_b, market_key, selection, recommendation,
              edge_pct, confidence_pct, risk_level, suggested_stake_units, suggested_stake_amount,
              no_bet_reason, model_probability_pct, implied_probability_pct, consensus_odds, books_count,
              inputs_json, reasoning_version, created_at
       FROM fight_bet_scoring_snapshots
       WHERE event_id = ?
         AND (? = '' OR market_key = ?)
         AND (
           (lower(fighter_a) = ? AND lower(fighter_b) = ?)
           OR
           (lower(fighter_a) = ? AND lower(fighter_b) = ?)
         )
       ORDER BY created_at DESC, id DESC
       LIMIT 1`
    )
    .get(cleanEventId, cleanMarketKey, cleanMarketKey, normA, normB, normB, normA);
  return parseBetScoringSnapshotRow(row);
}

export function listLatestBetScoringForEvent({
  eventId = '',
  marketKey = '',
  limit = 60,
  latestPerFightMarket = true,
} = {}) {
  const cleanEventId = String(eventId || '').trim();
  if (!cleanEventId) return [];
  const cleanMarketKey = String(marketKey || '').trim();
  const max = Math.max(1, Math.min(500, Number(limit) || 60));
  const db = getDb();

  const rows = db
    .prepare(
      `SELECT id, event_id, fight_id, fighter_a, fighter_b, market_key, selection, recommendation,
              edge_pct, confidence_pct, risk_level, suggested_stake_units, suggested_stake_amount,
              no_bet_reason, model_probability_pct, implied_probability_pct, consensus_odds, books_count,
              inputs_json, reasoning_version, created_at
       FROM fight_bet_scoring_snapshots
       WHERE event_id = ?
         AND (? = '' OR market_key = ?)
       ORDER BY created_at DESC, id DESC
       LIMIT ?`
    )
    .all(cleanEventId, cleanMarketKey, cleanMarketKey, Math.max(max * 4, max));

  const parsed = rows.map(parseBetScoringSnapshotRow).filter(Boolean);
  if (!latestPerFightMarket) {
    return parsed.slice(0, max);
  }

  const deduped = new Map();
  for (const row of parsed) {
    const key = `${String(row?.fightId || '').trim()}::${String(row?.marketKey || '').trim()}`;
    if (!key || deduped.has(key)) continue;
    deduped.set(key, row);
    if (deduped.size >= max) break;
  }
  return Array.from(deduped.values());
}

function parseFightHistoryCacheRow(row) {
  if (!row) return null;
  let rows = [];
  try {
    rows = row.rows_json ? JSON.parse(row.rows_json) : [];
  } catch {
    rows = [];
  }

  return {
    cacheKey: row.cache_key,
    sheetId: row.sheet_id || null,
    range: row.range_name || null,
    rowCount: Number(row.row_count) || 0,
    hash: row.hash || null,
    rows: Array.isArray(rows) ? rows : [],
    lastSyncAt: row.last_sync_at || null,
    lastSyncUpdatedCache: Boolean(row.last_sync_updated_cache),
    latestFightDate: row.latest_fight_date || null,
    sheetAgeDays:
      row.sheet_age_days === null || row.sheet_age_days === undefined
        ? null
        : Number(row.sheet_age_days),
    potentialGap: Boolean(row.potential_gap),
    updatedAt: row.updated_at || null,
  };
}

export function getFightHistoryCacheSnapshot(cacheKey = 'default') {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT cache_key, sheet_id, range_name, row_count, hash, rows_json, last_sync_at,
              last_sync_updated_cache, latest_fight_date, sheet_age_days, potential_gap, updated_at
       FROM fight_history_cache
       WHERE cache_key = ?`
    )
    .get(String(cacheKey || 'default'));
  return parseFightHistoryCacheRow(row);
}

export function upsertFightHistoryCacheSnapshot(snapshot = {}, cacheKey = 'default') {
  const db = getDb();
  const ts = nowIso();
  const rows = Array.isArray(snapshot.rows) ? snapshot.rows : [];
  const rowCount = Number.isFinite(Number(snapshot.rowCount))
    ? Number(snapshot.rowCount)
    : rows.length;

  db.prepare(
    `INSERT INTO fight_history_cache
      (cache_key, sheet_id, range_name, row_count, hash, rows_json, last_sync_at,
       last_sync_updated_cache, latest_fight_date, sheet_age_days, potential_gap, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(cache_key) DO UPDATE SET
       sheet_id = excluded.sheet_id,
       range_name = excluded.range_name,
       row_count = excluded.row_count,
       hash = excluded.hash,
       rows_json = excluded.rows_json,
       last_sync_at = excluded.last_sync_at,
       last_sync_updated_cache = excluded.last_sync_updated_cache,
       latest_fight_date = excluded.latest_fight_date,
       sheet_age_days = excluded.sheet_age_days,
       potential_gap = excluded.potential_gap,
       updated_at = excluded.updated_at`
  ).run(
    String(cacheKey || 'default'),
    snapshot.sheetId || null,
    snapshot.range || null,
    rowCount,
    snapshot.hash || null,
    JSON.stringify(rows),
    snapshot.lastSyncAt || ts,
    snapshot.lastSyncUpdatedCache ? 1 : 0,
    snapshot.latestFightDate || null,
    snapshot.sheetAgeDays === null || snapshot.sheetAgeDays === undefined
      ? null
      : Number(snapshot.sheetAgeDays),
    snapshot.potentialGap ? 1 : 0,
    ts
  );

  return getFightHistoryCacheSnapshot(cacheKey);
}

function parseEventWatchStateRow(row) {
  if (!row) return null;
  const mainCard = parseJsonSafe(row.main_card_json, []);
  const monitoredFighters = parseJsonSafe(row.monitored_fighters_json, []);
  return {
    watchKey: row.watch_key || 'next_event',
    eventId: row.event_id || null,
    eventName: row.event_name || null,
    eventDateUtc: row.event_date_utc || null,
    eventStatus: row.event_status || null,
    sourcePrimary: row.source_primary || null,
    sourceSecondary: row.source_secondary || null,
    mainCard: Array.isArray(mainCard) ? mainCard : [],
    monitoredFighters: Array.isArray(monitoredFighters) ? monitoredFighters : [],
    lastReconciledAt: row.last_reconciled_at || null,
    updatedAt: row.updated_at || null,
  };
}

export function getEventWatchState(watchKey = 'next_event') {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT watch_key, event_id, event_name, event_date_utc, event_status,
              source_primary, source_secondary, main_card_json, monitored_fighters_json,
              last_reconciled_at, updated_at
       FROM event_watch_state
       WHERE watch_key = ?`
    )
    .get(String(watchKey || 'next_event'));
  return parseEventWatchStateRow(row);
}

export function upsertEventWatchState(snapshot = {}, watchKey = 'next_event') {
  const db = getDb();
  const ts = nowIso();
  const mainCard = Array.isArray(snapshot.mainCard) ? snapshot.mainCard : [];
  const monitoredFighters = Array.isArray(snapshot.monitoredFighters)
    ? snapshot.monitoredFighters
    : [];

  db.prepare(
    `INSERT INTO event_watch_state
      (watch_key, event_id, event_name, event_date_utc, event_status,
       source_primary, source_secondary, main_card_json, monitored_fighters_json,
       last_reconciled_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(watch_key) DO UPDATE SET
       event_id = excluded.event_id,
       event_name = excluded.event_name,
       event_date_utc = excluded.event_date_utc,
       event_status = excluded.event_status,
       source_primary = excluded.source_primary,
       source_secondary = excluded.source_secondary,
       main_card_json = excluded.main_card_json,
       monitored_fighters_json = excluded.monitored_fighters_json,
       last_reconciled_at = excluded.last_reconciled_at,
       updated_at = excluded.updated_at`
  ).run(
    String(watchKey || 'next_event'),
    snapshot.eventId || null,
    snapshot.eventName || 'Unknown UFC Event',
    snapshot.eventDateUtc || null,
    snapshot.eventStatus || null,
    snapshot.sourcePrimary || null,
    snapshot.sourceSecondary || null,
    JSON.stringify(mainCard),
    JSON.stringify(monitoredFighters),
    snapshot.lastReconciledAt || ts,
    ts
  );

  return getEventWatchState(watchKey);
}

function normalizeImpactLevel(value = 'high') {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'low' || raw === 'medium' || raw === 'high') return raw;
  return 'high';
}

function parseFighterNewsRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    eventId: row.event_id || null,
    fighterSlug: row.fighter_slug || null,
    fighterName: row.fighter_name_display || null,
    title: row.title || null,
    url: row.url || null,
    sourceDomain: row.source_domain || null,
    publishedAt: row.published_at || null,
    fetchedAt: row.fetched_at || null,
    summary: row.summary || null,
    impactLevel: row.impact_level || 'low',
    impactScore: Number(row.impact_score) || 0,
    confidenceScore: Number(row.confidence_score) || 0,
    tags: parseJsonSafe(row.tags_json, []),
    contentHash: row.content_hash || null,
    dedupeKey: row.dedupe_key || null,
    isRelevant: Boolean(row.is_relevant),
  };
}

export function insertFighterNewsItems(items = []) {
  const db = getDb();
  const list = Array.isArray(items) ? items : [];
  if (!list.length) {
    return { insertedCount: 0 };
  }

  const insert = db.prepare(
    `INSERT OR IGNORE INTO fighter_news_items
      (event_id, fighter_slug, fighter_name_display, title, url, source_domain,
       published_at, fetched_at, summary, impact_level, impact_score, confidence_score,
       tags_json, content_hash, dedupe_key, is_relevant)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const run = db.transaction((rows) => {
    let insertedCount = 0;
    for (const row of rows) {
      const result = insert.run(
        row.eventId || 'unknown_event',
        row.fighterSlug || null,
        row.fighterNameDisplay || null,
        row.title || null,
        row.url || null,
        row.sourceDomain || null,
        row.publishedAt || null,
        row.fetchedAt || nowIso(),
        row.summary || null,
        normalizeImpactLevel(row.impactLevel || 'low'),
        Number(row.impactScore) || 0,
        Number(row.confidenceScore) || 0,
        JSON.stringify(Array.isArray(row.tags) ? row.tags : []),
        row.contentHash || null,
        row.dedupeKey || null,
        row.isRelevant ? 1 : 0
      );
      if (Number(result.changes) > 0) {
        insertedCount += 1;
      }
    }
    return { insertedCount };
  });

  return run(list);
}

function impactLevelsForMin(minImpact = 'medium') {
  const level = normalizeImpactLevel(minImpact);
  if (level === 'low') return ['low', 'medium', 'high'];
  if (level === 'medium') return ['medium', 'high'];
  return ['high'];
}

export function listLatestRelevantNews({
  eventId = null,
  limit = 12,
  minImpact = 'medium',
} = {}) {
  const db = getDb();
  const levels = impactLevelsForMin(minImpact);
  const max = Math.max(1, Number(limit) || 12);

  const placeholders = levels.map(() => '?').join(', ');
  const params = [];
  let where = `is_relevant = 1 AND impact_level IN (${placeholders})`;
  params.push(...levels);
  if (eventId) {
    where += ' AND event_id = ?';
    params.push(String(eventId));
  }
  params.push(max);

  const rows = db
    .prepare(
      `SELECT id, event_id, fighter_slug, fighter_name_display, title, url, source_domain,
              published_at, fetched_at, summary, impact_level, impact_score, confidence_score,
              tags_json, content_hash, dedupe_key, is_relevant
       FROM fighter_news_items
       WHERE ${where}
       ORDER BY COALESCE(published_at, fetched_at) DESC, id DESC
       LIMIT ?`
    )
    .all(...params);

  return rows.map(parseFighterNewsRow).filter(Boolean);
}

export function getUserIntelPrefs(userId) {
  if (!userId) return null;
  const db = getDb();
  const row = db
    .prepare(
      `SELECT telegram_user_id, news_alerts_enabled, alert_min_impact,
              confidence_delta_threshold, updated_at
       FROM user_intel_prefs
       WHERE telegram_user_id = ?`
    )
    .get(String(userId));

  if (!row) {
    return {
      telegramUserId: String(userId),
      newsAlertsEnabled: true,
      alertMinImpact: 'high',
      confidenceDeltaThreshold: 8,
      updatedAt: null,
    };
  }

  return {
    telegramUserId: String(row.telegram_user_id),
    newsAlertsEnabled: Boolean(row.news_alerts_enabled),
    alertMinImpact: normalizeImpactLevel(row.alert_min_impact || 'high'),
    confidenceDeltaThreshold: Number(row.confidence_delta_threshold) || 8,
    updatedAt: row.updated_at || null,
  };
}

export function updateUserIntelPrefs(userId, updates = {}) {
  if (!userId) return null;
  const db = getDb();
  const current = getUserIntelPrefs(userId) || {
    newsAlertsEnabled: true,
    alertMinImpact: 'high',
    confidenceDeltaThreshold: 8,
  };
  const ts = nowIso();

  const next = {
    newsAlertsEnabled:
      updates.newsAlertsEnabled === undefined
        ? current.newsAlertsEnabled
        : Boolean(updates.newsAlertsEnabled),
    alertMinImpact:
      updates.alertMinImpact === undefined
        ? current.alertMinImpact
        : normalizeImpactLevel(updates.alertMinImpact),
    confidenceDeltaThreshold:
      updates.confidenceDeltaThreshold === undefined
        ? Number(current.confidenceDeltaThreshold) || 8
        : Number.isFinite(Number(updates.confidenceDeltaThreshold))
        ? Number(updates.confidenceDeltaThreshold)
        : Number(current.confidenceDeltaThreshold) || 8,
  };

  db.prepare(
    `INSERT INTO user_intel_prefs
      (telegram_user_id, news_alerts_enabled, alert_min_impact, confidence_delta_threshold, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(telegram_user_id) DO UPDATE SET
       news_alerts_enabled = excluded.news_alerts_enabled,
       alert_min_impact = excluded.alert_min_impact,
       confidence_delta_threshold = excluded.confidence_delta_threshold,
       updated_at = excluded.updated_at`
  ).run(
    String(userId),
    next.newsAlertsEnabled ? 1 : 0,
    next.alertMinImpact,
    next.confidenceDeltaThreshold,
    ts
  );

  return getUserIntelPrefs(userId);
}

export function getDbPath() {
  return DB_PATH;
}

// ---------------------------------------------------------------------------
// Event Fight Mirror — per-event stats cache keyed by watch_key
// ---------------------------------------------------------------------------

function parseEventFightMirrorRow(row) {
  if (!row) return null;
  return {
    watchKey: row.watch_key,
    eventId: row.event_id,
    fightId: row.fight_id,
    fighterA: row.fighter_a,
    fighterB: row.fighter_b,
    weightClass: row.weight_class || null,
    cardPosition: row.card_position === null || row.card_position === undefined ? null : Number(row.card_position),
    statsPack: parseJsonSafe(row.stats_pack_json, null),
    builtAt: row.built_at,
  };
}

function parseEventFighterMirrorRow(row) {
  if (!row) return null;
  return {
    watchKey: row.watch_key,
    eventId: row.event_id,
    fighterSlug: row.fighter_slug,
    fighterName: row.fighter_name,
    statsPack: parseJsonSafe(row.stats_pack_json, null),
    builtAt: row.built_at,
  };
}

export function upsertEventFightMirror(rows = [], watchKey = 'next_event') {
  if (!Array.isArray(rows) || !rows.length) return { upsertedCount: 0 };
  const db = getDb();
  const builtAt = nowIso();
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO event_fight_mirror
      (watch_key, event_id, fight_id, fighter_a, fighter_b, weight_class, card_position, stats_pack_json, built_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const upsertMany = db.transaction((items) => {
    for (const r of items) {
      stmt.run(
        String(watchKey),
        String(r.eventId || ''),
        String(r.fightId || ''),
        String(r.fighterA || ''),
        String(r.fighterB || ''),
        r.weightClass || null,
        r.cardPosition === null || r.cardPosition === undefined ? null : Number(r.cardPosition),
        r.statsPackJson != null ? JSON.stringify(r.statsPackJson) : null,
        builtAt
      );
    }
  });
  upsertMany(rows);
  return { upsertedCount: rows.length };
}

export function upsertEventFighterMirror(rows = [], watchKey = 'next_event') {
  if (!Array.isArray(rows) || !rows.length) return { upsertedCount: 0 };
  const db = getDb();
  const builtAt = nowIso();
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO event_fighter_mirror
      (watch_key, event_id, fighter_slug, fighter_name, stats_pack_json, built_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const upsertMany = db.transaction((items) => {
    for (const r of items) {
      stmt.run(
        String(watchKey),
        String(r.eventId || ''),
        String(r.fighterSlug || ''),
        String(r.fighterName || ''),
        r.statsPackJson != null ? JSON.stringify(r.statsPackJson) : null,
        builtAt
      );
    }
  });
  upsertMany(rows);
  return { upsertedCount: rows.length };
}

export function getEventFightMirror(watchKey = 'next_event') {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT watch_key, event_id, fight_id, fighter_a, fighter_b, weight_class, card_position, stats_pack_json, built_at
       FROM event_fight_mirror
       WHERE watch_key = ?
       ORDER BY card_position ASC`
    )
    .all(String(watchKey));
  return rows.map(parseEventFightMirrorRow).filter(Boolean);
}

export function getEventFighterMirror(watchKey = 'next_event') {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT watch_key, event_id, fighter_slug, fighter_name, stats_pack_json, built_at
       FROM event_fighter_mirror
       WHERE watch_key = ?`
    )
    .all(String(watchKey));
  return rows.map(parseEventFighterMirrorRow).filter(Boolean);
}

export function clearEventMirror(watchKey = 'next_event') {
  const db = getDb();
  const wk = String(watchKey);
  db.transaction(() => {
    db.prepare('DELETE FROM event_fight_mirror WHERE watch_key = ?').run(wk);
    db.prepare('DELETE FROM event_fighter_mirror WHERE watch_key = ?').run(wk);
  })();
}

export function getEventMirrorBuiltAt(watchKey = 'next_event') {
  const db = getDb();
  const row = db
    .prepare('SELECT MAX(built_at) AS max_built_at FROM event_fight_mirror WHERE watch_key = ?')
    .get(String(watchKey));
  return row?.max_built_at || null;
}
