import assert from 'node:assert/strict';
import { getDb } from '../src/core/sqliteStore.js';
import {
  addNutritionIntakes,
  addNutritionWeighin,
  ensureNutritionSchema,
  findFoodCatalogCandidates,
  getNutritionSummary,
  upsertFoodCatalogEntry,
} from '../src/bots/nutrition/nutritionStore.js';
import {
  parseIntakePayload,
  parseWeighinPayload,
  resolveTemporalContext,
} from '../src/bots/nutrition/nutritionDomain.js';

function cleanupUserData(userId = '') {
  const db = getDb();
  const normalizedUserId = String(userId || '').trim();
  db.prepare('DELETE FROM nutrition_intakes WHERE telegram_user_id = ?').run(normalizedUserId);
  db.prepare('DELETE FROM nutrition_weighins WHERE telegram_user_id = ?').run(normalizedUserId);
  db.prepare('DELETE FROM nutrition_profiles WHERE telegram_user_id = ?').run(normalizedUserId);
  db.prepare('DELETE FROM nutrition_journal WHERE telegram_user_id = ?').run(normalizedUserId);
  db.prepare('DELETE FROM nutrition_user_state WHERE telegram_user_id = ?').run(normalizedUserId);
  db
    .prepare('DELETE FROM nutrition_operation_receipts WHERE telegram_user_id = ?')
    .run(normalizedUserId);
  db.prepare('DELETE FROM nutrition_usage_records WHERE telegram_user_id = ?').run(normalizedUserId);
}

export async function runNutritionDomainTests() {
  ensureNutritionSchema();
  const userId = `nutrition_test_${Date.now()}`;
  cleanupUserData(userId);

  const parsedIntake = parseIntakePayload({
    rawMessage: '2026-03-20 13:30 200g arroz cocido',
    userTimeZone: 'America/Argentina/Buenos_Aires',
  });
  assert.equal(parsedIntake.ok, true);
  assert.equal(parsedIntake.temporal.localDate, '2026-03-20');
  assert.equal(parsedIntake.temporal.localTime, '13:30');
  assert.equal(parsedIntake.items.length, 1);
  assert.equal(parsedIntake.items[0].foodItem, 'arroz cocido');

  const parsedRelative = parseIntakePayload({
    rawMessage: 'ayer 20:15 100g pechuga de pollo cocida',
    userTimeZone: 'America/Argentina/Buenos_Aires',
    now: new Date('2026-03-25T03:00:00.000Z'),
  });
  assert.equal(parsedRelative.ok, true);
  assert.equal(parsedRelative.temporal.localDate, '2026-03-24');
  assert.equal(parsedRelative.temporal.localTime, '20:15');

  const parsedWeighin = parseWeighinPayload({
    rawMessage: 'hoy 08:10 81.4 kg grasa 18.2% agua 56%',
    userTimeZone: 'America/Argentina/Buenos_Aires',
  });
  assert.equal(parsedWeighin.ok, true);
  assert.equal(parsedWeighin.weighin.weightKg, 81.4);
  assert.equal(parsedWeighin.weighin.bodyFatPercent, 18.2);
  assert.equal(parsedWeighin.weighin.bodyWaterPercent, 56);

  const missingWeighin = parseWeighinPayload({
    rawMessage: 'hoy me pese',
    userTimeZone: 'America/Argentina/Buenos_Aires',
  });
  assert.equal(missingWeighin.ok, false);
  assert.equal(missingWeighin.error, 'missing_weight');

  const intakeDay1 = parseIntakePayload({
    rawMessage: '2026-03-20 13:30 100g arroz cocido',
    userTimeZone: 'America/Argentina/Buenos_Aires',
  });
  const intakeDay2 = parseIntakePayload({
    rawMessage: '2026-03-21 13:30 100g arroz cocido',
    userTimeZone: 'America/Argentina/Buenos_Aires',
  });
  assert.equal(intakeDay1.ok, true);
  assert.equal(intakeDay2.ok, true);

  addNutritionIntakes(userId, {
    loggedAt: intakeDay1.temporal.loggedAt,
    localDate: intakeDay1.temporal.localDate,
    localTime: intakeDay1.temporal.localTime,
    timezone: intakeDay1.temporal.timeZone,
    rawInput: '100g arroz cocido',
    items: intakeDay1.items,
  });
  addNutritionIntakes(userId, {
    loggedAt: intakeDay2.temporal.loggedAt,
    localDate: intakeDay2.temporal.localDate,
    localTime: intakeDay2.temporal.localTime,
    timezone: intakeDay2.temporal.timeZone,
    rawInput: '100g arroz cocido',
    items: intakeDay2.items,
  });

  const summary = getNutritionSummary(userId, '2026-03-21');
  assert.equal(summary.today.caloriesKcal, 130);
  assert.equal(summary.today.proteinG, 2.7);
  assert.equal(summary.rolling7d.caloriesKcal, 130);
  assert.equal(summary.rolling14d.caloriesKcal, 130);

  const idempotentPayload = parseIntakePayload({
    rawMessage: '2026-03-22 13:30 100g arroz cocido',
    userTimeZone: 'America/Argentina/Buenos_Aires',
  });
  assert.equal(idempotentPayload.ok, true);

  const intakeInsertA = addNutritionIntakes(
    userId,
    {
      loggedAt: idempotentPayload.temporal.loggedAt,
      localDate: idempotentPayload.temporal.localDate,
      localTime: idempotentPayload.temporal.localTime,
      timezone: idempotentPayload.temporal.timeZone,
      rawInput: '100g arroz cocido',
      items: idempotentPayload.items,
    },
    {
      idempotency: {
        sourceMessageId: 'msg-intake-1',
        operationType: 'log_intake',
      },
    }
  );
  const intakeInsertB = addNutritionIntakes(
    userId,
    {
      loggedAt: idempotentPayload.temporal.loggedAt,
      localDate: idempotentPayload.temporal.localDate,
      localTime: idempotentPayload.temporal.localTime,
      timezone: idempotentPayload.temporal.timeZone,
      rawInput: '100g arroz cocido',
      items: idempotentPayload.items,
    },
    {
      idempotency: {
        sourceMessageId: 'msg-intake-1',
        operationType: 'log_intake',
      },
    }
  );
  assert.equal(intakeInsertA.ok, true);
  assert.equal(intakeInsertA.idempotencyStatus, 'new');
  assert.equal(intakeInsertB.ok, true);
  assert.equal(intakeInsertB.idempotencyStatus, 'replayed');

  const conflictingPayload = parseIntakePayload({
    rawMessage: '2026-03-22 13:30 200g arroz cocido',
    userTimeZone: 'America/Argentina/Buenos_Aires',
  });
  assert.equal(conflictingPayload.ok, true);
  const intakeConflict = addNutritionIntakes(
    userId,
    {
      loggedAt: conflictingPayload.temporal.loggedAt,
      localDate: conflictingPayload.temporal.localDate,
      localTime: conflictingPayload.temporal.localTime,
      timezone: conflictingPayload.temporal.timeZone,
      rawInput: '200g arroz cocido',
      items: conflictingPayload.items,
    },
    {
      idempotency: {
        sourceMessageId: 'msg-intake-1',
        operationType: 'log_intake',
      },
    }
  );
  assert.equal(intakeConflict.ok, true);
  assert.equal(intakeConflict.idempotencyStatus, 'replayed_payload_mismatch');

  const weighinParsed = parseWeighinPayload({
    rawMessage: '2026-03-22 08:15 81.2 kg',
    userTimeZone: 'America/Argentina/Buenos_Aires',
  });
  assert.equal(weighinParsed.ok, true);
  const weighinA = addNutritionWeighin(
    userId,
    {
      ...weighinParsed.weighin,
      loggedAt: weighinParsed.temporal.loggedAt,
      localDate: weighinParsed.temporal.localDate,
      localTime: weighinParsed.temporal.localTime,
      timezone: weighinParsed.temporal.timeZone,
      rawInput: '81.2 kg',
    },
    {
      idempotency: {
        sourceMessageId: 'msg-weighin-1',
        operationType: 'log_weighin',
      },
    }
  );
  const weighinB = addNutritionWeighin(
    userId,
    {
      ...weighinParsed.weighin,
      loggedAt: weighinParsed.temporal.loggedAt,
      localDate: weighinParsed.temporal.localDate,
      localTime: weighinParsed.temporal.localTime,
      timezone: weighinParsed.temporal.timeZone,
      rawInput: '81.2 kg',
    },
    {
      idempotency: {
        sourceMessageId: 'msg-weighin-1',
        operationType: 'log_weighin',
      },
    }
  );
  assert.equal(weighinA.ok, true);
  assert.equal(weighinA.idempotencyStatus, 'new');
  assert.equal(weighinB.ok, true);
  assert.equal(weighinB.idempotencyStatus, 'replayed');

  const uniqueProduct = `producto_prueba_${Date.now()}`;
  upsertFoodCatalogEntry({
    productName: uniqueProduct,
    brand: 'Marca QA',
    portionG: 100,
    caloriesKcal: 250,
    proteinG: 15,
    carbsG: 20,
    fatG: 10,
    source: 'manual',
  });
  upsertFoodCatalogEntry({
    productName: uniqueProduct,
    brand: 'Marca QA',
    portionG: 100,
    caloriesKcal: 260,
    proteinG: 16,
    carbsG: 21,
    fatG: 11,
    source: 'manual',
  });

  const catalogRows = findFoodCatalogCandidates(uniqueProduct, { limit: 20 }).filter(
    (row) => row.productName === uniqueProduct && row.brand === 'Marca QA'
  );
  assert.equal(catalogRows.length, 1);
  assert.equal(catalogRows[0].caloriesKcal, 260);

  const temporal = resolveTemporalContext({
    rawMessage: '13:05 pollo',
    userTimeZone: 'America/Argentina/Buenos_Aires',
    now: new Date('2026-03-24T15:00:00.000Z'),
  });
  assert.equal(temporal.localDate, '2026-03-24');
  assert.equal(temporal.localTime, '13:05');

  cleanupUserData(userId);
  console.log('All nutrition domain tests passed.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runNutritionDomainTests().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
