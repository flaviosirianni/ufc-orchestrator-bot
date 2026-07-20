import { evaluateEventConsumption } from '../../core/eventTruthGate.js';

/**
 * Ejecuta un getter de telemetría sin permitir que un fallo rompa `/health`.
 *
 * @returns {{value:*,error:string|null}} Resultado seguro del getter.
 * @sideEffects Ejecuta únicamente el getter read-only inyectado.
 */
function readStatus(getter, ...args) {
  if (typeof getter !== 'function') return { value: null, error: 'status_reader_missing' };
  try {
    return { value: getter(...args), error: null };
  } catch {
    return { value: null, error: 'status_read_failed' };
  }
}

/**
 * Obtiene el timestamp ISO más reciente de una lista sin inventar valores inválidos.
 *
 * @returns {string|null} Timestamp original más reciente.
 * @sideEffects Ninguno.
 */
function latestIso(values = []) {
  let latest = null;
  let latestMs = -Infinity;
  for (const value of values) {
    const parsed = Date.parse(String(value || ''));
    if (!Number.isFinite(parsed) || parsed <= latestMs) continue;
    latest = String(value);
    latestMs = parsed;
  }
  return latest;
}

/**
 * Reduce un estado deportivo a campos operativos no sensibles y revalida su TTL.
 *
 * @returns {object} Resumen fail-closed del watch key.
 * @sideEffects Ninguno.
 */
function summarizeEventState(eventState, watchKey, now) {
  const decision = evaluateEventConsumption({ eventState, now });
  const verificationReasons = Array.isArray(eventState?.verificationReasons)
    ? eventState.verificationReasons
    : [];
  return {
    watch_key: watchKey,
    event_id: eventState?.eventId || null,
    event_name: eventState?.eventName || null,
    event_date_utc: eventState?.eventDateUtc || null,
    status: eventState?.eventStatus || 'unknown',
    confidence: eventState?.confidence || 'invalid',
    consumer_allowed: decision.allowed,
    compatible_source_count: Number(eventState?.compatibleSourceCount) || 0,
    reasons: Array.from(new Set([...verificationReasons, ...decision.reasons])),
    last_verified_at: eventState?.lastVerifiedAt || null,
    verification_expires_at: eventState?.verificationExpiresAt || null,
  };
}

/**
 * Convierte metadata de stats a un bloque de salud sin exponer el path local.
 *
 * @returns {object} Estado de frescura de `ufc_stats.db`.
 * @sideEffects Ninguno.
 */
function summarizeStats(rawStatus, readError = null) {
  if (readError || !rawStatus || rawStatus.isAvailable !== true) {
    return {
      status: 'unavailable',
      reason: readError || 'stats_unavailable',
      last_success_at: null,
      generated_at: rawStatus?.generatedAt || null,
      age_hours: null,
      max_age_hours: Number(rawStatus?.maxAgeHours) || 36,
      fight_count: 0,
      upcoming_count: 0,
    };
  }
  const fresh = rawStatus.isFresh === true;
  return {
    status: fresh ? 'healthy' : 'degraded',
    reason: fresh ? null : 'stats_stale',
    last_success_at: rawStatus.generatedAt || null,
    generated_at: rawStatus.generatedAt || null,
    age_hours:
      rawStatus.ageHours === null || rawStatus.ageHours === undefined
        ? null
        : Number(rawStatus.ageHours),
    max_age_hours: Number(rawStatus.maxAgeHours) || 36,
    fight_count: Number(rawStatus.fightCount) || 0,
    upcoming_count: Number(rawStatus.upcomingCount) || 0,
  };
}

/**
 * Resume la última observación de Odds API usando sólo métricas permitidas.
 *
 * @returns {object} Estado seguro de Odds API.
 * @sideEffects Ninguno.
 */
function summarizeOdds(rawStatus, readError = null) {
  const enabled = rawStatus?.enabled === true;
  if (!enabled) {
    return {
      status: readError ? 'unavailable' : 'disabled',
      reason: readError || 'odds_api_not_configured',
      last_success_at: null,
      last_request_at: rawStatus?.createdAt || null,
      status_code: null,
      requests_remaining: null,
      requests_used: null,
      requests_last: null,
    };
  }

  const statusCode = Number(rawStatus?.statusCode);
  const observed = Number.isFinite(statusCode) && statusCode > 0;
  const success = observed && statusCode >= 200 && statusCode < 300;
  let reason = null;
  if (readError) reason = readError;
  else if (!observed) reason = 'odds_api_no_requests_observed';
  else if (statusCode === 401) reason = 'odds_api_unauthorized';
  else if (statusCode === 429) reason = 'odds_api_quota_exhausted';
  else if (!success) reason = 'odds_api_last_request_failed';

  return {
    status: readError ? 'unavailable' : success ? 'healthy' : observed ? 'degraded' : 'unknown',
    reason,
    last_success_at: rawStatus?.lastSuccessAt || (success ? rawStatus?.createdAt || null : null),
    last_request_at: rawStatus?.createdAt || null,
    status_code: observed ? statusCode : null,
    requests_remaining:
      rawStatus?.requestsRemaining === null || rawStatus?.requestsRemaining === undefined
        ? null
        : Number(rawStatus.requestsRemaining),
    requests_used:
      rawStatus?.requestsUsed === null || rawStatus?.requestsUsed === undefined
        ? null
        : Number(rawStatus.requestsUsed),
    requests_last:
      rawStatus?.requestsLast === null || rawStatus?.requestsLast === undefined
        ? null
        : Number(rawStatus.requestsLast),
  };
}

/**
 * Resume telemetría del cliente de billing sin URL, token, usuario ni payload.
 *
 * @returns {object} Estado seguro de billing.
 * @sideEffects Ninguno.
 */
function summarizeBilling(rawStatus, readError = null) {
  const enabled = rawStatus?.enabled === true;
  if (!enabled) {
    return {
      status: readError ? 'unavailable' : 'disabled',
      reason: readError || 'billing_not_configured',
      last_success_at: null,
      last_request_at: rawStatus?.lastRequestAt || null,
      last_status_code: null,
      last_latency_ms: null,
      last_trace_id: null,
    };
  }
  const observed = Boolean(rawStatus?.lastRequestAt);
  const success = rawStatus?.lastRequestOk === true;
  return {
    status: readError ? 'unavailable' : success ? 'healthy' : observed ? 'degraded' : 'unknown',
    reason:
      readError ||
      (success
        ? null
        : observed
          ? rawStatus?.lastErrorCode || 'billing_last_request_failed'
          : 'billing_no_requests_observed'),
    last_success_at: rawStatus?.lastSuccessAt || null,
    last_request_at: rawStatus?.lastRequestAt || null,
    last_status_code:
      rawStatus?.lastStatusCode === null || rawStatus?.lastStatusCode === undefined
        ? null
        : Number(rawStatus.lastStatusCode),
    last_latency_ms:
      rawStatus?.lastLatencyMs === null || rawStatus?.lastLatencyMs === undefined
        ? null
        : Number(rawStatus.lastLatencyMs),
    last_trace_id: rawStatus?.lastTraceId || null,
  };
}

/**
 * Resume el loop de backup/verificación sin exponer paths de archivos.
 *
 * @returns {object} Estado seguro de mantenimiento.
 * @sideEffects Ninguno.
 */
function summarizeMaintenance(rawStatus, readError = null) {
  const enabled = rawStatus?.enabled === true;
  const hasError = Boolean(rawStatus?.lastError);
  return {
    status: readError
      ? 'unavailable'
      : !enabled
        ? 'disabled'
        : hasError
          ? 'degraded'
          : rawStatus?.lastSuccessAt
            ? 'healthy'
            : 'unknown',
    reason:
      readError ||
      (!enabled
        ? 'maintenance_disabled'
        : hasError
          ? String(rawStatus.lastError)
          : rawStatus?.lastSuccessAt
            ? null
            : 'maintenance_waiting_first_success'),
    last_success_at: rawStatus?.lastSuccessAt || null,
    last_attempt_at: rawStatus?.lastAttemptAt || null,
    in_flight: rawStatus?.inFlight === true,
  };
}

/**
 * Crea el proveedor read-only de los seis bloques operativos UFC.
 *
 * @returns {Function} Función síncrona compatible con `healthProvider`.
 * @sideEffects Al invocarse lee snapshots mediante dependencias inyectadas.
 */
export function createUfcHealthStatusProvider({
  getEventWatchState,
  getStatsFreshness,
  getOddsApiStatus,
  getBillingStatus,
  getMaintenanceStatus,
  nowProvider = () => new Date(),
  processInfo = {},
} = {}) {
  const configuredPid = Number(processInfo.pid || process.pid);
  const defaultStartedAt = new Date(Date.now() - process.uptime() * 1000).toISOString();
  const startedAt = String(processInfo.startedAt || defaultStartedAt);

  return function getUfcHealthStatus() {
    const nowValue = nowProvider();
    const now = nowValue instanceof Date ? nowValue : new Date(nowValue);
    const nowMs = now.getTime();
    const startedAtMs = Date.parse(startedAt);
    const currentRead = readStatus(getEventWatchState, 'current_event');
    const nextRead = readStatus(getEventWatchState, 'next_event');
    const currentEvent = summarizeEventState(currentRead.value, 'current_event', now);
    const nextEvent = summarizeEventState(nextRead.value, 'next_event', now);
    if (currentRead.error) currentEvent.reasons.unshift(currentRead.error);
    if (nextRead.error) nextEvent.reasons.unshift(nextRead.error);
    const eventStates = [currentEvent, nextEvent];
    const hasAnyState = eventStates.some((item) => item.event_id);
    const hasUnsafeState = eventStates.some(
      (item) => item.event_id && item.consumer_allowed !== true
    );
    const hasSafeState = eventStates.some((item) => item.consumer_allowed === true);

    const statsRead = readStatus(getStatsFreshness);
    const oddsRead = readStatus(getOddsApiStatus);
    const billingRead = readStatus(getBillingStatus);
    const maintenanceRead = readStatus(getMaintenanceStatus);

    return {
      process: {
        status: 'running',
        pid: configuredPid,
        started_at: startedAt,
        uptime_seconds:
          Number.isFinite(nowMs) && Number.isFinite(startedAtMs)
            ? Math.max(0, Math.floor((nowMs - startedAtMs) / 1000))
            : null,
      },
      event_intel: {
        status: !hasAnyState
          ? 'unavailable'
          : hasUnsafeState
            ? 'degraded'
            : hasSafeState
              ? 'healthy'
              : 'unknown',
        reason: !hasAnyState
          ? 'event_state_missing'
          : hasUnsafeState
            ? 'event_state_unverified'
            : hasSafeState
              ? null
              : 'event_state_unknown',
        last_success_at: latestIso(
          eventStates
            .filter((item) => item.consumer_allowed)
            .map((item) => item.last_verified_at)
        ),
        current_event: currentEvent,
        next_event: nextEvent,
      },
      ufc_stats: summarizeStats(statsRead.value, statsRead.error),
      odds_api: summarizeOdds(oddsRead.value, oddsRead.error),
      billing: summarizeBilling(billingRead.value, billingRead.error),
      maintenance: summarizeMaintenance(maintenanceRead.value, maintenanceRead.error),
    };
  };
}

export default { createUfcHealthStatusProvider };
