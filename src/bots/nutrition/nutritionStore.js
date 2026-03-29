import crypto from 'node:crypto';
import { getDb } from '../../core/sqliteStore.js';

const STANDARD_FOOD_CATALOG = [
  {
    name: 'huevo',
    brand: '',
    portionG: 50,
    caloriesKcal: 78,
    proteinG: 6.3,
    carbsG: 0.6,
    fatG: 5.3,
    source: 'base_estandar',
  },
  {
    name: 'pechuga de pollo cocida',
    brand: '',
    portionG: 100,
    caloriesKcal: 165,
    proteinG: 31,
    carbsG: 0,
    fatG: 3.6,
    source: 'base_estandar',
  },
  {
    name: 'arroz cocido',
    brand: '',
    portionG: 100,
    caloriesKcal: 130,
    proteinG: 2.7,
    carbsG: 28,
    fatG: 0.3,
    source: 'base_estandar',
  },
  {
    name: 'avena',
    brand: '',
    portionG: 40,
    caloriesKcal: 150,
    proteinG: 5,
    carbsG: 27,
    fatG: 3,
    source: 'base_estandar',
  },
  {
    name: 'banana',
    brand: '',
    portionG: 120,
    caloriesKcal: 105,
    proteinG: 1.3,
    carbsG: 27,
    fatG: 0.4,
    source: 'base_estandar',
  },
  {
    name: 'manzana',
    brand: '',
    portionG: 180,
    caloriesKcal: 95,
    proteinG: 0.5,
    carbsG: 25,
    fatG: 0.3,
    source: 'base_estandar',
  },
  {
    name: 'yogur natural',
    brand: '',
    portionG: 170,
    caloriesKcal: 100,
    proteinG: 9,
    carbsG: 12,
    fatG: 3,
    source: 'base_estandar',
  },
  {
    name: 'pan integral',
    brand: '',
    portionG: 40,
    caloriesKcal: 100,
    proteinG: 4,
    carbsG: 19,
    fatG: 1.5,
    source: 'base_estandar',
  },
  {
    name: 'queso crema light',
    brand: '',
    portionG: 30,
    caloriesKcal: 60,
    proteinG: 3,
    carbsG: 2,
    fatG: 4,
    source: 'base_estandar',
  },
  {
    name: 'carne vacuna magra',
    brand: '',
    portionG: 100,
    caloriesKcal: 200,
    proteinG: 26,
    carbsG: 0,
    fatG: 10,
    source: 'base_estandar',
  },
  {
    name: 'papa cocida',
    brand: '',
    portionG: 100,
    caloriesKcal: 87,
    proteinG: 2,
    carbsG: 20,
    fatG: 0.1,
    source: 'base_estandar',
  },
  {
    name: 'pasta cocida',
    brand: '',
    portionG: 100,
    caloriesKcal: 157,
    proteinG: 5.8,
    carbsG: 30.9,
    fatG: 0.9,
    source: 'base_estandar',
  },
  {
    name: 'aceite de oliva',
    brand: '',
    portionG: 10,
    caloriesKcal: 90,
    proteinG: 0,
    carbsG: 0,
    fatG: 10,
    source: 'base_estandar',
  },
  {
    name: 'leche descremada',
    brand: '',
    portionG: 250,
    caloriesKcal: 90,
    proteinG: 8.5,
    carbsG: 12,
    fatG: 0.5,
    source: 'base_estandar',
  },
  {
    name: 'whey protein',
    brand: '',
    portionG: 30,
    caloriesKcal: 120,
    proteinG: 24,
    carbsG: 3,
    fatG: 2,
    source: 'base_estandar',
  },
];

function normalizeToken(value = '') {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

function toNumberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value = 0) {
  return Math.round((Number(value) || 0) * 100) / 100;
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

function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  const chunks = keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
  return `{${chunks.join(',')}}`;
}

function hashPayload(value) {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
}

function normalizeSourceMessageId(value = '') {
  const normalized = String(value || '').trim();
  if (!normalized) return '';
  return normalized;
}

function isValidLocalDate(value = '') {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '').trim());
}

function isValidLocalTime(value = '') {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || '').trim());
}

function isNonNegativeFinite(value) {
  return Number.isFinite(Number(value)) && Number(value) >= 0;
}

function withOperationReceipt({
  userId = '',
  operationType = '',
  sourceMessageId = '',
  payloadForHash = null,
  applyMutation,
} = {}) {
  const normalizedUserId = String(userId || '').trim();
  const normalizedOperationType = String(operationType || '').trim();
  const normalizedSourceMessageId = normalizeSourceMessageId(sourceMessageId);
  if (!normalizedUserId || !normalizedOperationType || !normalizedSourceMessageId) {
    const result = applyMutation?.();
    return {
      ok: true,
      idempotencyStatus: 'not_provided',
      ...result,
    };
  }

  const payloadHash = hashPayload(payloadForHash ?? {});
  const db = getDb();
  const run = db.transaction(() => {
    const existing = db
      .prepare(
        `
      SELECT id, payload_hash AS payloadHash, status, result_json AS resultJson
      FROM nutrition_operation_receipts
      WHERE telegram_user_id = ? AND operation_type = ? AND source_message_id = ?
    `
      )
      .get(normalizedUserId, normalizedOperationType, normalizedSourceMessageId);

    if (existing) {
      if (String(existing.status || '').toLowerCase() === 'committed') {
        const prior = parseJsonOrNull(existing.resultJson);
        return {
          ok: true,
          idempotencyStatus:
            String(existing.payloadHash || '') && existing.payloadHash !== payloadHash
              ? 'replayed_payload_mismatch'
              : 'replayed',
          ...(prior && typeof prior === 'object' ? prior : {}),
        };
      }
      return {
        ok: false,
        error: 'idempotency_in_progress',
        idempotencyStatus: 'pending',
      };
    }

    const nowIso = new Date().toISOString();
    db.prepare(
      `
      INSERT INTO nutrition_operation_receipts (
        telegram_user_id, operation_type, source_message_id, payload_hash,
        status, result_json, error_code, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
    ).run(
      normalizedUserId,
      normalizedOperationType,
      normalizedSourceMessageId,
      payloadHash,
      'pending',
      null,
      null,
      nowIso,
      nowIso
    );

    const result = applyMutation?.() || {};
    db.prepare(
      `
      UPDATE nutrition_operation_receipts
      SET status = ?, result_json = ?, error_code = ?, updated_at = ?
      WHERE telegram_user_id = ? AND operation_type = ? AND source_message_id = ?
    `
    ).run(
      'committed',
      JSON.stringify(result),
      null,
      new Date().toISOString(),
      normalizedUserId,
      normalizedOperationType,
      normalizedSourceMessageId
    );

    return {
      ok: true,
      idempotencyStatus: 'new',
      ...result,
    };
  });

  return run();
}

function shiftIsoDate(isoDate = '', deltaDays = 0) {
  if (!isoDate) return '';
  const date = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return '';
  date.setUTCDate(date.getUTCDate() + Number(deltaDays || 0));
  return date.toISOString().slice(0, 10);
}

let initialized = false;

export function ensureNutritionSchema() {
  if (initialized) return;
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS nutrition_profiles (
      telegram_user_id TEXT PRIMARY KEY,
      timezone TEXT,
      main_goal TEXT,
      target_calories_kcal REAL,
      target_protein_g REAL,
      notes TEXT,
      restrictions TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS nutrition_intakes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_user_id TEXT NOT NULL,
      logged_at TEXT NOT NULL,
      local_date TEXT NOT NULL,
      local_time TEXT NOT NULL,
      timezone TEXT NOT NULL,
      meal_type TEXT,
      food_item TEXT NOT NULL,
      quantity_value REAL,
      quantity_unit TEXT,
      brand_or_notes TEXT,
      calories_kcal REAL NOT NULL,
      protein_g REAL NOT NULL,
      carbs_g REAL NOT NULL,
      fat_g REAL NOT NULL,
      confidence TEXT,
      source TEXT,
      raw_input TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_nutrition_intakes_user_date
      ON nutrition_intakes (telegram_user_id, local_date);
    CREATE INDEX IF NOT EXISTS idx_nutrition_intakes_user_logged
      ON nutrition_intakes (telegram_user_id, logged_at);

    CREATE TABLE IF NOT EXISTS nutrition_weighins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_user_id TEXT NOT NULL,
      logged_at TEXT NOT NULL,
      local_date TEXT NOT NULL,
      local_time TEXT NOT NULL,
      timezone TEXT NOT NULL,
      weight_kg REAL NOT NULL,
      body_fat_percent REAL,
      visceral_fat REAL,
      muscle_mass_kg REAL,
      body_water_percent REAL,
      bmr_kcal REAL,
      bone_mass_kg REAL,
      notes TEXT,
      raw_input TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_nutrition_weighins_user_date
      ON nutrition_weighins (telegram_user_id, local_date);

    CREATE TABLE IF NOT EXISTS nutrition_food_catalog (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_name TEXT NOT NULL,
      brand TEXT,
      normalized_name TEXT NOT NULL,
      normalized_brand TEXT NOT NULL,
      portion_g REAL NOT NULL,
      calories_kcal REAL NOT NULL,
      protein_g REAL NOT NULL,
      carbs_g REAL NOT NULL,
      fat_g REAL NOT NULL,
      fiber_g REAL,
      sodium_mg REAL,
      source TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS uniq_nutrition_food_catalog_norm
      ON nutrition_food_catalog (normalized_name, normalized_brand);

    CREATE TABLE IF NOT EXISTS nutrition_journal (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_user_id TEXT NOT NULL,
      local_date TEXT NOT NULL,
      local_time TEXT NOT NULL,
      event TEXT NOT NULL,
      notes TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_nutrition_journal_user_date
      ON nutrition_journal (telegram_user_id, local_date);

    CREATE TABLE IF NOT EXISTS nutrition_user_state (
      telegram_user_id TEXT PRIMARY KEY,
      active_module TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS nutrition_operation_receipts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_user_id TEXT NOT NULL,
      operation_type TEXT NOT NULL,
      source_message_id TEXT NOT NULL,
      payload_hash TEXT,
      status TEXT NOT NULL,
      result_json TEXT,
      error_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (telegram_user_id, operation_type, source_message_id)
    );

    CREATE INDEX IF NOT EXISTS idx_nutrition_receipts_user_time
      ON nutrition_operation_receipts (telegram_user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS nutrition_usage_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_user_id TEXT NOT NULL,
      guided_action TEXT,
      model TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      total_tokens INTEGER,
      reasoning_tokens INTEGER,
      cached_tokens INTEGER,
      created_at TEXT NOT NULL,
      raw_usage_json TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_nutrition_usage_user_time
      ON nutrition_usage_records (telegram_user_id, created_at DESC);
  `);

  const seedStmt = db.prepare(`
    INSERT INTO nutrition_food_catalog (
      product_name, brand, normalized_name, normalized_brand, portion_g,
      calories_kcal, protein_g, carbs_g, fat_g, source, created_at, updated_at
    ) VALUES (
      @product_name, @brand, @normalized_name, @normalized_brand, @portion_g,
      @calories_kcal, @protein_g, @carbs_g, @fat_g, @source, @created_at, @updated_at
    )
    ON CONFLICT(normalized_name, normalized_brand) DO NOTHING
  `);

  const nowIso = new Date().toISOString();
  for (const entry of STANDARD_FOOD_CATALOG) {
    seedStmt.run({
      product_name: entry.name,
      brand: entry.brand || null,
      normalized_name: normalizeToken(entry.name),
      normalized_brand: normalizeToken(entry.brand || ''),
      portion_g: entry.portionG,
      calories_kcal: entry.caloriesKcal,
      protein_g: entry.proteinG,
      carbs_g: entry.carbsG,
      fat_g: entry.fatG,
      source: entry.source || 'base_estandar',
      created_at: nowIso,
      updated_at: nowIso,
    });
  }

  initialized = true;
}

export function getNutritionProfile(userId = '') {
  ensureNutritionSchema();
  return (
    getDb()
      .prepare(
        `
      SELECT
        telegram_user_id AS userId,
        timezone,
        main_goal AS mainGoal,
        target_calories_kcal AS targetCaloriesKcal,
        target_protein_g AS targetProteinG,
        notes,
        restrictions,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM nutrition_profiles
      WHERE telegram_user_id = ?
    `
      )
      .get(String(userId || '').trim()) || null
  );
}

export function upsertNutritionProfile(userId = '', updates = {}, options = {}) {
  ensureNutritionSchema();
  const normalizedUserId = String(userId || '').trim();
  if (!normalizedUserId) {
    return { ok: false, error: 'missing_user_id' };
  }

  const existing = getNutritionProfile(normalizedUserId);
  const nowIso = new Date().toISOString();
  const payload = {
    userId: normalizedUserId,
    timezone: String(updates.timezone ?? existing?.timezone ?? '').trim() || null,
    mainGoal: String(updates.mainGoal ?? existing?.mainGoal ?? '').trim() || null,
    targetCaloriesKcal: toNumberOrNull(
      updates.targetCaloriesKcal ?? existing?.targetCaloriesKcal ?? null
    ),
    targetProteinG: toNumberOrNull(updates.targetProteinG ?? existing?.targetProteinG ?? null),
    notes: String(updates.notes ?? existing?.notes ?? '').trim() || null,
    restrictions: String(updates.restrictions ?? existing?.restrictions ?? '').trim() || null,
    createdAt: existing?.createdAt || nowIso,
    updatedAt: nowIso,
  };

  const mutationResult = withOperationReceipt({
    userId: normalizedUserId,
    operationType: String(options?.idempotency?.operationType || 'upsert_profile'),
    sourceMessageId: options?.idempotency?.sourceMessageId,
    payloadForHash: {
      payload,
      operationType: 'upsert_profile',
    },
    applyMutation: () => {
      getDb()
        .prepare(
          `
        INSERT INTO nutrition_profiles (
          telegram_user_id, timezone, main_goal, target_calories_kcal, target_protein_g,
          notes, restrictions, created_at, updated_at
        ) VALUES (
          @userId, @timezone, @mainGoal, @targetCaloriesKcal, @targetProteinG,
          @notes, @restrictions, @createdAt, @updatedAt
        )
        ON CONFLICT(telegram_user_id) DO UPDATE SET
          timezone = excluded.timezone,
          main_goal = excluded.main_goal,
          target_calories_kcal = excluded.target_calories_kcal,
          target_protein_g = excluded.target_protein_g,
          notes = excluded.notes,
          restrictions = excluded.restrictions,
          updated_at = excluded.updated_at
      `
        )
        .run(payload);

      return {
        profile: getNutritionProfile(normalizedUserId),
      };
    },
  });

  if (!mutationResult?.ok) {
    return mutationResult;
  }

  return {
    ok: true,
    idempotencyStatus: mutationResult.idempotencyStatus || null,
    profile: mutationResult.profile || getNutritionProfile(normalizedUserId),
  };
}

export function setNutritionUserState(userId = '', activeModule = 'ingesta') {
  ensureNutritionSchema();
  const normalizedUserId = String(userId || '').trim();
  if (!normalizedUserId) {
    return { ok: false, error: 'missing_user_id' };
  }
  const normalizedModule = String(activeModule || '').trim() || 'ingesta';
  const nowIso = new Date().toISOString();
  getDb()
    .prepare(
      `
    INSERT INTO nutrition_user_state (telegram_user_id, active_module, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(telegram_user_id) DO UPDATE SET
      active_module = excluded.active_module,
      updated_at = excluded.updated_at
  `
    )
    .run(normalizedUserId, normalizedModule, nowIso);
  return { ok: true, activeModule: normalizedModule, updatedAt: nowIso };
}

export function getNutritionUserState(userId = '') {
  ensureNutritionSchema();
  return (
    getDb()
      .prepare(
        `
      SELECT
        telegram_user_id AS userId,
        active_module AS activeModule,
        updated_at AS updatedAt
      FROM nutrition_user_state
      WHERE telegram_user_id = ?
    `
      )
      .get(String(userId || '').trim()) || null
  );
}

export function upsertFoodCatalogEntry(entry = {}, options = {}) {
  ensureNutritionSchema();
  const productName = String(entry.productName || '').trim();
  if (!productName) {
    return { ok: false, error: 'missing_product_name' };
  }

  const brand = String(entry.brand || '').trim();
  const normalizedName = normalizeToken(productName);
  const normalizedBrand = normalizeToken(brand);
  const portionG = toNumberOrNull(entry.portionG);
  const caloriesKcal = toNumberOrNull(entry.caloriesKcal);
  const proteinG = toNumberOrNull(entry.proteinG);
  const carbsG = toNumberOrNull(entry.carbsG);
  const fatG = toNumberOrNull(entry.fatG);
  if (
    !portionG ||
    caloriesKcal === null ||
    proteinG === null ||
    carbsG === null ||
    fatG === null
  ) {
    return { ok: false, error: 'invalid_macros' };
  }

  const nowIso = new Date().toISOString();
  const payload = {
    productName,
    brand: brand || null,
    normalizedName,
    normalizedBrand,
    portionG,
    caloriesKcal,
    proteinG,
    carbsG,
    fatG,
    fiberG: toNumberOrNull(entry.fiberG),
    sodiumMg: toNumberOrNull(entry.sodiumMg),
    source: String(entry.source || 'manual').trim(),
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  const receiptUserId =
    String(options?.idempotency?.userId || options?.userId || '').trim() || 'global_catalog';
  const mutationResult = withOperationReceipt({
    userId: receiptUserId,
    operationType: String(options?.idempotency?.operationType || 'upsert_food_catalog'),
    sourceMessageId: options?.idempotency?.sourceMessageId,
    payloadForHash: payload,
    applyMutation: () => {
      getDb()
        .prepare(
          `
        INSERT INTO nutrition_food_catalog (
          product_name, brand, normalized_name, normalized_brand, portion_g,
          calories_kcal, protein_g, carbs_g, fat_g, fiber_g, sodium_mg, source, created_at, updated_at
        ) VALUES (
          @productName, @brand, @normalizedName, @normalizedBrand, @portionG,
          @caloriesKcal, @proteinG, @carbsG, @fatG, @fiberG, @sodiumMg, @source, @createdAt, @updatedAt
        )
        ON CONFLICT(normalized_name, normalized_brand) DO UPDATE SET
          portion_g = excluded.portion_g,
          calories_kcal = excluded.calories_kcal,
          protein_g = excluded.protein_g,
          carbs_g = excluded.carbs_g,
          fat_g = excluded.fat_g,
          fiber_g = excluded.fiber_g,
          sodium_mg = excluded.sodium_mg,
          source = excluded.source,
          updated_at = excluded.updated_at
      `
        )
        .run(payload);

      return {
        normalizedName,
        normalizedBrand,
      };
    },
  });

  if (!mutationResult?.ok) {
    return mutationResult;
  }

  return {
    ok: true,
    idempotencyStatus: mutationResult.idempotencyStatus || null,
  };
}

export function listFoodCatalogEntries() {
  ensureNutritionSchema();
  return getDb()
    .prepare(
      `
    SELECT
      id,
      product_name AS productName,
      brand,
      normalized_name AS normalizedName,
      normalized_brand AS normalizedBrand,
      portion_g AS portionG,
      calories_kcal AS caloriesKcal,
      protein_g AS proteinG,
      carbs_g AS carbsG,
      fat_g AS fatG,
      fiber_g AS fiberG,
      sodium_mg AS sodiumMg,
      source
    FROM nutrition_food_catalog
    ORDER BY updated_at DESC, id DESC
    LIMIT 800
  `
    )
    .all();
}

export function addNutritionIntakes(userId = '', payload = {}, options = {}) {
  ensureNutritionSchema();
  const normalizedUserId = String(userId || '').trim();
  const items = Array.isArray(payload.items) ? payload.items : [];
  if (!normalizedUserId || !items.length) {
    return { ok: false, error: 'missing_payload' };
  }
  const localDate = String(payload.localDate || '').trim();
  const localTime = String(payload.localTime || '').trim();
  const timezone = String(payload.timezone || '').trim();
  const loggedAt = String(payload.loggedAt || new Date().toISOString());
  if (!isValidLocalDate(localDate) || !isValidLocalTime(localTime) || !timezone) {
    return { ok: false, error: 'invalid_temporal_payload' };
  }

  const sanitizedRows = [];
  for (const row of items) {
    const foodItem = String(row?.foodItem || '').trim();
    if (!foodItem) {
      return { ok: false, error: 'invalid_item_payload' };
    }

    const caloriesKcal = round(row?.caloriesKcal);
    const proteinG = round(row?.proteinG);
    const carbsG = round(row?.carbsG);
    const fatG = round(row?.fatG);
    if (
      !isNonNegativeFinite(caloriesKcal) ||
      !isNonNegativeFinite(proteinG) ||
      !isNonNegativeFinite(carbsG) ||
      !isNonNegativeFinite(fatG)
    ) {
      return { ok: false, error: 'invalid_macros_payload' };
    }

    sanitizedRows.push({
      mealType: row?.mealType || null,
      foodItem,
      quantityValue: toNumberOrNull(row?.quantityValue),
      quantityUnit: String(row?.quantityUnit || '').trim() || null,
      brandOrNotes: String(row?.brandOrNotes || '').trim() || null,
      caloriesKcal,
      proteinG,
      carbsG,
      fatG,
      confidence: String(row?.confidence || 'media').trim() || 'media',
      source: String(row?.source || 'base_estandar').trim() || 'base_estandar',
    });
  }

  const stmt = getDb().prepare(`
    INSERT INTO nutrition_intakes (
      telegram_user_id, logged_at, local_date, local_time, timezone, meal_type, food_item,
      quantity_value, quantity_unit, brand_or_notes, calories_kcal, protein_g, carbs_g, fat_g,
      confidence, source, raw_input, created_at
    ) VALUES (
      @userId, @loggedAt, @localDate, @localTime, @timezone, @mealType, @foodItem,
      @quantityValue, @quantityUnit, @brandOrNotes, @caloriesKcal, @proteinG, @carbsG, @fatG,
      @confidence, @source, @rawInput, @createdAt
    )
  `);

  const transaction = getDb().transaction((rows) => {
    let inserted = 0;
    for (const row of rows) {
      const result = stmt.run({
        userId: normalizedUserId,
        loggedAt,
        localDate,
        localTime,
        timezone,
        mealType: row.mealType || null,
        foodItem: String(row.foodItem || '').trim(),
        quantityValue: toNumberOrNull(row.quantityValue),
        quantityUnit: String(row.quantityUnit || '').trim() || null,
        brandOrNotes: String(row.brandOrNotes || '').trim() || null,
        caloriesKcal: row.caloriesKcal,
        proteinG: row.proteinG,
        carbsG: row.carbsG,
        fatG: row.fatG,
        confidence: String(row.confidence || 'media').trim() || 'media',
        source: String(row.source || 'base_estandar').trim() || 'base_estandar',
        rawInput: String(payload.rawInput || '').trim() || null,
        createdAt: new Date().toISOString(),
      });
      inserted += Number(result?.changes) || 0;
    }
    if (inserted !== rows.length) {
      throw new Error('insert_count_mismatch');
    }
    return inserted;
  });

  const mutationResult = withOperationReceipt({
    userId: normalizedUserId,
    operationType: String(options?.idempotency?.operationType || 'add_intakes'),
    sourceMessageId: options?.idempotency?.sourceMessageId,
    payloadForHash: {
      userId: normalizedUserId,
      loggedAt,
      localDate,
      localTime,
      timezone,
      rawInput: String(payload.rawInput || '').trim() || '',
      items: sanitizedRows,
    },
    applyMutation: () => {
      const insertedCount = transaction(sanitizedRows);
      return { insertedCount };
    },
  });

  if (!mutationResult?.ok) {
    return mutationResult;
  }

  return {
    ok: true,
    idempotencyStatus: mutationResult.idempotencyStatus || null,
    insertedCount: Number(mutationResult.insertedCount) || 0,
  };
}

export function addNutritionWeighin(userId = '', weighin = {}, options = {}) {
  ensureNutritionSchema();
  const normalizedUserId = String(userId || '').trim();
  const weightKg = toNumberOrNull(weighin.weightKg);
  if (!normalizedUserId || !weightKg) {
    return { ok: false, error: 'missing_weight' };
  }
  const localDate = String(weighin.localDate || '').trim();
  const localTime = String(weighin.localTime || '').trim();
  const timezone = String(weighin.timezone || '').trim();
  const loggedAt = String(weighin.loggedAt || new Date().toISOString());
  if (!isValidLocalDate(localDate) || !isValidLocalTime(localTime) || !timezone) {
    return { ok: false, error: 'invalid_temporal_payload' };
  }

  const numericOptionals = {
    bodyFatPercent: toNumberOrNull(weighin.bodyFatPercent),
    visceralFat: toNumberOrNull(weighin.visceralFat),
    muscleMassKg: toNumberOrNull(weighin.muscleMassKg),
    bodyWaterPercent: toNumberOrNull(weighin.bodyWaterPercent),
    bmrKcal: toNumberOrNull(weighin.bmrKcal),
    boneMassKg: toNumberOrNull(weighin.boneMassKg),
  };
  for (const value of Object.values(numericOptionals)) {
    if (value !== null && !isNonNegativeFinite(value)) {
      return { ok: false, error: 'invalid_weighin_payload' };
    }
  }

  const payload = {
    userId: normalizedUserId,
    loggedAt,
    localDate,
    localTime,
    timezone,
    weightKg,
    ...numericOptionals,
    notes: String(weighin.notes || '').trim() || null,
    rawInput: String(weighin.rawInput || '').trim() || null,
  };

  const mutationResult = withOperationReceipt({
    userId: normalizedUserId,
    operationType: String(options?.idempotency?.operationType || 'add_weighin'),
    sourceMessageId: options?.idempotency?.sourceMessageId,
    payloadForHash: payload,
    applyMutation: () => {
      const result = getDb()
        .prepare(
          `
        INSERT INTO nutrition_weighins (
          telegram_user_id, logged_at, local_date, local_time, timezone, weight_kg,
          body_fat_percent, visceral_fat, muscle_mass_kg, body_water_percent,
          bmr_kcal, bone_mass_kg, notes, raw_input, created_at
        ) VALUES (
          @userId, @loggedAt, @localDate, @localTime, @timezone, @weightKg,
          @bodyFatPercent, @visceralFat, @muscleMassKg, @bodyWaterPercent,
          @bmrKcal, @boneMassKg, @notes, @rawInput, @createdAt
        )
      `
        )
        .run({
          ...payload,
          createdAt: new Date().toISOString(),
        });

      if ((Number(result?.changes) || 0) !== 1) {
        throw new Error('insert_count_mismatch');
      }

      return { inserted: true };
    },
  });

  if (!mutationResult?.ok) {
    return mutationResult;
  }

  return {
    ok: true,
    idempotencyStatus: mutationResult.idempotencyStatus || null,
  };
}

export function addNutritionUsageRecord(userId = '', payload = {}) {
  ensureNutritionSchema();
  const normalizedUserId = String(userId || '').trim();
  if (!normalizedUserId) {
    return { ok: false, error: 'missing_user_id' };
  }

  const toIntOrNull = (value) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) return null;
    return Math.round(parsed);
  };

  getDb()
    .prepare(
      `
    INSERT INTO nutrition_usage_records (
      telegram_user_id, guided_action, model, input_tokens, output_tokens, total_tokens,
      reasoning_tokens, cached_tokens, created_at, raw_usage_json
    ) VALUES (
      @userId, @guidedAction, @model, @inputTokens, @outputTokens, @totalTokens,
      @reasoningTokens, @cachedTokens, @createdAt, @rawUsageJson
    )
  `
    )
    .run({
      userId: normalizedUserId,
      guidedAction: String(payload.guidedAction || '').trim() || null,
      model: String(payload.model || '').trim() || null,
      inputTokens: toIntOrNull(payload.inputTokens),
      outputTokens: toIntOrNull(payload.outputTokens),
      totalTokens: toIntOrNull(payload.totalTokens),
      reasoningTokens: toIntOrNull(payload.reasoningTokens),
      cachedTokens: toIntOrNull(payload.cachedTokens),
      createdAt: new Date().toISOString(),
      rawUsageJson: payload.rawUsage ? JSON.stringify(payload.rawUsage) : null,
    });

  return { ok: true };
}

export function appendNutritionJournal(userId = '', entry = {}) {
  ensureNutritionSchema();
  const normalizedUserId = String(userId || '').trim();
  if (!normalizedUserId) return { ok: false, error: 'missing_user_id' };
  const localDate = String(entry.localDate || '').trim();
  const localTime = String(entry.localTime || '').trim();
  const event = String(entry.event || '').trim();
  if (!localDate || !localTime || !event) return { ok: false, error: 'invalid_entry' };

  getDb()
    .prepare(
      `
    INSERT INTO nutrition_journal (
      telegram_user_id, local_date, local_time, event, notes, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `
    )
    .run(
      normalizedUserId,
      localDate,
      localTime,
      event,
      String(entry.notes || '').trim() || null,
      new Date().toISOString()
    );

  return { ok: true };
}

export function getDailyNutritionTotals(userId = '', localDate = '') {
  ensureNutritionSchema();
  const row =
    getDb()
      .prepare(
        `
      SELECT
        COALESCE(SUM(calories_kcal), 0) AS caloriesKcal,
        COALESCE(SUM(protein_g), 0) AS proteinG,
        COALESCE(SUM(carbs_g), 0) AS carbsG,
        COALESCE(SUM(fat_g), 0) AS fatG,
        COUNT(*) AS itemsCount
      FROM nutrition_intakes
      WHERE telegram_user_id = ? AND local_date = ?
    `
      )
      .get(String(userId || '').trim(), String(localDate || '').trim()) || {};

  return {
    caloriesKcal: round(row.caloriesKcal),
    proteinG: round(row.proteinG),
    carbsG: round(row.carbsG),
    fatG: round(row.fatG),
    itemsCount: Number(row.itemsCount) || 0,
  };
}

function computeRollingAverages(rows = []) {
  if (!Array.isArray(rows) || !rows.length) {
    return {
      caloriesKcal: 0,
      proteinG: 0,
      carbsG: 0,
      fatG: 0,
      daysWithData: 0,
    };
  }
  const totals = rows.reduce(
    (acc, row) => ({
      caloriesKcal: acc.caloriesKcal + (Number(row.caloriesKcal) || 0),
      proteinG: acc.proteinG + (Number(row.proteinG) || 0),
      carbsG: acc.carbsG + (Number(row.carbsG) || 0),
      fatG: acc.fatG + (Number(row.fatG) || 0),
    }),
    { caloriesKcal: 0, proteinG: 0, carbsG: 0, fatG: 0 }
  );
  const days = rows.length;
  return {
    caloriesKcal: round(totals.caloriesKcal / days),
    proteinG: round(totals.proteinG / days),
    carbsG: round(totals.carbsG / days),
    fatG: round(totals.fatG / days),
    daysWithData: days,
  };
}

export function getRollingNutritionAverages(userId = '', localDate = '', days = 7) {
  ensureNutritionSchema();
  const normalizedDays = Math.max(1, Number(days) || 1);
  const normalizedLocalDate = String(localDate || '').trim();
  const fromDate = shiftIsoDate(normalizedLocalDate, -(normalizedDays - 1));
  if (!fromDate || !normalizedLocalDate) {
    return {
      caloriesKcal: 0,
      proteinG: 0,
      carbsG: 0,
      fatG: 0,
      daysWithData: 0,
    };
  }

  const rows = getDb()
    .prepare(
      `
    SELECT
      local_date AS localDate,
      COALESCE(SUM(calories_kcal), 0) AS caloriesKcal,
      COALESCE(SUM(protein_g), 0) AS proteinG,
      COALESCE(SUM(carbs_g), 0) AS carbsG,
      COALESCE(SUM(fat_g), 0) AS fatG
    FROM nutrition_intakes
    WHERE telegram_user_id = ? AND local_date BETWEEN ? AND ?
    GROUP BY local_date
    ORDER BY local_date ASC
  `
    )
    .all(String(userId || '').trim(), fromDate, normalizedLocalDate);

  return computeRollingAverages(rows);
}

export function getLatestNutritionWeighin(userId = '') {
  ensureNutritionSchema();
  return (
    getDb()
      .prepare(
        `
      SELECT
        id,
        logged_at AS loggedAt,
        local_date AS localDate,
        local_time AS localTime,
        timezone,
        weight_kg AS weightKg,
        body_fat_percent AS bodyFatPercent,
        visceral_fat AS visceralFat,
        muscle_mass_kg AS muscleMassKg,
        body_water_percent AS bodyWaterPercent,
        bmr_kcal AS bmrKcal,
        bone_mass_kg AS boneMassKg,
        notes
      FROM nutrition_weighins
      WHERE telegram_user_id = ?
      ORDER BY logged_at DESC, id DESC
      LIMIT 1
    `
      )
      .get(String(userId || '').trim()) || null
  );
}

export function listNutritionIntakesByDate(userId = '', localDate = '', { limit = 80 } = {}) {
  ensureNutritionSchema();
  const normalizedUserId = String(userId || '').trim();
  const normalizedDate = String(localDate || '').trim();
  if (!normalizedUserId || !normalizedDate) return [];

  return getDb()
    .prepare(
      `
    SELECT
      id,
      logged_at AS loggedAt,
      local_date AS localDate,
      local_time AS localTime,
      food_item AS foodItem,
      quantity_value AS quantityValue,
      quantity_unit AS quantityUnit,
      calories_kcal AS caloriesKcal,
      protein_g AS proteinG,
      carbs_g AS carbsG,
      fat_g AS fatG,
      source
    FROM nutrition_intakes
    WHERE telegram_user_id = ? AND local_date = ?
    ORDER BY logged_at DESC, id DESC
    LIMIT ?
  `
    )
    .all(normalizedUserId, normalizedDate, Math.max(1, Number(limit) || 80));
}

export function listRecentNutritionIntakes(userId = '', { limit = 20 } = {}) {
  ensureNutritionSchema();
  const normalizedUserId = String(userId || '').trim();
  if (!normalizedUserId) return [];

  return getDb()
    .prepare(
      `
    SELECT
      id,
      logged_at AS loggedAt,
      local_date AS localDate,
      local_time AS localTime,
      food_item AS foodItem,
      quantity_value AS quantityValue,
      quantity_unit AS quantityUnit,
      calories_kcal AS caloriesKcal,
      protein_g AS proteinG,
      carbs_g AS carbsG,
      fat_g AS fatG,
      source
    FROM nutrition_intakes
    WHERE telegram_user_id = ?
    ORDER BY logged_at DESC, id DESC
    LIMIT ?
  `
    )
    .all(normalizedUserId, Math.max(1, Number(limit) || 20));
}

export function findFoodCatalogCandidates(query = '', { limit = 25 } = {}) {
  ensureNutritionSchema();
  const normalizedQuery = normalizeToken(query);
  if (!normalizedQuery) return [];
  const rows = getDb()
    .prepare(
      `
    SELECT
      id,
      product_name AS productName,
      brand,
      normalized_name AS normalizedName,
      normalized_brand AS normalizedBrand,
      portion_g AS portionG,
      calories_kcal AS caloriesKcal,
      protein_g AS proteinG,
      carbs_g AS carbsG,
      fat_g AS fatG,
      source
    FROM nutrition_food_catalog
    WHERE normalized_name LIKE ? OR normalized_brand LIKE ?
    ORDER BY updated_at DESC, id DESC
    LIMIT ?
  `
    )
    .all(`%${normalizedQuery}%`, `%${normalizedQuery}%`, Math.max(1, Number(limit) || 25));

  return rows;
}

export function getNutritionSummary(userId = '', localDate = '') {
  const today = getDailyNutritionTotals(userId, localDate);
  const rolling7d = getRollingNutritionAverages(userId, localDate, 7);
  const rolling14d = getRollingNutritionAverages(userId, localDate, 14);
  return {
    today,
    rolling7d,
    rolling14d,
  };
}

export function calculateProfileStatus(profile = {}, totals = {}) {
  const targetCalories = toNumberOrNull(profile?.targetCaloriesKcal);
  const targetProtein = toNumberOrNull(profile?.targetProteinG);
  if (!targetCalories && !targetProtein) {
    return 'sin objetivo configurado';
  }

  const calories = Number(totals?.caloriesKcal) || 0;
  const protein = Number(totals?.proteinG) || 0;
  const calorieRatio = targetCalories ? calories / targetCalories : 1;
  const proteinRatio = targetProtein ? protein / targetProtein : 1;

  if (calorieRatio >= 0.9 && calorieRatio <= 1.1 && proteinRatio >= 0.9) {
    return 'bien';
  }
  if (calorieRatio >= 0.8 && calorieRatio <= 1.25 && proteinRatio >= 0.75) {
    return 'mas o menos';
  }
  return 'desalineado';
}

export function toCatalogNormalizedToken(value = '') {
  return normalizeToken(value);
}
