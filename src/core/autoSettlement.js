import { evaluateEventConsumption, evaluateEventTruth } from './eventTruthGate.js';

function normalizeText(value = '') {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[’'`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitFightLabel(label = '') {
  const value = String(label || '').trim();
  if (!value) return null;
  const parts = value.split(/\s+(?:vs\.?|versus|v)\s+/i).map((part) => part.trim());
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return null;
  }
  return { fighterA: parts[0], fighterB: parts[1] };
}

function includesName(textNorm = '', fighter = '') {
  const fighterNorm = normalizeText(fighter);
  if (!fighterNorm) return false;
  if (textNorm.includes(fighterNorm)) return true;
  const surname = fighterNorm.split(' ').filter(Boolean).slice(-1)[0];
  if (surname && surname.length >= 4 && textNorm.split(/\W+/).includes(surname)) {
    return true;
  }
  return false;
}

function fightRowMatches(row = [], fight = null) {
  if (!fight?.fighterA || !fight?.fighterB) return false;
  const rowA = String(row[2] || '').trim();
  const rowB = String(row[3] || '').trim();
  if (!rowA || !rowB) return false;
  const direct = includesName(normalizeText(rowA), fight.fighterA) &&
    includesName(normalizeText(rowB), fight.fighterB);
  const reverse = includesName(normalizeText(rowA), fight.fighterB) &&
    includesName(normalizeText(rowB), fight.fighterA);
  return direct || reverse;
}

function detectSelectedFighter(pick = '', fight = null) {
  if (!fight?.fighterA || !fight?.fighterB) return null;
  const pickNorm = normalizeText(pick);
  const hasA = includesName(pickNorm, fight.fighterA);
  const hasB = includesName(pickNorm, fight.fighterB);
  if (hasA && !hasB) return fight.fighterA;
  if (hasB && !hasA) return fight.fighterB;
  return null;
}

function classifyPick(pick = '', fight = null) {
  const raw = String(pick || '').trim();
  if (!raw) return null;
  const norm = normalizeText(raw);

  if (norm.includes('+')) {
    return { type: 'unsupported' };
  }

  const overMatch = norm.match(/\b(over|mas de)\s*([0-9]+(?:[.,][0-9]+)?)\b/);
  if (overMatch) {
    return { type: 'total_over', line: Number(overMatch[2].replace(',', '.')) };
  }

  const underMatch = norm.match(/\b(under|menos de)\s*([0-9]+(?:[.,][0-9]+)?)\b/);
  if (underMatch) {
    return { type: 'total_under', line: Number(underMatch[2].replace(',', '.')) };
  }

  const selectedFighter = detectSelectedFighter(raw, fight);
  if (!selectedFighter) {
    return null;
  }

  if (/\bdecision|dec\w*\b/.test(norm)) {
    return { type: 'fighter_decision', fighter: selectedFighter };
  }

  if (/\b(ko|tko|ko\/tko|dq)\b/.test(norm)) {
    return { type: 'fighter_ko_tko_dq', fighter: selectedFighter };
  }

  if (/\b(sub|submission|sumision|sumisión)\b/.test(norm)) {
    return { type: 'fighter_submission', fighter: selectedFighter };
  }

  if (/\b(ganador|winner|moneyline|ml)\b/.test(norm)) {
    return { type: 'fighter_moneyline', fighter: selectedFighter };
  }

  // Default to fighter moneyline when the selected fighter is explicit.
  return { type: 'fighter_moneyline', fighter: selectedFighter };
}

function parseRoundValue(row = []) {
  const raw = String(row[7] || '').trim();
  const parsed = Number(raw.replace(',', '.'));
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  const fallbackFromMethod = normalizeText(row[6] || '');
  if (fallbackFromMethod.includes('decision')) {
    return 3;
  }
  return null;
}

function resolvePickResultAgainstRow(classification, row = [], fight = null) {
  if (!classification || !row) return null;

  const winner = String(row[5] || '').trim();
  const winnerNorm = normalizeText(winner);
  const methodNorm = normalizeText(row[6] || '');
  const roundValue = parseRoundValue(row);

  switch (classification.type) {
    case 'fighter_moneyline': {
      if (!winnerNorm) return null;
      const win = includesName(winnerNorm, classification.fighter);
      return win ? 'win' : 'loss';
    }
    case 'fighter_decision': {
      if (!winnerNorm || !methodNorm) return null;
      const winFighter = includesName(winnerNorm, classification.fighter);
      const byDecision = methodNorm.includes('decision');
      return winFighter && byDecision ? 'win' : 'loss';
    }
    case 'fighter_ko_tko_dq': {
      if (!winnerNorm || !methodNorm) return null;
      const winFighter = includesName(winnerNorm, classification.fighter);
      const byKo = methodNorm.includes('ko') || methodNorm.includes('tko') || methodNorm.includes('dq');
      return winFighter && byKo ? 'win' : 'loss';
    }
    case 'fighter_submission': {
      if (!winnerNorm || !methodNorm) return null;
      const winFighter = includesName(winnerNorm, classification.fighter);
      const bySub = methodNorm.includes('sub');
      return winFighter && bySub ? 'win' : 'loss';
    }
    case 'total_over': {
      if (!Number.isFinite(roundValue)) return null;
      return roundValue > classification.line ? 'win' : 'loss';
    }
    case 'total_under': {
      if (!Number.isFinite(roundValue)) return null;
      return roundValue <= classification.line ? 'win' : 'loss';
    }
    default:
      return null;
  }
}

function pickMostRecentRow(rows = []) {
  if (!rows.length) return null;
  return rows
    .slice()
    .sort((a, b) => {
      const aMs = Date.parse(String(a[0] || '')) || 0;
      const bMs = Date.parse(String(b[0] || '')) || 0;
      return bMs - aMs;
    })[0];
}

export function resolveAutoSettlementCandidate(bet = {}, historyRows = []) {
  const fight = splitFightLabel(bet.fight || '');
  if (!fight) return null;

  const matchingRows = (Array.isArray(historyRows) ? historyRows : []).filter((row) =>
    fightRowMatches(row, fight)
  );
  if (!matchingRows.length) return null;

  const chosenRow = pickMostRecentRow(matchingRows);
  if (!chosenRow) return null;

  const classification = classifyPick(bet.pick || '', fight);
  if (!classification || classification.type === 'unsupported') return null;

  const result = resolvePickResultAgainstRow(classification, chosenRow, fight);
  if (!result || (result !== 'win' && result !== 'loss')) return null;

  return {
    result,
    confidence: 'high',
    matchedRow: {
      date: chosenRow[0] || null,
      event: chosenRow[1] || null,
      fighterA: chosenRow[2] || null,
      fighterB: chosenRow[3] || null,
      winner: chosenRow[5] || null,
      method: chosenRow[6] || null,
      round: chosenRow[7] || null,
    },
    classification,
  };
}

/**
 * Verifica si el evento trackeado ya termino de verdad, cruzando su cartelera
 * contra resultados reales de ufc_stats.db (mismo matcher de nombre de
 * peleador que usa resolveAutoSettlementCandidate).
 *
 * @returns {{isComplete:boolean,matchedCount:number,totalCount:number,reason:string|null}} Veredicto de completitud.
 * @sideEffects Ninguno.
 */
export function verifyEventCompletionFromStats({
  eventState = null,
  historyRows = [],
  now = new Date(),
} = {}) {
  const mainCard = Array.isArray(eventState?.mainCard) ? eventState.mainCard : [];
  if (!mainCard.length) {
    return { isComplete: false, matchedCount: 0, totalCount: 0, reason: 'main_card_missing' };
  }

  const eventDateIso = String(eventState?.eventDateUtc || '').trim();
  const eventDateMs = eventDateIso ? Date.parse(`${eventDateIso}T00:00:00Z`) : NaN;
  if (!Number.isFinite(eventDateMs)) {
    return {
      isComplete: false,
      matchedCount: 0,
      totalCount: mainCard.length,
      reason: 'event_date_missing',
    };
  }

  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now));
  const todayMs = Date.parse(`${new Date(nowMs).toISOString().slice(0, 10)}T00:00:00Z`);
  if (!(eventDateMs < todayMs)) {
    return {
      isComplete: false,
      matchedCount: 0,
      totalCount: mainCard.length,
      reason: 'event_not_past',
    };
  }

  const rows = Array.isArray(historyRows) ? historyRows : [];
  let matchedCount = 0;
  for (const fight of mainCard) {
    const fighterA = String(fight?.fighterA || '').trim();
    const fighterB = String(fight?.fighterB || '').trim();
    if (!fighterA || !fighterB) continue;
    const hasResolvedRow = rows.some(
      (row) =>
        fightRowMatches(row, { fighterA, fighterB }) &&
        String(row[5] || '').trim() &&
        String(row[6] || '').trim()
    );
    if (hasResolvedRow) matchedCount += 1;
  }

  const totalCount = mainCard.length;
  const isComplete = matchedCount >= Math.ceil(totalCount / 2);
  return {
    isComplete,
    matchedCount,
    totalCount,
    reason: isComplete ? null : 'insufficient_resolved_fights',
  };
}

function buildNotificationText({ bet, settlement }) {
  const resultLabel = settlement.result === 'win' ? 'GANADA ✅' : 'PERDIDA ❌';
  const lines = [
    `Auto-cierre aplicado: bet_id ${bet.id} -> ${resultLabel}`,
  ];
  if (bet.eventName) {
    lines.push(`Evento: ${bet.eventName}`);
  }
  if (bet.fight) {
    lines.push(`Pelea: ${bet.fight}`);
  }
  if (bet.pick) {
    lines.push(`Pick: ${bet.pick}`);
  }
  if (settlement?.matchedRow?.winner || settlement?.matchedRow?.method) {
    lines.push(
      `Resultado fuente: ${settlement.matchedRow.winner || 'N/D'} (${settlement.matchedRow.method || 'metodo N/D'})`
    );
  }
  return lines.join('\n');
}

function buildUnresolvedNotificationText(bets = []) {
  const lines = [
    'No pude verificar automáticamente estas apuestas del evento que ya cerró:',
  ];
  for (const bet of bets) {
    lines.push(`- bet_id ${bet.id}: ${bet.fight || 'Pelea N/D'} | ${bet.pick || 'Pick N/D'}`);
  }
  lines.push(
    '',
    'Revisalas vos: mandame "bet_id <id> WON/LOST" o tocá "✅ Cerrar apuesta".'
  );
  return lines.join('\n');
}

/**
 * Verifica si el evento trackeado ya termino y, de ser asi, lo marca
 * completado + verificado en el watch-state antes de evaluar consumo — sin
 * esto, ledgerMutationAllowed queda permanentemente en false porque nada mas
 * produce esa verificacion.
 *
 * @returns {{eventState:object|null,newlyCompleted:boolean}} Estado vigente y si recien se marco.
 * @sideEffects Puede escribir un nuevo snapshot de current_event.
 */
function markEventCompletedIfVerified({
  eventState,
  rows,
  getEventWatchState,
  upsertEventWatchState,
  now,
}) {
  if (typeof upsertEventWatchState !== 'function' || !eventState?.eventId) {
    return { eventState, newlyCompleted: false };
  }
  if (eventState.eventStatus === 'completed' && eventState.ledgerMutationAllowed === true) {
    return { eventState, newlyCompleted: false };
  }

  const completion = verifyEventCompletionFromStats({ eventState, historyRows: rows, now });
  if (!completion.isComplete) {
    return { eventState, newlyCompleted: false };
  }

  const candidate = {
    watchKey: 'current_event',
    eventId: eventState.eventId,
    eventName: eventState.eventName,
    eventDateUtc: eventState.eventDateUtc,
    eventStatus: 'completed',
    sourcePrimary: 'ufc_stats_db',
    mainCard: eventState.mainCard,
    monitoredFighters: eventState.monitoredFighters,
  };
  const verifiedAtIso = (now instanceof Date ? now : new Date(now)).toISOString();
  const verification = evaluateEventTruth({
    watchKey: 'current_event',
    candidate,
    verification: {
      compatibleSourceCount: 1,
      structuredCardSource: true,
      completionVerified: true,
      statsVerified: true,
      verifiedAt: verifiedAtIso,
    },
    now,
  });
  upsertEventWatchState({ ...candidate, verification }, 'current_event');
  const refreshed =
    typeof getEventWatchState === 'function' ? getEventWatchState('current_event') : null;
  return { eventState: refreshed || eventState, newlyCompleted: true };
}

/**
 * Ejecuta un ciclo de auto-settlement. Antes de exigir evento completado y
 * stats verificadas, intenta producir esa verificacion cruzando la cartelera
 * trackeada contra resultados reales de ufc_stats.db.
 *
 * @returns {Promise<object>} Cantidad cerrada o bloqueo fail-closed con razones.
 * @sideEffects Puede marcar el evento completado, aplicar mutaciones de ledger y enviar notificaciones mediante dependencias.
 */
export async function runAutoSettlementCycle({
  getEventWatchState,
  upsertEventWatchState,
  getStatsFreshness,
  getFightHistoryRows,
  getFightHistoryCacheSnapshot,
  listPendingBetsForAutoSettlement,
  applyBetMutation,
  getLatestChatIdForUser,
  notify,
  now = new Date(),
  statsMaxAgeHours,
} = {}) {
  if (
    typeof getEventWatchState !== 'function' ||
    typeof listPendingBetsForAutoSettlement !== 'function' ||
    typeof applyBetMutation !== 'function'
  ) {
    return { ok: false, error: 'missing_dependencies' };
  }
  if (
    typeof getFightHistoryRows !== 'function' &&
    typeof getFightHistoryCacheSnapshot !== 'function'
  ) {
    return { ok: false, error: 'missing_history_source' };
  }

  const fetchRows = () => {
    if (typeof getFightHistoryRows === 'function') {
      return getFightHistoryRows() || [];
    }
    const cache = getFightHistoryCacheSnapshot('default');
    return Array.isArray(cache?.rows) ? cache.rows : [];
  };

  let eventState = getEventWatchState('current_event');
  let rows = null;
  let newlyCompleted = false;

  // Sólo tocamos ufc_stats.db acá si hace falta para intentar verificar
  // completitud — si el evento ya está completed+verified, o no hay forma de
  // escribir el resultado, nos comportamos como antes: ni leemos historia
  // hasta que el chequeo de stats frescas más abajo lo permita (fail-closed
  // no debe depender de datos que todavía no confirmamos que son confiables).
  const alreadyVerified =
    eventState?.eventStatus === 'completed' && eventState?.ledgerMutationAllowed === true;
  if (!alreadyVerified && typeof upsertEventWatchState === 'function' && eventState?.eventId) {
    rows = fetchRows();
    const marked = markEventCompletedIfVerified({
      eventState,
      rows,
      getEventWatchState,
      upsertEventWatchState,
      now,
    });
    eventState = marked.eventState;
    newlyCompleted = marked.newlyCompleted;
  }

  const statsFreshness =
    typeof getStatsFreshness === 'function' ? getStatsFreshness() : null;
  const consumption = evaluateEventConsumption({
    eventState,
    statsFreshness,
    requireStats: true,
    requireLedgerMutation: true,
    now,
    statsMaxAgeHours,
  });
  if (!consumption.allowed) {
    return {
      ok: false,
      blocked: true,
      error: 'settlement_sources_not_verified',
      reasons: consumption.reasons,
    };
  }

  if (rows === null) {
    rows = fetchRows();
  }
  if (!rows.length) {
    return { ok: true, settledCount: 0, reason: 'history_empty' };
  }

  const pendingBets = listPendingBetsForAutoSettlement({ limit: 300 });
  if (!pendingBets.length) {
    return { ok: true, settledCount: 0, reason: 'no_pending_bets' };
  }

  const completedEventFighters = new Set(
    (eventState?.monitoredFighters || []).map((name) => normalizeText(name))
  );
  const unresolvedForCompletedEvent = [];

  let settledCount = 0;
  for (const bet of pendingBets) {
    if (!bet?.telegramUserId || !bet?.id) continue;
    const settlement = resolveAutoSettlementCandidate(bet, rows);
    if (!settlement || settlement.confidence !== 'high') {
      if (newlyCompleted && completedEventFighters.size) {
        const fight = splitFightLabel(bet.fight || '');
        const mentionsCompletedEvent =
          fight &&
          (completedEventFighters.has(normalizeText(fight.fighterA)) ||
            completedEventFighters.has(normalizeText(fight.fighterB)));
        if (mentionsCompletedEvent) {
          unresolvedForCompletedEvent.push(bet);
        }
      }
      continue;
    }

    const applied = applyBetMutation(bet.telegramUserId, {
      operation: 'settle',
      result: settlement.result,
      betIds: [bet.id],
      confirm: true,
      metadata: {
        source: 'auto_verified',
        matchedRow: settlement.matchedRow,
        classification: settlement.classification,
      },
    });
    if (!applied?.ok || !Number(applied.affectedCount)) continue;

    settledCount += 1;
    if (typeof notify === 'function') {
      const chatId =
        typeof getLatestChatIdForUser === 'function'
          ? getLatestChatIdForUser(bet.telegramUserId)
          : null;
      if (chatId) {
        const text = buildNotificationText({ bet, settlement });
        try {
          await notify({ chatId, text, bet, settlement });
        } catch (notifyError) {
          console.error('⚠️ Auto-settlement notification failed:', notifyError);
        }
      }
    }
  }

  if (unresolvedForCompletedEvent.length && typeof notify === 'function') {
    const byUser = new Map();
    for (const bet of unresolvedForCompletedEvent) {
      const list = byUser.get(bet.telegramUserId) || [];
      list.push(bet);
      byUser.set(bet.telegramUserId, list);
    }
    for (const [telegramUserId, bets] of byUser.entries()) {
      const chatId =
        typeof getLatestChatIdForUser === 'function'
          ? getLatestChatIdForUser(telegramUserId)
          : null;
      if (!chatId) continue;
      try {
        await notify({ chatId, text: buildUnresolvedNotificationText(bets), bets });
      } catch (notifyError) {
        console.error('⚠️ Auto-settlement unresolved-review notification failed:', notifyError);
      }
    }
  }

  return { ok: true, settledCount, unresolvedCount: unresolvedForCompletedEvent.length };
}

export function startAutoSettlementMonitor({
  intervalMs = Number(process.env.AUTO_SETTLEMENT_INTERVAL_MS ?? '180000'),
  getEventWatchState,
  upsertEventWatchState,
  getStatsFreshness,
  getFightHistoryRows,
  getFightHistoryCacheSnapshot,
  listPendingBetsForAutoSettlement,
  applyBetMutation,
  getLatestChatIdForUser,
  notify,
} = {}) {
  if (
    typeof getEventWatchState !== 'function' ||
    typeof getStatsFreshness !== 'function' ||
    typeof listPendingBetsForAutoSettlement !== 'function' ||
    typeof applyBetMutation !== 'function'
  ) {
    return { stop: () => {} };
  }
  if (
    typeof getFightHistoryRows !== 'function' &&
    typeof getFightHistoryCacheSnapshot !== 'function'
  ) {
    return { stop: () => {} };
  }

  let inFlight = false;

  const run = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      const result = await runAutoSettlementCycle({
        getEventWatchState,
        upsertEventWatchState,
        getStatsFreshness,
        getFightHistoryRows,
        getFightHistoryCacheSnapshot,
        listPendingBetsForAutoSettlement,
        applyBetMutation,
        getLatestChatIdForUser,
        notify,
      });
      if (result?.ok && result.settledCount > 0) {
        console.log(`[autoSettlement] Settled ${result.settledCount} pending bet(s).`);
      }
    } catch (error) {
      console.error('❌ Auto-settlement monitor error:', error);
    } finally {
      inFlight = false;
    }
  };

  const timer = setInterval(() => {
    run().catch((error) => {
      console.error('❌ Auto-settlement monitor interval error:', error);
    });
  }, Math.max(15000, Number(intervalMs) || 180000));

  run().catch((error) => {
    console.error('❌ Auto-settlement monitor initial run error:', error);
  });

  return {
    stop() {
      clearInterval(timer);
    },
  };
}

export default {
  runAutoSettlementCycle,
  startAutoSettlementMonitor,
  resolveAutoSettlementCandidate,
};
