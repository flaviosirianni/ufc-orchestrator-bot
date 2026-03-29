import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBillingStore } from '../src/services/billing/store.js';

export async function runBillingStoreTests() {
  const tests = [];

  tests.push(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'billing-store-'));
    const dbPath = path.join(dir, 'billing.db');
    const store = createBillingStore({ dbPath });

    const initial = store.getState('u1', { weeklyFreeCredits: 5 });
    assert.equal(initial.available_credits, 5);
    assert.equal(initial.free_credits, 5);
    assert.equal(initial.paid_credits, 0);

    store.close();
  });

  tests.push(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'billing-store-'));
    const dbPath = path.join(dir, 'billing.db');
    const store = createBillingStore({ dbPath });

    const first = store.spendCredits({
      userId: 'u2',
      botId: 'ufc',
      amount: 2,
      reason: 'analysis',
      idempotencyKey: 'idem-1',
      weeklyFreeCredits: 5,
    });

    const replay = store.spendCredits({
      userId: 'u2',
      botId: 'ufc',
      amount: 2,
      reason: 'analysis',
      idempotencyKey: 'idem-1',
      weeklyFreeCredits: 5,
    });

    const state = store.getState('u2', { weeklyFreeCredits: 5 });

    assert.equal(first.ok, true);
    assert.equal(first.idempotency_status, 'new');
    assert.equal(replay.ok, true);
    assert.equal(replay.idempotency_status, 'replayed');
    assert.equal(state.available_credits, 3);

    store.close();
  });

  tests.push(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'billing-store-'));
    const dbPath = path.join(dir, 'billing.db');
    const store = createBillingStore({ dbPath });

    const creditA = store.creditFromPayment({
      paymentId: 'pay_1',
      userId: 'u3',
      botId: 'ufc',
      credits: 10,
      amount: 1000,
      status: 'approved',
      rawPayload: { id: 'pay_1' },
      weeklyFreeCredits: 0,
    });

    const creditReplay = store.creditFromPayment({
      paymentId: 'pay_1',
      userId: 'u3',
      botId: 'ufc',
      credits: 10,
      amount: 1000,
      status: 'approved',
      rawPayload: { id: 'pay_1' },
      weeklyFreeCredits: 0,
    });

    const state = store.getState('u3', { weeklyFreeCredits: 0 });

    assert.equal(creditA.ok, true);
    assert.equal(creditA.alreadyProcessed, false);
    assert.equal(creditReplay.ok, true);
    assert.equal(creditReplay.alreadyProcessed, true);
    assert.equal(state.available_credits, 10);

    store.close();
  });

  for (const test of tests) {
    await test();
  }

  console.log('All billingStore tests passed.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runBillingStoreTests().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
