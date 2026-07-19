import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  createAsyncFailureMonitor,
  diffActiveResources,
  runSuiteWithGuards,
} from './testHarness.js';

/**
 * Comprueba que el harness convierta fallos asíncronos y timers residuales en errores de suite.
 *
 * @returns {Promise<void>} Se resuelve cuando los guardas fallan y limpian como se espera.
 * @throws {AssertionError} Si un rechazo o recurso abierto no resulta observable.
 * @sideEffects Registra listeners temporales en un EventEmitter aislado.
 */
export async function runTestHarnessTests() {
  const processFixture = new EventEmitter();
  const monitor = createAsyncFailureMonitor({ processRef: processFixture });

  processFixture.emit(
    'unhandledRejection',
    new Error('synthetic rejected background refresh')
  );
  assert.throws(
    () => monitor.throwIfAny('synthetic-suite'),
    /synthetic rejected background refresh/,
    'un rechazo de background debe fallar la suite'
  );
  monitor.close();
  assert.equal(
    processFixture.listenerCount('unhandledRejection'),
    0,
    'el monitor debe retirar sus listeners al cerrar'
  );

  assert.deepEqual(
    diffActiveResources(['PipeWrap'], ['PipeWrap', 'Timeout']),
    [{ type: 'Timeout', delta: 1 }],
    'un timer bloqueante nuevo debe reportarse como leak'
  );

  let snapshotCalls = 0;
  await assert.rejects(
    runSuiteWithGuards({
      name: 'timer-leak-suite',
      runner: async () => {},
      monitor: { throwIfAny() {} },
      settle: async () => {},
      getActiveResourcesInfo: () => {
        snapshotCalls += 1;
        return snapshotCalls === 1 ? ['PipeWrap'] : ['PipeWrap', 'Timeout'];
      },
    }),
    /Timeout \+1/,
    'el runner debe fallar si una suite deja un timer bloqueante'
  );

  console.log('All test harness tests passed.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runTestHarnessTests().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
