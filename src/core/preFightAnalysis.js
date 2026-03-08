import '../core/env.js';

const PRE_FIGHT_ANALYSIS_INTERVAL_MS = Number(
  process.env.PRE_FIGHT_ANALYSIS_INTERVAL_MS ?? String(3 * 60 * 60 * 1000)
);
const PRE_FIGHT_ANALYSIS_REASONING_VERSION =
  process.env.PRE_FIGHT_ANALYSIS_REASONING_VERSION || 'v1_news_odds';
const PRE_FIGHT_ANALYSIS_CHANGE_THRESHOLD = Number(
  process.env.PRE_FIGHT_ANALYSIS_CHANGE_THRESHOLD ?? '6'
);

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

function toFighterSlug(name = '') {
  return normalizeText(name)
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function mentionFighter(item = {}, fighterName = '') {
  const target = normalizeText(fighterName);
  if (!target) return false;
  const slug = normalizeText(item?.fighterSlug || '');
  if (slug && slug === toFighterSlug(fighterName)) return true;
  const text = normalizeText([item?.fighterName, item?.title, item?.summary].filter(Boolean).join(' '));
  if (!text) return false;
  if (text.includes(target)) return true;
  const surname = target.split(/\s+/).filter(Boolean).slice(-1)[0] || '';
  if (surname.length >= 4 && text.includes(surname)) return true;
  return false;
}

function directionFromTitle(title = '') {
  const text = normalizeText(title);
  if (!text) return 0;
  if (
    /\b(injury|injured|out of|out for|withdraw|withdrawn|replacement|replaced|miss weight|weight miss|hospital|suspend|cancel|cancelled|failed weigh|medical issue|visa issue)\b/.test(
      text
    )
  ) {
    return -1;
  }
  if (/\b(cleared|healthy|ready|great camp|on weight|fully fit|looks sharp)\b/.test(text)) {
    return 1;
  }
  return 0;
}

function impactWeight(level = 'medium') {
  const raw = normalizeText(level);
  if (raw === 'high') return 10;
  if (raw === 'low') return 3;
  return 6;
}

function extractLatestByBookmaker(rows = []) {
  const latest = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = String(row?.bookmakerKey || row?.bookmakerTitle || '').trim();
    if (!key) continue;
    const rowTs = Date.parse(String(row?.fetchedAt || row?.sourceLastUpdate || '')) || 0;
    const current = latest.get(key);
    const currentTs = current
      ? Date.parse(String(current?.fetchedAt || current?.sourceLastUpdate || '')) || 0
      : -1;
    if (!current || rowTs >= currentTs) {
      latest.set(key, row);
    }
  }
  return Array.from(latest.values());
}

function pickFighterPrice(row = {}, fighterName = '') {
  const target = normalizeText(fighterName);
  if (!target) return null;
  const options = [
    { name: row?.outcomeAName || row?.homeTeam || '', price: Number(row?.outcomeAPrice) },
    { name: row?.outcomeBName || row?.awayTeam || '', price: Number(row?.outcomeBPrice) },
  ];
  const direct = options.find(
    (item) =>
      normalizeText(item.name) === target &&
      Number.isFinite(item.price) &&
      item.price > 1
  );
  if (direct) return direct.price;
  const surname = target.split(/\s+/).filter(Boolean).slice(-1)[0] || '';
  if (surname.length >= 4) {
    const bySurname = options.find(
      (item) =>
        normalizeText(item.name).includes(surname) &&
        Number.isFinite(item.price) &&
        item.price > 1
    );
    if (bySurname) return bySurname.price;
  }
  return null;
}

function buildOddsSignal({
  oddsRows = [],
  fighterA = '',
  fighterB = '',
} = {}) {
  const latestRows = extractLatestByBookmaker(oddsRows);
  if (!latestRows.length) {
    return null;
  }

  let totalA = 0;
  let totalB = 0;
  let count = 0;
  for (const row of latestRows) {
    const priceA = pickFighterPrice(row, fighterA);
    const priceB = pickFighterPrice(row, fighterB);
    if (!priceA || !priceB) continue;
    totalA += priceA;
    totalB += priceB;
    count += 1;
  }
  if (!count) {
    return null;
  }

  const avgA = totalA / count;
  const avgB = totalB / count;
  const impliedA = 1 / avgA;
  const impliedB = 1 / avgB;
  const normalizer = impliedA + impliedB;
  if (normalizer <= 0) {
    return null;
  }
  const probA = (impliedA / normalizer) * 100;
  const probB = (impliedB / normalizer) * 100;

  return {
    books: count,
    avgA,
    avgB,
    probA,
    probB,
  };
}

function computeProjection({
  eventId = '',
  fight = {},
  oddsRows = [],
  newsRows = [],
  previous = null,
} = {}) {
  const fighterA = String(fight?.fighterA || '').trim();
  const fighterB = String(fight?.fighterB || '').trim();
  const fightId = String(fight?.fightId || '').trim();
  if (!fighterA || !fighterB || !fightId) return null;

  const oddsSignal = buildOddsSignal({
    oddsRows,
    fighterA,
    fighterB,
  });

  let probA = oddsSignal ? oddsSignal.probA : 50;
  let probB = oddsSignal ? oddsSignal.probB : 50;
  const factors = [];
  if (oddsSignal) {
    factors.push(
      `Consenso cuotas (${oddsSignal.books} casas): ${fighterA} @${oddsSignal.avgA.toFixed(
        2
      )} vs ${fighterB} @${oddsSignal.avgB.toFixed(2)}`
    );
  } else {
    factors.push('Sin consenso de cuotas reciente, base neutral.');
  }

  const relevantNews = [];
  for (const item of Array.isArray(newsRows) ? newsRows : []) {
    const hitsA = mentionFighter(item, fighterA);
    const hitsB = mentionFighter(item, fighterB);
    if (!hitsA && !hitsB) continue;

    const direction = directionFromTitle(item?.title || '');
    const confidenceFactor = clamp(Number(item?.confidenceScore || 0), 40, 100) / 100;
    const delta = impactWeight(item?.impactLevel) * confidenceFactor * 0.8;

    if (direction < 0) {
      if (hitsA && !hitsB) {
        probA -= delta;
        probB += delta;
      } else if (hitsB && !hitsA) {
        probB -= delta;
        probA += delta;
      }
    } else if (direction > 0) {
      if (hitsA && !hitsB) {
        probA += delta * 0.5;
        probB -= delta * 0.5;
      } else if (hitsB && !hitsA) {
        probB += delta * 0.5;
        probA -= delta * 0.5;
      }
    }

    relevantNews.push(item);
  }

  probA = clamp(probA, 5, 95);
  probB = clamp(100 - probA, 5, 95);

  const winner = probA >= probB ? fighterA : fighterB;
  const spread = Math.abs(probA - probB);
  const confidence = clamp(
    52 + spread * 0.9 + (oddsSignal ? 4 : 0) + Math.min(relevantNews.length, 3) * 2,
    52,
    90
  );

  if (relevantNews.length) {
    for (const item of relevantNews.slice(0, 2)) {
      factors.push(`Señal news (${item.impactLevel || 'medium'}): ${item.title}`);
    }
  } else {
    factors.push('Sin señales de noticias de impacto para esta pelea.');
  }

  let changedFromPrev = false;
  let changeSummary = null;
  if (previous) {
    const prevWinner = String(previous.predictedWinner || '').trim();
    const prevConfidence = Number(previous.confidencePct || 0);
    const confidenceDelta = Math.abs(prevConfidence - confidence);
    if (prevWinner && prevWinner !== winner) {
      changedFromPrev = true;
      changeSummary = `Cambio de ganador proyectado: ${prevWinner} -> ${winner}.`;
    } else if (confidenceDelta >= PRE_FIGHT_ANALYSIS_CHANGE_THRESHOLD) {
      changedFromPrev = true;
      changeSummary = `Cambio material de confianza: ${prevConfidence.toFixed(0)}% -> ${confidence.toFixed(
        0
      )}%.`;
    }
  }

  return {
    eventId,
    fightId,
    fighterA,
    fighterB,
    predictedWinner: winner,
    predictedMethod: spread >= 20 ? 'inside_distance_or_clear_decision' : 'decision_lean',
    confidencePct: Number(confidence.toFixed(1)),
    keyFactors: factors.slice(0, 5),
    relevantNewsIds: relevantNews
      .map((item) => Number(item?.id))
      .filter((id) => Number.isInteger(id) && id > 0)
      .slice(0, 4),
    reasoningVersion: PRE_FIGHT_ANALYSIS_REASONING_VERSION,
    changedFromPrev,
    changeSummary,
  };
}

export function startPreFightAnalysisMonitor({
  getEventWatchState,
  listLatestRelevantNews,
  listLatestOddsMarketsForFight,
  getLatestProjectionForFight,
  insertFightProjectionSnapshots,
} = {}) {
  if (
    typeof getEventWatchState !== 'function' ||
    typeof listLatestRelevantNews !== 'function' ||
    typeof listLatestOddsMarketsForFight !== 'function' ||
    typeof getLatestProjectionForFight !== 'function' ||
    typeof insertFightProjectionSnapshots !== 'function'
  ) {
    return { stop() {} };
  }

  let inFlight = false;

  const runCycle = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      const eventState = getEventWatchState('next_event');
      if (!eventState?.eventId || !Array.isArray(eventState?.mainCard)) return;

      const fights = eventState.mainCard
        .map((fight, idx) => ({
          fightId: fight?.fightId || `fight_${idx + 1}`,
          fighterA: fight?.fighterA,
          fighterB: fight?.fighterB,
        }))
        .filter((fight) => fight.fightId && fight.fighterA && fight.fighterB);
      if (!fights.length) return;

      const newsRows = listLatestRelevantNews({
        eventId: eventState.eventId,
        limit: 180,
        minImpact: 'low',
      });

      const snapshots = [];
      for (const fight of fights) {
        const oddsRows = listLatestOddsMarketsForFight({
          fighterA: fight.fighterA,
          fighterB: fight.fighterB,
          marketKey: 'h2h',
          limit: 60,
          maxAgeHours: 96,
        });
        const previous = getLatestProjectionForFight({
          eventId: eventState.eventId,
          fightId: fight.fightId,
        });
        const snapshot = computeProjection({
          eventId: eventState.eventId,
          fight,
          oddsRows,
          newsRows,
          previous,
        });
        if (snapshot) snapshots.push(snapshot);
      }

      if (!snapshots.length) return;
      const inserted = insertFightProjectionSnapshots(snapshots);
      console.log(
        `[preFightAnalysis] Stored ${inserted?.insertedCount || 0} projection snapshot(s) for ${eventState.eventName}.`
      );
    } catch (error) {
      console.error('❌ preFightAnalysis cycle failed:', error);
    } finally {
      inFlight = false;
    }
  };

  const timer = setInterval(() => {
    runCycle().catch((error) => {
      console.error('❌ preFightAnalysis interval failed:', error);
    });
  }, Math.max(20_000, PRE_FIGHT_ANALYSIS_INTERVAL_MS));

  runCycle().catch((error) => {
    console.error('❌ preFightAnalysis initial run failed:', error);
  });

  return {
    stop() {
      clearInterval(timer);
    },
  };
}

export default {
  startPreFightAnalysisMonitor,
};
