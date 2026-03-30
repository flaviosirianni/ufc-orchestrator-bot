import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBillingStore } from '../src/services/billing/store.js';
import {
  createBillingDbBackup,
  verifyBillingDb,
} from '../src/services/billing/reliability.js';

export async function runBillingReliabilityTests() {
  const tests = [];

  tests.push(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'billing-reliability-'));
    const dbPath = path.join(dir, 'billing.db');
    const backupDir = path.join(dir, 'backups');
    const store = createBillingStore({ dbPath });
    store.close();

    const verification = verifyBillingDb({ dbPath });
    assert.equal(verification.ok, true);
    assert.deepEqual(verification.missingTables, []);

    const backup = await createBillingDbBackup({
      dbPath,
      backupDir,
      retentionDays: 14,
      verifyBackup: true,
    });
    assert.equal(backup.ok, true);
    assert.equal(backup.backupVerification?.ok, true);
    assert.equal(typeof backup.sha256, 'string');
    assert.equal(backup.sha256.length, 64);
    assert.equal(path.dirname(backup.backupFile), backupDir);
  });

  for (const test of tests) {
    await test();
  }

  console.log('All billing reliability tests passed.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runBillingReliabilityTests().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
