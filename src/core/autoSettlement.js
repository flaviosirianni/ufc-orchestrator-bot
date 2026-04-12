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

export function startAutoSettlementMonitor({
  intervalMs = Number(process.env.AUTO_SETTLEMENT_INTERVAL_MS ?? '180000'),
  getFightHistoryRows,
  getFightHistoryCacheSnapshot,
  listPendingBetsForAutoSettlement,
  applyBetMutation,
  getLatestChatIdForUser,
  notify,
} = {}) {
  if (
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
      let rows = [];
      if (typeof getFightHistoryRows === 'function') {
        rows = getFightHistoryRows() || [];
      } else {
        const cache = getFightHistoryCacheSnapshot('default');
        rows = Array.isArray(cache?.rows) ? cache.rows : [];
      }
      if (!rows.length) {
        return;
      }

      const pendingBets = listPendingBetsForAutoSettlement({ limit: 300 });
      if (!pendingBets.length) {
        return;
      }

      let settledCount = 0;
      for (const bet of pendingBets) {
        if (!bet?.telegramUserId || !bet?.id) continue;
        const settlement = resolveAutoSettlementCandidate(bet, rows);
        if (!settlement || settlement.confidence !== 'high') {
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

        if (!applied?.ok || !Number(applied.affectedCount)) {
          continue;
        }

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

      if (settledCount > 0) {
        console.log(`[autoSettlement] Settled ${settledCount} pending bet(s).`);
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
  startAutoSettlementMonitor,
  resolveAutoSettlementCandidate,
};
