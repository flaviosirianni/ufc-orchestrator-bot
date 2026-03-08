import '../core/env.js';

const BET_SCORING_REASONING_VERSION =
  process.env.BET_SCORING_REASONING_VERSION || 'v1_market_pack';

function normalizeText(value = '') {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function clamp(value, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return min;
  return Math.min(max, Math.max(min, parsed));
}

function extractSurname(name = '') {
  const parts = normalizeText(name)
    .split(/\s+/)
    .filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

function namesMatch(left = '', right = '') {
  const a = normalizeText(left);
  const b = normalizeText(right);
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;
  const aSurname = extractSurname(a);
  const bSurname = extractSurname(b);
  return Boolean(
    aSurname &&
      bSurname &&
      aSurname.length >= 4 &&
      bSurname.length >= 4 &&
      aSurname === bSurname
  );
}

function parseNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function extractLineFromLabel(label = '') {
  const match = String(label || '').match(/(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) : null;
}

function latestByBookmaker(rows = []) {
  const map = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const bookmaker = String(row?.bookmakerKey || row?.bookmakerTitle || '').trim();
    if (!bookmaker) continue;
    const key = `${bookmaker}::${String(row?.marketKey || '').trim()}`;
    const rowTs = Date.parse(String(row?.fetchedAt || row?.sourceLastUpdate || '')) || 0;
    const current = map.get(key);
    const currentTs = current
      ? Date.parse(String(current?.fetchedAt || current?.sourceLastUpdate || '')) || 0
      : -1;
    if (!current || rowTs >= currentTs) {
      map.set(key, row);
    }
  }
  return Array.from(map.values());
}

function getOutcomePrice(row = {}, targetName = '') {
  const options = [
    { name: row?.outcomeAName || row?.homeTeam || '', price: parseNumber(row?.outcomeAPrice) },
    { name: row?.outcomeBName || row?.awayTeam || '', price: parseNumber(row?.outcomeBPrice) },
  ];
  const found = options.find(
    (item) =>
      item.price !== null && item.price > 1 && namesMatch(item.name || '', String(targetName || ''))
  );
  return found ? found.price : null;
}

function getOppositePrice(row = {}, selectedName = '', fallbackName = '') {
  const options = [
    { name: row?.outcomeAName || row?.homeTeam || '', price: parseNumber(row?.outcomeAPrice) },
    { name: row?.outcomeBName || row?.awayTeam || '', price: parseNumber(row?.outcomeBPrice) },
  ];
  const selected = options.find(
    (item) =>
      item.price !== null && item.price > 1 && namesMatch(item.name || '', String(selectedName || ''))
  );
  if (!selected) return null;
  const opposite = options.find(
    (item) =>
      item !== selected &&
      item.price !== null &&
      item.price > 1 &&
      (!fallbackName || namesMatch(item.name || '', String(fallbackName || '')))
  );
  return opposite ? opposite.price : null;
}

function average(values = []) {
  const valid = (Array.isArray(values) ? values : []).filter(
    (value) => Number.isFinite(Number(value)) && Number(value) > 0
  );
  if (!valid.length) return null;
  return valid.reduce((sum, value) => sum + Number(value), 0) / valid.length;
}

function deriveRiskLevel({ recommendation = 'no_bet', confidencePct = 0, edgePct = 0, books = 0 } = {}) {
  if (recommendation === 'no_bet') return 'high';
  if (books < 2 || confidencePct < 58) return 'high';
  if (edgePct < 3 || confidencePct < 66) return 'medium';
  return 'low';
}

function formatOdds(odds) {
  return Number.isFinite(Number(odds)) ? Number(Number(odds).toFixed(3)) : null;
}

function createBaseSnapshot({
  eventId = '',
  fight = {},
  marketKey = '',
  reasoningVersion = BET_SCORING_REASONING_VERSION,
} = {}) {
  return {
    eventId: String(eventId || '').trim(),
    fightId: String(fight?.fightId || '').trim(),
    fighterA: String(fight?.fighterA || '').trim(),
    fighterB: String(fight?.fighterB || '').trim(),
    marketKey: String(marketKey || '').trim(),
    selection: null,
    recommendation: 'no_bet',
    edgePct: 0,
    confidencePct: 0,
    riskLevel: 'high',
    suggestedStakeUnits: null,
    suggestedStakeAmount: null,
    noBetReason: null,
    modelProbabilityPct: null,
    impliedProbabilityPct: null,
    consensusOdds: null,
    booksCount: 0,
    inputs: {},
    reasoningVersion,
  };
}

function scoreMoneyline({
  eventId = '',
  fight = {},
  projection = {},
  oddsRows = [],
  reasoningVersion = BET_SCORING_REASONING_VERSION,
} = {}) {
  const base = createBaseSnapshot({
    eventId,
    fight,
    marketKey: 'moneyline',
    reasoningVersion,
  });

  const winner = String(projection?.predictedWinner || '').trim();
  const fighterA = String(fight?.fighterA || '').trim();
  const fighterB = String(fight?.fighterB || '').trim();
  if (!winner || !fighterA || !fighterB) {
    return {
      ...base,
      noBetReason: 'projection_missing',
      confidencePct: 45,
    };
  }

  const modelProbability = namesMatch(winner, fighterA)
    ? parseNumber(projection?.fighterAWinPct)
    : parseNumber(projection?.fighterBWinPct);
  const modelProb = modelProbability !== null ? clamp(modelProbability, 5, 95) : 50;

  const h2hRows = latestByBookmaker(
    (Array.isArray(oddsRows) ? oddsRows : []).filter(
      (row) => String(row?.marketKey || '').trim().toLowerCase() === 'h2h'
    )
  );
  const selPrices = [];
  const oppPrices = [];
  const loser = namesMatch(winner, fighterA) ? fighterB : fighterA;

  for (const row of h2hRows) {
    const selected = getOutcomePrice(row, winner);
    const opposite = getOppositePrice(row, winner, loser);
    if (!selected || !opposite) continue;
    selPrices.push(selected);
    oppPrices.push(opposite);
  }

  if (!selPrices.length || !oppPrices.length) {
    return {
      ...base,
      selection: winner,
      recommendation: 'no_bet',
      confidencePct: clamp(Number(projection?.confidencePct || 54) - 7, 42, 88),
      noBetReason: 'market_odds_unavailable',
      modelProbabilityPct: Number(modelProb.toFixed(2)),
      inputs: {
        projectionConfidencePct: projection?.confidencePct || null,
      },
    };
  }

  const avgSelectionOdds = average(selPrices);
  const avgOppositeOdds = average(oppPrices);
  const impliedSelection = avgSelectionOdds && avgOppositeOdds
    ? ((1 / avgSelectionOdds) / ((1 / avgSelectionOdds) + 1 / avgOppositeOdds)) * 100
    : null;
  const edge = impliedSelection === null ? 0 : modelProb - impliedSelection;
  const books = Math.min(selPrices.length, oppPrices.length);
  const confidence = clamp(
    Number(projection?.confidencePct || 55) + Math.min(Math.abs(edge), 10) * 0.7 - (books < 3 ? 4 : 0),
    45,
    92
  );

  let recommendation = 'no_bet';
  let noBetReason = 'insufficient_edge';
  if (edge >= 4 && confidence >= 60) {
    recommendation = 'bet';
    noBetReason = null;
  } else if (edge >= 1.5 && confidence >= 56) {
    recommendation = 'lean';
    noBetReason = null;
  }

  let suggestedStakeUnits = null;
  if (recommendation === 'bet') {
    suggestedStakeUnits = clamp(1 + edge * 0.18 + (confidence - 58) * 0.05, 1, 4.5);
  } else if (recommendation === 'lean') {
    suggestedStakeUnits = clamp(0.75 + edge * 0.1, 0.75, 2);
  }

  return {
    ...base,
    selection: winner,
    recommendation,
    edgePct: Number(edge.toFixed(2)),
    confidencePct: Number(confidence.toFixed(1)),
    riskLevel: deriveRiskLevel({
      recommendation,
      confidencePct: confidence,
      edgePct: edge,
      books,
    }),
    suggestedStakeUnits:
      suggestedStakeUnits === null ? null : Number(suggestedStakeUnits.toFixed(2)),
    noBetReason,
    modelProbabilityPct: Number(modelProb.toFixed(2)),
    impliedProbabilityPct:
      impliedSelection === null ? null : Number(impliedSelection.toFixed(2)),
    consensusOdds: formatOdds(avgSelectionOdds),
    booksCount: books,
    inputs: {
      projectionConfidencePct: projection?.confidencePct || null,
      projectedWinner: winner,
      averageOppositeOdds: formatOdds(avgOppositeOdds),
    },
  };
}

function extractMethodOutcomeCandidates(row = {}, winnerName = '', predictedMethod = '') {
  const payloadOutcomes = Array.isArray(row?.payload?.market?.outcomes)
    ? row.payload.market.outcomes
    : [];
  const fallbackOutcomes = [
    { name: row?.outcomeAName || '', price: parseNumber(row?.outcomeAPrice) },
    { name: row?.outcomeBName || '', price: parseNumber(row?.outcomeBPrice) },
  ];
  const outcomes = payloadOutcomes.length ? payloadOutcomes : fallbackOutcomes;

  const winnerSurname = extractSurname(winnerName);
  const methodHint = String(predictedMethod || '').trim().toLowerCase();
  const wantsDecision = methodHint.includes('decision');
  const wantsInside = methodHint.includes('inside') || methodHint.includes('distance');

  return outcomes
    .map((item) => ({
      name: String(item?.name || '').trim(),
      price: parseNumber(item?.price),
    }))
    .filter((item) => item.name && item.price !== null && item.price > 1)
    .filter((item) => {
      const text = normalizeText(item.name);
      if (!winnerSurname || !text.includes(winnerSurname)) {
        return false;
      }
      if (wantsDecision) {
        return text.includes('decision');
      }
      if (wantsInside) {
        return (
          text.includes('ko') ||
          text.includes('tko') ||
          text.includes('sub') ||
          text.includes('inside') ||
          text.includes('distance')
        );
      }
      return true;
    });
}

function scoreMethod({
  eventId = '',
  fight = {},
  projection = {},
  oddsRows = [],
  reasoningVersion = BET_SCORING_REASONING_VERSION,
} = {}) {
  const base = createBaseSnapshot({
    eventId,
    fight,
    marketKey: 'method',
    reasoningVersion,
  });

  const winner = String(projection?.predictedWinner || '').trim();
  const predictedMethod = String(projection?.predictedMethod || '').trim();
  if (!winner) {
    return {
      ...base,
      confidencePct: 44,
      noBetReason: 'projection_missing',
    };
  }

  const methodRows = latestByBookmaker(
    (Array.isArray(oddsRows) ? oddsRows : []).filter((row) => {
      const key = String(row?.marketKey || '').trim().toLowerCase();
      return key.includes('method') || key.includes('outcome');
    })
  );

  if (!methodRows.length) {
    return {
      ...base,
      selection: `${winner} por metodo`,
      confidencePct: clamp(Number(projection?.confidencePct || 53) - 10, 40, 80),
      noBetReason: 'market_odds_unavailable',
      modelProbabilityPct: predictedMethod.includes('decision') ? 52 : 56,
      inputs: {
        projectedMethod: predictedMethod || null,
      },
    };
  }

  const candidatePrices = [];
  let selectedLabel = null;
  for (const row of methodRows) {
    const matches = extractMethodOutcomeCandidates(row, winner, predictedMethod);
    if (!matches.length) continue;
    const choice = matches[0];
    if (!selectedLabel) {
      selectedLabel = choice.name;
    }
    candidatePrices.push(choice.price);
  }

  if (!candidatePrices.length) {
    return {
      ...base,
      selection: `${winner} por metodo`,
      confidencePct: clamp(Number(projection?.confidencePct || 53) - 8, 40, 82),
      noBetReason: 'selection_odds_unavailable',
      modelProbabilityPct: predictedMethod.includes('decision') ? 52 : 56,
      inputs: {
        projectedMethod: predictedMethod || null,
      },
    };
  }

  const avgOdds = average(candidatePrices);
  const implied = avgOdds ? (1 / avgOdds) * 100 : null;
  const modelProb = predictedMethod.includes('decision') ? 52 : 56;
  const edge = implied === null ? 0 : modelProb - implied;
  const confidence = clamp(
    Number(projection?.confidencePct || 54) - 4 + Math.min(Math.abs(edge), 10) * 0.6,
    42,
    88
  );

  let recommendation = 'no_bet';
  let noBetReason = 'insufficient_edge';
  if (edge >= 6 && confidence >= 62) {
    recommendation = 'bet';
    noBetReason = null;
  } else if (edge >= 2 && confidence >= 56) {
    recommendation = 'lean';
    noBetReason = null;
  }

  const suggestedStakeUnits =
    recommendation === 'bet'
      ? clamp(0.9 + edge * 0.1, 0.75, 2.5)
      : recommendation === 'lean'
      ? clamp(0.6 + edge * 0.05, 0.5, 1.5)
      : null;

  return {
    ...base,
    selection: selectedLabel || `${winner} por metodo`,
    recommendation,
    edgePct: Number(edge.toFixed(2)),
    confidencePct: Number(confidence.toFixed(1)),
    riskLevel: deriveRiskLevel({
      recommendation,
      confidencePct: confidence,
      edgePct: edge,
      books: candidatePrices.length,
    }),
    suggestedStakeUnits:
      suggestedStakeUnits === null ? null : Number(suggestedStakeUnits.toFixed(2)),
    noBetReason,
    modelProbabilityPct: Number(modelProb.toFixed(2)),
    impliedProbabilityPct: implied === null ? null : Number(implied.toFixed(2)),
    consensusOdds: formatOdds(avgOdds),
    booksCount: candidatePrices.length,
    inputs: {
      projectedMethod: predictedMethod || null,
    },
  };
}

function scoreTotalRounds({
  eventId = '',
  fight = {},
  projection = {},
  oddsRows = [],
  reasoningVersion = BET_SCORING_REASONING_VERSION,
} = {}) {
  const base = createBaseSnapshot({
    eventId,
    fight,
    marketKey: 'total_rounds',
    reasoningVersion,
  });

  const projectedMethod = String(projection?.predictedMethod || '').trim().toLowerCase();
  const confidence = Number(projection?.confidencePct || 54);
  const preferredSide =
    projectedMethod.includes('inside') || projectedMethod.includes('distance')
      ? 'under'
      : 'over';

  const totalsRows = latestByBookmaker(
    (Array.isArray(oddsRows) ? oddsRows : []).filter((row) => {
      const key = String(row?.marketKey || '').trim().toLowerCase();
      return key.includes('total');
    })
  );

  if (!totalsRows.length) {
    return {
      ...base,
      selection: preferredSide === 'under' ? 'Under rounds' : 'Over rounds',
      confidencePct: clamp(confidence - 8, 42, 86),
      noBetReason: 'market_odds_unavailable',
      modelProbabilityPct: preferredSide === 'under' ? 56 : 54,
    };
  }

  const chosenPrices = [];
  const oppositePrices = [];
  const lines = [];
  for (const row of totalsRows) {
    const outcomeA = String(row?.outcomeAName || '');
    const outcomeB = String(row?.outcomeBName || '');
    const priceA = parseNumber(row?.outcomeAPrice);
    const priceB = parseNumber(row?.outcomeBPrice);
    if (!priceA || !priceB || priceA <= 1 || priceB <= 1) continue;
    const textA = normalizeText(outcomeA);
    const textB = normalizeText(outcomeB);

    const aIsPreferred = textA.includes(preferredSide);
    const bIsPreferred = textB.includes(preferredSide);
    if (!aIsPreferred && !bIsPreferred) continue;

    if (aIsPreferred) {
      chosenPrices.push(priceA);
      oppositePrices.push(priceB);
      lines.push(extractLineFromLabel(outcomeA));
    } else {
      chosenPrices.push(priceB);
      oppositePrices.push(priceA);
      lines.push(extractLineFromLabel(outcomeB));
    }
  }

  if (!chosenPrices.length || !oppositePrices.length) {
    return {
      ...base,
      selection: preferredSide === 'under' ? 'Under rounds' : 'Over rounds',
      confidencePct: clamp(confidence - 6, 42, 86),
      noBetReason: 'selection_odds_unavailable',
      modelProbabilityPct: preferredSide === 'under' ? 56 : 54,
    };
  }

  const avgSelected = average(chosenPrices);
  const avgOpposite = average(oppositePrices);
  const implied = avgSelected && avgOpposite
    ? ((1 / avgSelected) / ((1 / avgSelected) + 1 / avgOpposite)) * 100
    : null;
  const modelProb = preferredSide === 'under'
    ? clamp(54 + (confidence - 55) * 0.2, 52, 61)
    : clamp(53 + (confidence - 55) * 0.15, 51, 59);
  const edge = implied === null ? 0 : modelProb - implied;
  const finalConfidence = clamp(confidence - 2 + Math.min(Math.abs(edge), 8) * 0.6, 43, 89);

  let recommendation = 'no_bet';
  let noBetReason = 'insufficient_edge';
  if (edge >= 4 && finalConfidence >= 60) {
    recommendation = 'bet';
    noBetReason = null;
  } else if (edge >= 1.5 && finalConfidence >= 55) {
    recommendation = 'lean';
    noBetReason = null;
  }

  const bestLine = average(lines.filter((line) => Number.isFinite(Number(line))));
  const lineLabel = bestLine ? `${bestLine.toFixed(1)}`.replace(/\.0$/, '') : 'x.x';
  const selection = `${preferredSide === 'under' ? 'Under' : 'Over'} ${lineLabel} rounds`;
  const suggestedStakeUnits =
    recommendation === 'bet'
      ? clamp(0.85 + edge * 0.12, 0.75, 2.8)
      : recommendation === 'lean'
      ? clamp(0.6 + edge * 0.06, 0.5, 1.6)
      : null;

  return {
    ...base,
    selection,
    recommendation,
    edgePct: Number(edge.toFixed(2)),
    confidencePct: Number(finalConfidence.toFixed(1)),
    riskLevel: deriveRiskLevel({
      recommendation,
      confidencePct: finalConfidence,
      edgePct: edge,
      books: chosenPrices.length,
    }),
    suggestedStakeUnits:
      suggestedStakeUnits === null ? null : Number(suggestedStakeUnits.toFixed(2)),
    noBetReason,
    modelProbabilityPct: Number(modelProb.toFixed(2)),
    impliedProbabilityPct: implied === null ? null : Number(implied.toFixed(2)),
    consensusOdds: formatOdds(avgSelected),
    booksCount: chosenPrices.length,
    inputs: {
      side: preferredSide,
      projectedMethod: projection?.predictedMethod || null,
      selectedLine: bestLine || null,
    },
  };
}

export function buildFightBetScoringPack({
  eventId = '',
  fight = {},
  projection = {},
  oddsRows = [],
  reasoningVersion = BET_SCORING_REASONING_VERSION,
} = {}) {
  const fighterA = String(fight?.fighterA || '').trim();
  const fighterB = String(fight?.fighterB || '').trim();
  const fightId = String(fight?.fightId || '').trim();
  const cleanEventId = String(eventId || '').trim();
  if (!cleanEventId || !fightId || !fighterA || !fighterB) {
    return [];
  }

  const sharedFight = {
    fightId,
    fighterA,
    fighterB,
  };

  return [
    scoreMoneyline({
      eventId: cleanEventId,
      fight: sharedFight,
      projection,
      oddsRows,
      reasoningVersion,
    }),
    scoreMethod({
      eventId: cleanEventId,
      fight: sharedFight,
      projection,
      oddsRows,
      reasoningVersion,
    }),
    scoreTotalRounds({
      eventId: cleanEventId,
      fight: sharedFight,
      projection,
      oddsRows,
      reasoningVersion,
    }),
  ].map((row) => ({
    ...row,
    eventId: cleanEventId,
    fightId,
    fighterA,
    fighterB,
    reasoningVersion,
  }));
}

export { BET_SCORING_REASONING_VERSION };

export default {
  buildFightBetScoringPack,
  BET_SCORING_REASONING_VERSION,
};
