import fs from 'node:fs';
import path from 'node:path';
import '../core/env.js';
import { getDb, getDbPath } from '../core/sqliteStore.js';
import {
  ensureNutritionSchema,
  upsertFoodCatalogEntry,
  upsertNutritionProfile,
} from '../bots/nutrition/nutritionStore.js';

const DEFAULT_TIMEZONE = process.env.DEFAULT_USER_TIMEZONE || 'America/Argentina/Buenos_Aires';

function parseArgs(argv = []) {
  const out = {
    userId: '',
    knowledgeDir: 'Knowledge',
    timezone: DEFAULT_TIMEZONE,
    dryRun: false,
    resetUser: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i] || '').trim();
    if (!arg) continue;
    if (arg === '--dry-run') {
      out.dryRun = true;
      continue;
    }
    if (arg === '--reset-user') {
      out.resetUser = true;
      continue;
    }
    if (arg === '--user-id') {
      out.userId = String(argv[i + 1] || '').trim();
      i += 1;
      continue;
    }
    if (arg === '--knowledge-dir') {
      out.knowledgeDir = String(argv[i + 1] || '').trim() || out.knowledgeDir;
      i += 1;
      continue;
    }
    if (arg === '--timezone') {
      out.timezone = String(argv[i + 1] || '').trim() || out.timezone;
      i += 1;
      continue;
    }
  }

  return out;
}

function parseCsv(text = '') {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
          continue;
        }
        inQuotes = false;
        continue;
      }
      field += ch;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      continue;
    }
    if (ch === '\n') {
      row.push(field);
      field = '';
      if (row.length && !(row.length === 1 && row[0] === '')) {
        rows.push(row);
      }
      row = [];
      continue;
    }
    if (ch === '\r') {
      continue;
    }
    field += ch;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function readCsvRows(filePath = '') {
  const resolved = path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`No existe CSV: ${resolved}`);
  }
  const text = fs.readFileSync(resolved, 'utf8');
  const rows = parseCsv(text);
  return rows.slice(1);
}

function clean(value = '') {
  return String(value || '').trim();
}

function normalizeText(value = '') {
  return clean(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function isIsoDate(value = '') {
  return /^\d{4}-\d{2}-\d{2}$/.test(clean(value));
}

function isTime(value = '') {
  return /^([01]?\d|2[0-3]):([0-5]\d)$/.test(clean(value));
}

function normalizeTime(raw = '', fallback = '12:00') {
  const value = clean(raw);
  if (isTime(value)) {
    const [h, m] = value.split(':');
    return `${h.padStart(2, '0')}:${m}`;
  }
  return fallback;
}

function parseNumber(value = '') {
  const text = clean(value);
  if (!text) return null;
  const match = text.replace(/\s+/g, '').match(/-?\d+(?:[.,]\d+)?/);
  if (!match) return null;
  const parsed = Number(match[0].replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

function extractNumbers(values = []) {
  return values
    .map((value) => parseNumber(value))
    .filter((value) => Number.isFinite(value));
}

function clampOrNull(value, min = -Infinity, max = Infinity) {
  if (!Number.isFinite(value)) return null;
  if (value < min || value > max) return null;
  return value;
}

function normalizeTimeZone(value = '', fallback = DEFAULT_TIMEZONE) {
  const candidate = clean(value) || fallback;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate }).format(new Date());
    return candidate;
  } catch {
    return fallback;
  }
}

function formatInTimeZone(date = new Date(), timeZone = DEFAULT_TIMEZONE) {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = dtf.formatToParts(date);
  const pick = (type) => parts.find((part) => part.type === type)?.value || '';
  return {
    year: Number(pick('year')),
    month: Number(pick('month')),
    day: Number(pick('day')),
    hour: Number(pick('hour')),
    minute: Number(pick('minute')),
    second: Number(pick('second')),
  };
}

function toUtcIsoFromLocal({ localDate = '', localTime = '12:00', timeZone = DEFAULT_TIMEZONE } = {}) {
  if (!isIsoDate(localDate) || !isTime(localTime)) {
    return new Date().toISOString();
  }
  const [yearRaw, monthRaw, dayRaw] = localDate.split('-');
  const [hourRaw, minuteRaw] = localTime.split(':');
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  const second = 0;

  const safeTz = normalizeTimeZone(timeZone);
  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, second, 0));
  const zoned = formatInTimeZone(utcGuess, safeTz);
  const targetAsUtcMs = Date.UTC(year, month - 1, day, hour, minute, second, 0);
  const zonedAsUtcMs = Date.UTC(
    zoned.year,
    zoned.month - 1,
    zoned.day,
    zoned.hour,
    zoned.minute,
    zoned.second,
    0
  );
  const corrected = new Date(utcGuess.getTime() + (targetAsUtcMs - zonedAsUtcMs));
  return corrected.toISOString();
}

function isMealToken(value = '') {
  const token = normalizeText(value);
  return ['desayuno', 'almuerzo', 'cena', 'snack', 'postre', 'merienda'].includes(token);
}

function defaultTimeForMeal(mealType = '') {
  const token = normalizeText(mealType);
  if (token === 'desayuno') return '09:00';
  if (token === 'almuerzo') return '13:00';
  if (token === 'cena') return '21:00';
  if (token === 'merienda') return '17:00';
  if (token === 'snack') return '17:30';
  if (token === 'postre') return '22:30';
  return '12:00';
}

function extractConfidence(values = []) {
  for (const value of values) {
    const token = normalizeText(value);
    if (token === 'alta' || token === 'media' || token === 'baja') {
      return token;
    }
  }
  return 'media';
}

function extractSource(values = []) {
  for (const value of values) {
    const token = normalizeText(value);
    if (!token) continue;
    if (token.includes('etiqueta')) return 'etiqueta';
    if (token.includes('online') || token.includes('busqueda')) return 'busqueda_online';
    if (token.includes('visual') || token.includes('estimacion')) return 'estimacion_visual';
    if (token.includes('base')) return 'base_estandar';
  }
  return 'legacy_csv_import';
}

function parseIngestaRow(row = [], timeZone = DEFAULT_TIMEZONE) {
  const localDate = clean(row[0]);
  if (!isIsoDate(localDate)) return null;

  let localTime = null;
  let mealType = null;
  let foodItem = '';
  let quantityValue = null;
  let quantityUnit = null;
  let brandOrNotes = null;
  let caloriesKcal = null;
  let proteinG = null;
  let carbsG = null;
  let fatG = null;

  const col1 = clean(row[1]);
  const col2 = clean(row[2]);
  const col3 = clean(row[3]);

  if (isTime(col1) || col1 === '--' || col1 === '') {
    mealType = isMealToken(col2) ? normalizeText(col2) : null;
    localTime = normalizeTime(col1, defaultTimeForMeal(mealType));

    if (mealType && parseNumber(row[7]) !== null) {
      // Formato legacy detallado.
      foodItem = col3 || col2;
      quantityValue = parseNumber(row[4]);
      quantityUnit = clean(row[5]) || null;
      brandOrNotes = clean(row[6]) || null;
      caloriesKcal = parseNumber(row[7]);
      proteinG = parseNumber(row[8]);
      carbsG = parseNumber(row[9]);
      fatG = parseNumber(row[10]);
    } else if (mealType && parseNumber(row[4]) !== null) {
      // Formato meal + descripcion + macros compactas.
      foodItem = col3 || col2;
      caloriesKcal = parseNumber(row[4]);
      proteinG = parseNumber(row[5]);
      carbsG = parseNumber(row[6]);
      fatG = parseNumber(row[7]);
    } else {
      // Formato simple: date,time,descripcion,kcal,p,c,f
      mealType = isMealToken(col2) ? normalizeText(col2) : null;
      foodItem = mealType ? clean(row[3]) : col2;
      const macroStart = mealType ? 4 : 3;
      caloriesKcal = parseNumber(row[macroStart]);
      proteinG = parseNumber(row[macroStart + 1]);
      carbsG = parseNumber(row[macroStart + 2]);
      fatG = parseNumber(row[macroStart + 3]);
    }
  } else {
    // Formato sin hora explícita: date,meal,descripcion,macros...
    mealType = isMealToken(col1) ? normalizeText(col1) : null;
    localTime = defaultTimeForMeal(mealType);
    foodItem = col2 || col3;
    caloriesKcal = parseNumber(row[4]);
    proteinG = parseNumber(row[5]);
    carbsG = parseNumber(row[6]);
    fatG = parseNumber(row[7]);
    brandOrNotes = clean(row[3]) || null;
  }

  const fallbackNums = extractNumbers(row.slice(3));
  if (caloriesKcal === null && fallbackNums.length >= 1) caloriesKcal = fallbackNums[0];
  if (proteinG === null && fallbackNums.length >= 2) proteinG = fallbackNums[1];
  if (carbsG === null && fallbackNums.length >= 3) carbsG = fallbackNums[2];
  if (fatG === null && fallbackNums.length >= 4) fatG = fallbackNums[3];

  caloriesKcal = clampOrNull(caloriesKcal, 0, 5000);
  proteinG = clampOrNull(proteinG ?? 0, 0, 500);
  carbsG = clampOrNull(carbsG ?? 0, 0, 800);
  fatG = clampOrNull(fatG ?? 0, 0, 400);

  if (caloriesKcal === null || !clean(foodItem)) {
    return null;
  }

  const confidence = extractConfidence(row);
  const source = extractSource(row);

  return {
    localDate,
    localTime,
    loggedAt: toUtcIsoFromLocal({
      localDate,
      localTime,
      timeZone,
    }),
    timezone: timeZone,
    mealType: mealType || null,
    foodItem: clean(foodItem),
    quantityValue: clampOrNull(quantityValue, 0, 50000),
    quantityUnit: clean(quantityUnit || '') || null,
    brandOrNotes: clean(brandOrNotes || '') || null,
    caloriesKcal,
    proteinG: proteinG ?? 0,
    carbsG: carbsG ?? 0,
    fatG: fatG ?? 0,
    confidence,
    source,
    rawInput: row.join(' | ').slice(0, 2000),
  };
}

function parseBalanzaRow(row = [], timeZone = DEFAULT_TIMEZONE) {
  const localDate = clean(row[0]);
  if (!isIsoDate(localDate)) return null;

  const col1 = clean(row[1]);
  const hasTime = isTime(col1);
  const offset = hasTime ? 0 : -1;
  const localTime = hasTime ? normalizeTime(col1, '08:00') : '08:00';

  const pick = (idx) => row[idx + offset];
  const weightKg =
    clampOrNull(parseNumber(pick(2)), 30, 300) ??
    clampOrNull(parseNumber(row[1]), 30, 300) ??
    null;

  if (!weightKg) return null;

  const bodyFatPercent = clampOrNull(parseNumber(pick(3)), 1, 80);
  const visceralFat = clampOrNull(parseNumber(pick(5)), 1, 80);
  const muscleMassKg = clampOrNull(parseNumber(pick(7)), 1, 120);
  const bodyWaterPercent = clampOrNull(parseNumber(pick(10)), 1, 90);
  const bmrKcal = clampOrNull(parseNumber(pick(12)), 400, 5000);
  const boneMassKg = clampOrNull(parseNumber(pick(14)), 0.1, 20);

  const notesCandidates = [
    clean(pick(15)),
    clean(pick(10)),
    clean(pick(9)),
  ].filter((value) => value && parseNumber(value) === null);

  return {
    localDate,
    localTime,
    loggedAt: toUtcIsoFromLocal({
      localDate,
      localTime,
      timeZone,
    }),
    timezone: timeZone,
    weightKg,
    bodyFatPercent,
    visceralFat,
    muscleMassKg,
    bodyWaterPercent,
    bmrKcal,
    boneMassKg,
    notes: notesCandidates.join(' | ') || null,
    rawInput: row.join(' | ').slice(0, 2000),
  };
}

function parseVitacoraRow(row = [], timeZone = DEFAULT_TIMEZONE) {
  const localDate = clean(row[0]);
  if (!isIsoDate(localDate)) return null;

  const second = clean(row[1]);
  let localTime = '12:00';
  let event = '';
  let notes = '';
  if (isTime(second)) {
    localTime = normalizeTime(second, '12:00');
    event = clean(row[2]);
    notes = clean(row[3]);
  } else {
    event = second;
    notes = [clean(row[2]), clean(row[3])].filter(Boolean).join(' | ');
  }

  if (!event) return null;
  const _ = timeZone;
  return {
    localDate,
    localTime,
    event,
    notes: notes || null,
  };
}

function parseProfileRows(rows = [], timezone = DEFAULT_TIMEZONE) {
  const map = {};
  for (const row of rows) {
    const key = normalizeText(row[0]);
    const value = clean(row[1]);
    if (!key || !value) continue;
    map[key] = value;
  }

  const parseRangeCenter = (value = '') => {
    const nums = extractNumbers([value]);
    if (nums.length >= 2) {
      return Math.round((nums[0] + nums[1]) / 2);
    }
    if (nums.length === 1) return nums[0];
    return null;
  };

  const mainGoal =
    map.objetivo_principal ||
    map.objetivo ||
    map.goal ||
    '';
  const targetCaloriesKcal =
    parseRangeCenter(map.objetivo_calorico_kcal || map.calorias_objetivo || map.target_kcal);
  const targetProteinG =
    parseRangeCenter(map.objetivo_proteina_g || map.proteina_objetivo || map.target_proteina_g);
  const restrictions =
    map.alergias_intolerancias && normalizeText(map.alergias_intolerancias) !== 'ninguna'
      ? map.alergias_intolerancias
      : '';

  const notes = Object.entries(map)
    .map(([key, value]) => `${key}: ${value}`)
    .join(' | ');

  return {
    timezone: normalizeTimeZone(timezone, DEFAULT_TIMEZONE),
    mainGoal: clean(mainGoal) || null,
    targetCaloriesKcal: clampOrNull(targetCaloriesKcal, 500, 8000),
    targetProteinG: clampOrNull(targetProteinG, 20, 500),
    restrictions: clean(restrictions) || null,
    notes: notes || null,
  };
}

function isUnitToken(value = '') {
  const token = normalizeText(value);
  return ['g', 'gr', 'gramos', 'ml', 'cc', 'kg'].includes(token);
}

function hasLetters(value = '') {
  return /[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/.test(clean(value));
}

function parseCatalogRow(row = []) {
  const productName = clean(row[0]);
  if (!productName) return null;

  const col1 = clean(row[1]);
  const col2 = clean(row[2]);
  const col3 = clean(row[3]);
  const brandLooksNumeric = parseNumber(col1) !== null && !hasLetters(col1);
  const brand = brandLooksNumeric ? '' : col1;

  let portionG = parseNumber(col2);
  let caloriesKcal = parseNumber(col3);
  let carbsG = parseNumber(row[4]);
  let proteinG = parseNumber(row[7]);
  let fatG = parseNumber(row[8]);

  if (portionG === null && brandLooksNumeric && isUnitToken(col2)) {
    portionG = parseNumber(col1);
  }

  // Caso corrido: producto, porcion, kcal, carbs, protein, fat...
  if (brandLooksNumeric && parseNumber(col2) !== null && parseNumber(row[3]) !== null) {
    portionG = parseNumber(col1);
    caloriesKcal = parseNumber(col2);
    carbsG = parseNumber(row[3]);
    proteinG = parseNumber(row[4]);
    fatG = parseNumber(row[5]);
  }

  const numericTail = extractNumbers(row.slice(1));
  if (portionG === null && numericTail.length >= 1) portionG = numericTail[0];
  if (caloriesKcal === null && numericTail.length >= 2) caloriesKcal = numericTail[1];
  if (carbsG === null && numericTail.length >= 3) carbsG = numericTail[2];
  if (proteinG === null && numericTail.length >= 4) proteinG = numericTail[3];
  if (fatG === null && numericTail.length >= 5) fatG = numericTail[4];

  portionG = clampOrNull(portionG, 1, 5000);
  caloriesKcal = clampOrNull(caloriesKcal, 0, 3000);
  carbsG = clampOrNull(carbsG, 0, 500);
  proteinG = clampOrNull(proteinG, 0, 400);
  fatG = clampOrNull(fatG, 0, 400);

  if (
    portionG === null ||
    caloriesKcal === null ||
    carbsG === null ||
    proteinG === null ||
    fatG === null
  ) {
    return null;
  }

  return {
    productName,
    brand: clean(brand) || null,
    portionG,
    caloriesKcal,
    carbsG,
    proteinG,
    fatG,
    fiberG: clampOrNull(parseNumber(row[11]), 0, 200),
    sodiumMg: clampOrNull(parseNumber(row[12]), 0, 50000),
    source: clean(row[13]) || 'legacy_csv_import',
  };
}

function resetUserData(userId = '') {
  const db = getDb();
  const cleanUserId = clean(userId);
  if (!cleanUserId) return;
  db.prepare('DELETE FROM nutrition_intakes WHERE telegram_user_id = ?').run(cleanUserId);
  db.prepare('DELETE FROM nutrition_weighins WHERE telegram_user_id = ?').run(cleanUserId);
  db.prepare('DELETE FROM nutrition_profiles WHERE telegram_user_id = ?').run(cleanUserId);
  db.prepare('DELETE FROM nutrition_journal WHERE telegram_user_id = ?').run(cleanUserId);
  db.prepare('DELETE FROM nutrition_user_state WHERE telegram_user_id = ?').run(cleanUserId);
  db.prepare('DELETE FROM nutrition_operation_receipts WHERE telegram_user_id = ?').run(cleanUserId);
  db.prepare('DELETE FROM nutrition_usage_records WHERE telegram_user_id = ?').run(cleanUserId);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.userId) {
    throw new Error(
      'Falta --user-id. Ejemplo: node src/scripts/importNutritionKnowledgeCsv.js --user-id 1806836602 --reset-user'
    );
  }

  const timezone = normalizeTimeZone(args.timezone, DEFAULT_TIMEZONE);
  const knowledgeDir = path.resolve(process.cwd(), args.knowledgeDir);
  const files = {
    ingesta: path.join(knowledgeDir, 'NutricionistaGPT - INGESTA.csv'),
    balanza: path.join(knowledgeDir, 'NutricionistaGPT - BALANZA.csv'),
    perfil: path.join(knowledgeDir, 'NutricionistaGPT - PERFIL.csv'),
    vitacora: path.join(knowledgeDir, 'NutricionistaGPT - VITACORA.csv'),
    catalog: path.join(knowledgeDir, 'NutricionistaGPT - info_nutricional.csv'),
  };

  ensureNutritionSchema();
  const db = getDb();

  const intakeRows = readCsvRows(files.ingesta);
  const weighinRows = readCsvRows(files.balanza);
  const profileRows = readCsvRows(files.perfil);
  const journalRows = readCsvRows(files.vitacora);
  const catalogRows = readCsvRows(files.catalog);

  const intakeParsed = intakeRows.map((row) => parseIngestaRow(row, timezone));
  const weighinParsed = weighinRows.map((row) => parseBalanzaRow(row, timezone));
  const journalParsed = journalRows.map((row) => parseVitacoraRow(row, timezone));
  const catalogParsed = catalogRows.map((row) => parseCatalogRow(row));
  const profileParsed = parseProfileRows(profileRows, timezone);

  const validIntakes = intakeParsed.filter(Boolean);
  const validWeighins = weighinParsed.filter(Boolean);
  const validJournal = journalParsed.filter(Boolean);
  const validCatalog = catalogParsed.filter(Boolean);

  const summary = {
    dryRun: args.dryRun,
    dbPath: getDbPath(),
    userId: args.userId,
    timezone,
    totals: {
      ingesta_rows: intakeRows.length,
      ingesta_importables: validIntakes.length,
      ingesta_skipped: intakeRows.length - validIntakes.length,
      balanza_rows: weighinRows.length,
      balanza_importables: validWeighins.length,
      balanza_skipped: weighinRows.length - validWeighins.length,
      vitacora_rows: journalRows.length,
      vitacora_importables: validJournal.length,
      vitacora_skipped: journalRows.length - validJournal.length,
      catalog_rows: catalogRows.length,
      catalog_importables: validCatalog.length,
      catalog_skipped: catalogRows.length - validCatalog.length,
    },
    resetUserApplied: Boolean(args.resetUser && !args.dryRun),
    profileWillApply: profileParsed,
  };

  if (args.dryRun) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  const insertIntakeStmt = db.prepare(`
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

  const insertWeighinStmt = db.prepare(`
    INSERT INTO nutrition_weighins (
      telegram_user_id, logged_at, local_date, local_time, timezone, weight_kg,
      body_fat_percent, visceral_fat, muscle_mass_kg, body_water_percent,
      bmr_kcal, bone_mass_kg, notes, raw_input, created_at
    ) VALUES (
      @userId, @loggedAt, @localDate, @localTime, @timezone, @weightKg,
      @bodyFatPercent, @visceralFat, @muscleMassKg, @bodyWaterPercent,
      @bmrKcal, @boneMassKg, @notes, @rawInput, @createdAt
    )
  `);

  const insertJournalStmt = db.prepare(`
    INSERT INTO nutrition_journal (
      telegram_user_id, local_date, local_time, event, notes, created_at
    ) VALUES (
      @userId, @localDate, @localTime, @event, @notes, @createdAt
    )
  `);

  const tx = db.transaction(() => {
    if (args.resetUser) {
      resetUserData(args.userId);
    }

    for (const row of validIntakes) {
      insertIntakeStmt.run({
        userId: args.userId,
        loggedAt: row.loggedAt,
        localDate: row.localDate,
        localTime: row.localTime,
        timezone: row.timezone,
        mealType: row.mealType || null,
        foodItem: row.foodItem,
        quantityValue: row.quantityValue,
        quantityUnit: row.quantityUnit,
        brandOrNotes: row.brandOrNotes,
        caloriesKcal: row.caloriesKcal,
        proteinG: row.proteinG,
        carbsG: row.carbsG,
        fatG: row.fatG,
        confidence: row.confidence,
        source: row.source,
        rawInput: row.rawInput,
        createdAt: new Date().toISOString(),
      });
    }

    for (const row of validWeighins) {
      insertWeighinStmt.run({
        userId: args.userId,
        loggedAt: row.loggedAt,
        localDate: row.localDate,
        localTime: row.localTime,
        timezone: row.timezone,
        weightKg: row.weightKg,
        bodyFatPercent: row.bodyFatPercent,
        visceralFat: row.visceralFat,
        muscleMassKg: row.muscleMassKg,
        bodyWaterPercent: row.bodyWaterPercent,
        bmrKcal: row.bmrKcal,
        boneMassKg: row.boneMassKg,
        notes: row.notes,
        rawInput: row.rawInput,
        createdAt: new Date().toISOString(),
      });
    }

    for (const row of validJournal) {
      insertJournalStmt.run({
        userId: args.userId,
        localDate: row.localDate,
        localTime: row.localTime,
        event: row.event,
        notes: row.notes,
        createdAt: new Date().toISOString(),
      });
    }
  });

  tx();

  upsertNutritionProfile(args.userId, profileParsed);
  for (const row of validCatalog) {
    upsertFoodCatalogEntry(row);
  }

  console.log(JSON.stringify(summary, null, 2));
}

main();
