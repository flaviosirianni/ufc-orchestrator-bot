const MONITORED_RESOURCE_TYPES = new Set(['Timeout']);

/**
 * Convierte cualquier motivo de rechazo en un Error con stack utilizable.
 *
 * @returns {Error} El error original o un wrapper descriptivo.
 * @sideEffects Ninguno.
 */
function normalizeFailure(reason) {
  if (reason instanceof Error) {
    return reason;
  }
  return new Error(`Unhandled rejection: ${String(reason)}`);
}

/**
 * Cuenta recursos activos por tipo para comparar el estado antes y después de una suite.
 *
 * @returns {Map<string, number>} Cantidad de recursos monitoreados por tipo.
 * @sideEffects Ninguno.
 */
function countMonitoredResources(resources = []) {
  const counts = new Map();
  for (const type of resources) {
    if (!MONITORED_RESOURCE_TYPES.has(type)) {
      continue;
    }
    counts.set(type, (counts.get(type) || 0) + 1);
  }
  return counts;
}

/**
 * Detecta recursos bloqueantes que una suite agregó y no liberó.
 *
 * @returns {Array<{type: string, delta: number}>} Recursos nuevos ordenados por tipo.
 * @sideEffects Ninguno.
 */
export function diffActiveResources(before = [], after = []) {
  const beforeCounts = countMonitoredResources(before);
  const afterCounts = countMonitoredResources(after);
  const leaks = [];

  for (const [type, count] of afterCounts) {
    const delta = count - (beforeCounts.get(type) || 0);
    if (delta > 0) {
      leaks.push({ type, delta });
    }
  }

  return leaks.sort((left, right) => left.type.localeCompare(right.type));
}

/**
 * Registra rechazos no manejados durante la ejecución completa del runner.
 *
 * @returns {{throwIfAny: Function, close: Function}} Monitor que valida y retira listeners.
 * @throws {TypeError} Si processRef no implementa el contrato EventEmitter requerido.
 * @sideEffects Agrega temporalmente un listener `unhandledRejection`.
 */
export function createAsyncFailureMonitor({ processRef = process } = {}) {
  if (typeof processRef?.on !== 'function' || typeof processRef?.off !== 'function') {
    throw new TypeError('processRef debe implementar on/off.');
  }

  const failures = [];
  const onUnhandledRejection = (reason) => {
    failures.push(normalizeFailure(reason));
  };
  processRef.on('unhandledRejection', onUnhandledRejection);

  return {
    throwIfAny(context = 'test suite') {
      if (!failures.length) {
        return;
      }
      const details = failures
        .map((error, index) => `${index + 1}. ${error.stack || error.message}`)
        .join('\n');
      throw new Error(`Async failure durante ${context}:\n${details}`);
    },
    close() {
      processRef.off('unhandledRejection', onUnhandledRejection);
    },
  };
}

/**
 * Cede dos turnos del event loop para que rechazos y limpieza inmediata sean observables.
 *
 * @returns {Promise<void>} Se resuelve después de dos callbacks `setImmediate`.
 * @sideEffects Agenda dos immediates transitorios.
 */
async function settleAsyncWork() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

/**
 * Ejecuta una suite y falla ante rechazos no manejados o timers bloqueantes nuevos.
 *
 * @returns {Promise<void>} Se resuelve sólo si runner y guardas terminan limpios.
 * @throws {Error} Propaga el error de la suite o describe el fallo/leak asíncrono.
 * @sideEffects Ejecuta la suite y consulta recursos activos del proceso.
 */
export async function runSuiteWithGuards({
  name = 'test suite',
  runner,
  monitor,
  settle = settleAsyncWork,
  getActiveResourcesInfo = () => process.getActiveResourcesInfo(),
} = {}) {
  if (typeof runner !== 'function') {
    throw new TypeError('runner debe ser una función.');
  }
  if (typeof monitor?.throwIfAny !== 'function') {
    throw new TypeError('monitor debe implementar throwIfAny().');
  }

  const before = getActiveResourcesInfo();
  await runner();
  await settle();
  monitor.throwIfAny(name);

  const leaks = diffActiveResources(before, getActiveResourcesInfo());
  if (leaks.length) {
    const detail = leaks.map(({ type, delta }) => `${type} +${delta}`).join(', ');
    throw new Error(`La suite ${name} dejó recursos bloqueantes abiertos: ${detail}`);
  }
}
