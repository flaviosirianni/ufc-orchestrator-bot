const DEFAULT_CLUSTER_WINDOW_HOURS = 12;

/**
 * Agrupa filas de `odds_events_index` (una por pelea) en la próxima cartelera, usando
 * la fecha de la pelea más temprana como ancla del evento y la más tardía como main event.
 *
 * @returns {object|null} Candidato estructurado o null si no hay filas utilizables.
 * @sideEffects Ninguno.
 */
export function resolveNextEventFromOddsRows(
  rows = [],
  { clusterWindowHours = DEFAULT_CLUSTER_WINDOW_HOURS } = {}
) {
  const usable = (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      fighterA: String(row?.homeTeam || '').trim(),
      fighterB: String(row?.awayTeam || '').trim(),
      commenceTimeMs: Date.parse(String(row?.commenceTime || '')),
    }))
    .filter(
      (row) => row.fighterA && row.fighterB && Number.isFinite(row.commenceTimeMs)
    )
    .sort((a, b) => a.commenceTimeMs - b.commenceTimeMs);

  if (!usable.length) return null;

  const anchorMs = usable[0].commenceTimeMs;
  const windowMs = Math.max(1, Number(clusterWindowHours) || DEFAULT_CLUSTER_WINDOW_HOURS) * 3_600_000;
  const cluster = usable.filter((row) => row.commenceTimeMs - anchorMs <= windowMs);

  const mainEvent = cluster[cluster.length - 1];
  const mainCard = cluster.map((fight, index) => ({
    fightId: `fight_${index + 1}`,
    fighterA: fight.fighterA,
    fighterB: fight.fighterB,
  }));

  return {
    eventName: `UFC: ${mainEvent.fighterA} vs ${mainEvent.fighterB}`,
    eventDateUtc: new Date(anchorMs).toISOString().slice(0, 10),
    mainCard,
    mainEventFighterA: mainEvent.fighterA,
    mainEventFighterB: mainEvent.fighterB,
    sourcePrimary: 'odds_api',
    structuredCardSource: true,
  };
}

export default {
  resolveNextEventFromOddsRows,
};
