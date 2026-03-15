import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function parseJson(value, fallback = null) {
  if (!value || typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export async function runSqliteStoreCompositeTests() {
  const previousDbPath = process.env.DB_PATH;
  const previousQuickCheck = process.env.DB_STARTUP_QUICK_CHECK;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ufc-bot-sqlite-composite-'));
  const dbPath = path.join(tempDir, 'bot.db');
  let store = null;
  let db = null;

  try {
    process.env.DB_PATH = dbPath;
    process.env.DB_STARTUP_QUICK_CHECK = 'false';

    const moduleUrl = new URL(`../src/core/sqliteStore.js?suite=${Date.now()}`, import.meta.url);
    store = await import(moduleUrl.href);

    const {
      addBetRecord,
      listUserBets,
      previewCompositeBetMutations,
      applyCompositeBetMutations,
      getDb,
    } = store;

    // Happy-path apply across multiple steps with atomic policy.
    {
      const userId = 'u-composite-store-1';
      const bet1 = addBetRecord(userId, {
        eventName: 'UFC Test',
        fight: 'A vs B',
        pick: 'A ML',
        odds: 1.8,
        stake: 1000,
        units: 2.5,
        result: 'pending',
      });
      const bet2 = addBetRecord(userId, {
        eventName: 'UFC Test',
        fight: 'C vs D',
        pick: 'Over 2.5',
        odds: 1.9,
        stake: 1200,
        units: 3,
        result: 'pending',
      });

      const payload = {
        transactionPolicy: 'all_or_nothing',
        steps: [
          { operation: 'settle', result: 'win', betIds: [bet1.id] },
          { operation: 'archive', betIds: [bet2.id] },
        ],
      };

      const preview = previewCompositeBetMutations(userId, payload);
      assert.equal(preview.ok, true);
      assert.equal(preview.requiresConfirmation, false);
      assert.equal(preview.stepResults.length, 2);

      const applied = applyCompositeBetMutations(userId, payload);
      assert.equal(applied.ok, true);
      assert.equal(applied.transactionPolicy, 'all_or_nothing');
      assert.equal(applied.affectedCount, 2);
      assert.equal(applied.stepResults.length, 2);

      const allBets = listUserBets(userId, { includeArchived: true, limit: 20 });
      const settled = allBets.find((item) => item.id === bet1.id);
      const archived = allBets.find((item) => item.id === bet2.id);
      assert.equal(settled?.result, 'win');
      assert.equal(settled?.archivedAt, null);
      assert.equal(Boolean(archived?.archivedAt), true);

      db = getDb();
      const mutationRows = db
        .prepare(
          `SELECT action, metadata
           FROM bet_mutations
           WHERE telegram_user_id = ?
             AND action IN ('settle', 'archive', 'set_pending')
           ORDER BY id ASC`
        )
        .all(userId);
      assert.equal(mutationRows.length, 2);
      assert.equal(mutationRows[0].action, 'settle');
      assert.equal(mutationRows[1].action, 'archive');
      const metadataStep0 = parseJson(mutationRows[0].metadata, {});
      const metadataStep1 = parseJson(mutationRows[1].metadata, {});
      assert.equal(metadataStep0?.transactionPolicy, 'all_or_nothing');
      assert.equal(metadataStep1?.transactionPolicy, 'all_or_nothing');
      assert.equal(metadataStep0?.compositeStepIndex, 0);
      assert.equal(metadataStep1?.compositeStepIndex, 1);
    }

    // Bulk steps still require explicit confirmation before apply.
    {
      const userId = 'u-composite-store-2';
      addBetRecord(userId, {
        eventName: 'UFC Test 2',
        fight: 'E vs F',
        pick: 'E ML',
        odds: 2.1,
        stake: 900,
        units: 2,
        result: 'pending',
      });
      addBetRecord(userId, {
        eventName: 'UFC Test 2',
        fight: 'E vs F',
        pick: 'Fight goes distance',
        odds: 1.7,
        stake: 1100,
        units: 2.4,
        result: 'pending',
      });

      const payload = {
        transactionPolicy: 'all_or_nothing',
        steps: [{ operation: 'archive', fight: 'E vs F' }],
      };

      const preview = previewCompositeBetMutations(userId, payload);
      assert.equal(preview.ok, true);
      assert.equal(preview.requiresConfirmation, true);
      assert.equal(preview.stepResults[0]?.candidateCount, 2);

      const appliedWithoutConfirm = applyCompositeBetMutations(userId, payload);
      assert.equal(appliedWithoutConfirm.ok, false);
      assert.equal(appliedWithoutConfirm.error, 'confirmation_required');

      db = getDb();
      const mutationCount = db
        .prepare(
          `SELECT count(*) AS c
           FROM bet_mutations
           WHERE telegram_user_id = ?
             AND action IN ('settle', 'archive', 'set_pending')`
        )
        .get(userId).c;
      assert.equal(Number(mutationCount), 0);
    }

    // If one step is invalid, nothing is applied.
    {
      const userId = 'u-composite-store-3';
      const bet = addBetRecord(userId, {
        eventName: 'UFC Test 3',
        fight: 'G vs H',
        pick: 'G ML',
        odds: 1.6,
        stake: 1500,
        units: 3.2,
        result: 'pending',
      });

      const payload = {
        transactionPolicy: 'all_or_nothing',
        steps: [
          { operation: 'settle', result: 'loss', betIds: [bet.id] },
          { operation: 'archive', betIds: [999999] },
        ],
      };

      const applied = applyCompositeBetMutations(userId, payload);
      assert.equal(applied.ok, false);
      assert.equal(applied.error, 'composite_preview_failed');
      assert.equal(applied.failedStepIndex, 1);

      const bets = listUserBets(userId, { includeArchived: true, limit: 20 });
      const target = bets.find((item) => item.id === bet.id);
      assert.equal(target?.result, 'pending');
      assert.equal(target?.archivedAt, null);

      db = getDb();
      const mutationCount = db
        .prepare(
          `SELECT count(*) AS c
           FROM bet_mutations
           WHERE telegram_user_id = ?
             AND action IN ('settle', 'archive', 'set_pending')`
        )
        .get(userId).c;
      assert.equal(Number(mutationCount), 0);
    }

    // Policy validation remains strict.
    {
      const invalidPolicy = previewCompositeBetMutations('u-policy', {
        transactionPolicy: 'partial_with_receipts',
        steps: [{ operation: 'archive', betIds: [1] }],
      });
      assert.equal(invalidPolicy.ok, false);
      assert.equal(invalidPolicy.error, 'invalid_transaction_policy');
    }

    console.log('All sqliteStore composite mutation tests passed.');
  } finally {
    if (db && typeof db.close === 'function') {
      db.close();
    }

    if (previousDbPath === undefined) {
      delete process.env.DB_PATH;
    } else {
      process.env.DB_PATH = previousDbPath;
    }

    if (previousQuickCheck === undefined) {
      delete process.env.DB_STARTUP_QUICK_CHECK;
    } else {
      process.env.DB_STARTUP_QUICK_CHECK = previousQuickCheck;
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runSqliteStoreCompositeTests().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
